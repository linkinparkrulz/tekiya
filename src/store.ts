import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ISSUANCE_LIMIT, RECEIVER_LOOKAHEAD, Unavailable, requireCondition,
} from "./config.js";

const Allocation = z.object({
  request_id: z.string(),
  idx: z.number().int(),
  amount_sats: z.number().int(),
  address: z.string(),
  created_at: z.string(),
});

export type Allocation = z.infer<typeof Allocation>;

const Halt = z.object({ reason: z.string(), at: z.string() });

export interface AllocateOptions {
  // Only the testnet gap diagnostic may issue beyond the lookahead.
  readonly enforceLookahead?: boolean;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS allocations (
        request_id TEXT PRIMARY KEY,
        idx INTEGER UNIQUE NOT NULL,
        amount_sats INTEGER NOT NULL,
        address TEXT UNIQUE NOT NULL,
        created_at TEXT NOT NULL
      );
      -- Registered with the currently paired Dojo; cleared on re-pairing.
      CREATE TABLE IF NOT EXISTS registrations (
        idx INTEGER PRIMARY KEY,
        address TEXT UNIQUE NOT NULL,
        registered_at TEXT NOT NULL
      );
      -- First confirmed payment observed for an allocated index.
      CREATE TABLE IF NOT EXISTS payments (
        idx INTEGER PRIMARY KEY,
        txid TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        observed_at TEXT NOT NULL
      );
    `);
  }

  get<S extends z.ZodTypeAny>(
    key: string,
    schema: S,
  ): z.infer<S> | undefined {
    const row = this.db.prepare(
      "SELECT value FROM settings WHERE key = ?",
    ).get(key);
    if (!row) return undefined;
    requireCondition(typeof row.value === "string", "Invalid stored value");
    return schema.parse(JSON.parse(row.value) as unknown);
  }

  insert(key: string, value: unknown): void {
    // Immutable setup records; concurrent commands cannot replace them.
    this.db.prepare(
      "INSERT INTO settings(key, value) VALUES (?, ?)",
    ).run(key, JSON.stringify(value));
  }

  replacePairing(value: unknown): void {
    // A different Dojo has none of the previous registrations.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        "INSERT OR REPLACE INTO settings(key, value) VALUES ('pairing', ?)",
      ).run(JSON.stringify(value));
      this.db.exec("DELETE FROM registrations");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Only for editable, non-security settings such as the public profile.
  replace(key: string, value: unknown): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
    ).run(key, JSON.stringify(value));
  }

  remove(key: string): boolean {
    return this.db.prepare(
      "DELETE FROM settings WHERE key = ?",
    ).run(key).changes > 0;
  }

  register(index: number, address: string): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO registrations VALUES (?, ?, ?)",
    ).run(index, address, new Date().toISOString());
  }

  recordPayment(index: number, txid: string, blockHeight: number): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO payments VALUES (?, ?, ?, ?)",
    ).run(index, txid, blockHeight, new Date().toISOString());
  }

  halt(reason: string): void {
    // Keeps the first reason; issuance stays stopped until cleared.
    this.db.prepare(
      "INSERT OR IGNORE INTO settings(key, value) VALUES ('halt', ?)",
    ).run(JSON.stringify({ reason, at: new Date().toISOString() }));
  }

  halted(): z.infer<typeof Halt> | undefined {
    return this.get("halt", Halt);
  }

  clearHalt(): boolean {
    return this.db.prepare(
      "DELETE FROM settings WHERE key = 'halt'",
    ).run().changes > 0;
  }

  nextIndex(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM allocations",
    ).get();
    return z.number().int().nonnegative().parse(row?.next);
  }

  lastConfirmedPayment(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(idx), -1) AS last FROM payments",
    ).get();
    return z.number().int().parse(row?.last);
  }

  registeredAddress(index: number): string | undefined {
    const row = this.db.prepare(
      "SELECT address FROM registrations WHERE idx = ?",
    ).get(index);
    return row ? z.string().parse(row.address) : undefined;
  }

  // Why the next new allocation would be refused, if it would be.
  issuanceBlocker(
    derive: (index: number) => string,
    options: AllocateOptions = {},
  ): string | undefined {
    const halt = this.halted();
    if (halt) return `Issuance halted: ${halt.reason}`;

    const index = this.nextIndex();
    if (index >= ISSUANCE_LIMIT) {
      return "Development issuance limit reached; no address was reused";
    }
    if (
      (options.enforceLookahead ?? true) &&
      index > this.lastConfirmedPayment() + RECEIVER_LOOKAHEAD
    ) {
      return "Issuance paused: the next address would be beyond the " +
        "receiving wallet's lookahead until a payment confirms";
    }

    const registered = this.registeredAddress(index);
    if (registered === undefined) {
      return "Next address is not yet registered with the Dojo";
    }
    if (registered !== derive(index)) {
      return "Registered address differs from the derived address";
    }
    return undefined;
  }

  findAllocation(id: string): Allocation | undefined {
    const row = this.db.prepare(
      "SELECT * FROM allocations WHERE request_id = ?",
    ).get(id);
    return row ? Allocation.parse(row) : undefined;
  }

  allocate(
    id: string,
    amountSats: number,
    derive: (index: number) => string,
    options: AllocateOptions = {},
  ): Allocation {
    requireCondition(
      /^[A-Za-z0-9_-]{16,128}$/.test(id),
      "Idempotency key must contain 16–128 letters, digits, _ or -",
    );
    requireCondition(
      Number.isSafeInteger(amountSats) &&
        amountSats >= 0 && amountSats <= 100000000,
      "amountSats must be an integer from 0 through 100000000",
    );

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare(
        "SELECT * FROM allocations WHERE request_id = ?",
      ).get(id);

      if (existing) {
        const allocation = Allocation.parse(existing);
        requireCondition(
          allocation.amount_sats === amountSats,
          "Idempotency key already used with a different amount",
        );
        this.db.exec("COMMIT");
        return allocation;
      }

      const blocker = this.issuanceBlocker(derive, options);
      if (blocker) throw new Unavailable(blocker);
      const index = this.nextIndex();

      const allocation: Allocation = {
        request_id: id,
        idx: index,
        amount_sats: amountSats,
        address: derive(index),
        created_at: new Date().toISOString(),
      };

      this.db.prepare(
        "INSERT INTO allocations VALUES (?, ?, ?, ?, ?)",
      ).run(
        allocation.request_id,
        allocation.idx,
        allocation.amount_sats,
        allocation.address,
        allocation.created_at,
      );
      this.db.exec("COMMIT");
      return allocation;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
