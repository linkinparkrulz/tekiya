import { z } from "zod";
import {
  ISSUANCE_LIMIT, REGISTRATION_POOL, requireCondition, type Config,
} from "./config.js";
import { deriveAddress, derivePaymentPubkey } from "./bitcoin.js";
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
    out: z.array(z.object({ addr: z.string().nullish() })).default([]),
  })),
});

export interface SyncResult {
  readonly registered: number[];
  readonly confirmedPayments: number[];
  readonly halted?: string;
}

/**
 * Registers addresses with the paired Dojo before they can be issued, and
 * records confirmed payments to issued addresses.
 *
 * The first `active=` lookup makes Dojo track an address, and a later
 * `new=` from the receiving wallet cannot erase it. Dojo hides import
 * failures behind a normal response, so every unpaid index is looked up
 * again on each pass; a missed import is retried.
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

  const paid = new Set(z.array(z.number().int()).parse(
    store.db.prepare("SELECT idx FROM payments").all()
      .map(row => row.idx),
  ));
  // After re-pairing, paid indices are registered again so the new Dojo
  // imports their history before the receiving wallet can declare them new.
  const indices: number[] = [];
  for (let index = 0; index <= last; index++) {
    if (!paid.has(index) || store.registeredAddress(index) === undefined) {
      indices.push(index);
    }
  }

  const registered: number[] = [];
  const confirmedPayments: number[] = [];
  if (indices.length === 0) return { registered, confirmedPayments };

  // Pubkeys make Dojo track all three address forms the wallet may query.
  const response = WalletResponse.parse(await api("wallet", {
    active: indices.map(index => derivePaymentPubkey(config, index)).join("|"),
  }));

  // Re-read: another process may have issued addresses during the request.
  const issued = store.nextIndex();

  for (const index of indices) {
    const address = deriveAddress(config, index);
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

    if (index >= issued || paid.has(index)) continue;
    const payment = response.txs
      .filter(tx => typeof tx.block_height === "number" &&
        tx.out.some(output => output.addr === address))
      .sort((a, b) => (a.block_height ?? 0) - (b.block_height ?? 0))[0];
    if (typeof payment?.block_height === "number") {
      store.recordPayment(index, payment.hash, payment.block_height);
      confirmedPayments.push(index);
    }
  }

  return { registered, confirmedPayments };
}
