import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ISSUANCE_LIMIT, requireCondition } from "./config.js";

const Allocation = z.object({
  request_id: z.string(),
  idx: z.number().int(),
  amount_sats: z.number().int(),
  address: z.string(),
  created_at: z.string(),
});

export type Allocation = z.infer<typeof Allocation>;

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

  allocate(
    id: string,
    amountSats: number,
    derive: (index: number) => string,
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

      const row = this.db.prepare(
        "SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM allocations",
      ).get();
      const index = z.number().int().nonnegative().parse(row?.next);
      requireCondition(
        index < ISSUANCE_LIMIT,
        "Development issuance limit reached; no address was reused",
      );

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
