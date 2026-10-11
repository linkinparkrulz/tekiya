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
      value: z.number().int().nonnegative().default(0),
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
 * is looked up again on each pass; a missed import is retried.
 */
export async function syncDojo(
  store: Store,
  config: Config,
  api: DojoApi,
  options: { through?: number } = {},
): Promise<SyncResult> {
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

  // Re-read: another process may have issued addresses during the request.
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
      if (value === 0 && !tx.out.some(output => output.addr === address)) {
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
    if (first && store.recordPayment(index, first.hash, first.height)) {
      confirmedPayments.push(index);
    }
  }

  return { registered, confirmedPayments };
}
