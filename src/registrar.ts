import { z } from "zod";
import {
  ISSUANCE_LIMIT, REGISTRATION_POOL, requireCondition, type Config,
} from "./config.js";
import { deriveAddress } from "./bitcoin.js";
import { Store } from "./store.js";

export type DojoApi = (
  path: string,
  form?: Record<string, string>,
) => Promise<unknown>;

const WalletResponse = z.object({
  addresses: z.array(z.object({
    address: z.string(),
    n_tx: z.number().int().nonnegative(),
  })),
  txs: z.array(z.object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    block_height: z.number().int().positive().nullish(),
    out: z.array(z.object({
      addr: z.string().nullish(),
      value: z.number().int().nonnegative(),
    })),
    inputs: z.array(z.object({
      prev_out: z.object({ addr: z.string().nullish() }),
    })).default([]),
  })),
});

export interface SyncResult {
  readonly registered: number[];
  readonly confirmedPayments: number[];
  readonly halted?: string;
}

/**
 * Registers addresses with the paired Dojo before they can be issued, and
 * records what issued addresses have received.
 *
 * Only the P2WPKH address is registered: the first `active=` lookup makes
 * Dojo track it, and a later `new=` from the receiving wallet cannot erase
 * it. Dojo hides import failures behind a normal response, so every address
 * is looked up again on each pass; a missed import is retried. The wallet
 * endpoint does not expose tracking/import status, so this is not proof of
 * successful import (the tracking endpoint requires admin credentials).
 */
export async function syncDojo(
  store: Store,
  config: Config,
  api: DojoApi,
  options: { through?: number } = {},
): Promise<SyncResult> {
  const snapshot = () => store.db.prepare(
    "SELECT key, value FROM settings WHERE key IN ('pairing', 'pairing-generation') ORDER BY key",
  ).all();
  const pairing = JSON.stringify(snapshot());
  const next = store.nextIndex();
  const last = Math.min(
    ISSUANCE_LIMIT - 1,
    Math.max(options.through ?? -1, next + REGISTRATION_POOL - 1),
  );

  const registered: number[] = [];
  const confirmedPayments: number[] = [];
  if (last < 0) return { registered, confirmedPayments };

  const addresses = Array.from(
    { length: last + 1 }, (_, index) => deriveAddress(config, index),
  );
  const response = WalletResponse.parse(
    await api("wallet", { active: addresses.join("|") }),
  );

  requireCondition(
    new Set(response.txs.map(tx => tx.hash)).size === response.txs.length,
    "Dojo returned duplicate transactions",
  );
  for (const [index, address] of addresses.entries()) {
    const entries = response.addresses.filter(item => item.address === address);
    requireCondition(entries.length === 1,
      `Dojo response omitted or duplicated the index-${index} address; not registered`);
    // Dojo n_tx counts distinct receiving AND spending transactions. /wallet
    // is capped; never interpret a truncated list as complete received totals.
    const count = response.txs.filter(tx =>
      tx.out.some(output => output.addr === address) ||
      tx.inputs.some(input => input.prev_out.addr === address)).length;
    requireCondition(count === entries[0]!.n_tx,
      `Dojo transaction history is incomplete for index ${index}`);
  }

  store.db.exec("BEGIN IMMEDIATE");
  try {
    requireCondition(JSON.stringify(snapshot()) === pairing,
      "Dojo pairing changed during sync; stale results rejected");
    // Re-read under the write lock: another process may have issued addresses.
    const issued = store.nextIndex();

    for (const [index, address] of addresses.entries()) {
      const entry = response.addresses.find(item => item.address === address);
      requireCondition(
        entry,
        `Dojo response omitted the index-${index} address; not registered`,
      );

      if (index >= issued && entry.n_tx > 0) {
        // History on a never-issued address means it was issued elsewhere:
        // a cloned installation or a restored stale backup.
        const reason =
          `Dojo reports history for unissued index ${index}. Stop all ` +
          "copies of this installation and perform recovery analysis.";
        store.halt(reason);
        store.db.exec("COMMIT");
        return { registered, confirmedPayments, halted: reason };
      }

      store.register(index, address);
      registered.push(index);
      if (index >= issued) continue;

      let confirmed = 0;
      let unconfirmed = 0;
      let first: { hash: string; height: number } | undefined;
      for (const tx of response.txs) {
        const value = tx.out
          .filter(output => output.addr === address)
          .reduce((sum, output) => sum + output.value, 0);
        if (value === 0) {
          continue;
        }
        if (typeof tx.block_height === "number") {
          confirmed += value;
          if (!first || tx.block_height < first.height) {
            first = { hash: tx.hash, height: tx.block_height };
          }
        } else {
          unconfirmed += value;
        }
      }
      store.recordReceived(index, confirmed, unconfirmed);
      const previous = store.db.prepare("SELECT txid, block_height FROM payments WHERE idx = ?").get(index);
      store.db.prepare("DELETE FROM payments WHERE idx = ?").run(index);
      if (first) {
        store.recordPayment(index, first.hash, first.height);
      }
      if (first && (previous?.txid !== first.hash || previous.block_height !== first.height)) {
        confirmedPayments.push(index);
      }
    }

    store.db.exec("COMMIT");
    return { registered, confirmedPayments };
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}
