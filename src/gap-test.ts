import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { z } from "zod";
import {
  Config, Pairing, Pending, requireCondition,
} from "./config.js";
import {
  deriveAddress, reconstruct,
} from "./bitcoin.js";
import { Store } from "./store.js";
import { syncDojo } from "./registrar.js";
import { connectDojo } from "./tor.js";

process.umask(0o077);

async function main(): Promise<void> {
  requireCondition(
    process.env.NYM_NETWORK === "testnet4",
    "This diagnostic requires NYM_NETWORK=testnet4",
  );
  requireCondition(
    process.argv.includes("--reserve-through-index-4"),
    "Pass --reserve-through-index-4 to reserve all remaining staging slots",
  );

  const root = resolve(process.env.NYM_DATA ?? "private");
  const path = join(root, "testnet4", "state.sqlite");
  requireCondition(existsSync(path), "Existing testnet4 database not found");

  const store = new Store(path);

  try {
    const config = store.get("config", Config);
    const pending = store.get("notification", Pending);

    requireCondition(
      config && config.network === "testnet4" && pending,
      "Missing testnet4 configuration or notification",
    );
    reconstruct(config, pending);

    const rows = z.array(z.object({
      request_id: z.string(),
      idx: z.number().int(),
      address: z.string(),
    })).parse(
      store.db.prepare(
        "SELECT request_id, idx, address FROM allocations ORDER BY idx",
      ).all(),
    );

    const expectedIds = [
      "setup_compatibility_test",
      "setup_gap_unused_01",
      "setup_gap_unused_02",
      "setup_gap_unused_03",
      "setup_gap_payment_04",
    ];

    requireCondition(
      rows.length >= 1 && rows.length <= expectedIds.length,
      "Unexpected allocation history; refusing to alter it",
    );

    // Permit retries after a partially completed run, but reject
    // unrelated customer allocations or a different index sequence.
    for (const [position, row] of rows.entries()) {
      requireCondition(
        row.idx === position &&
          row.request_id === expectedIds[position] &&
          row.address === deriveAddress(config, position),
        "Allocation history differs from the expected gap-test sequence",
      );
    }

    const pairing = store.get("pairing", Pairing);
    requireCondition(pairing, "Import a Dojo pairing file first");
    const synced = await syncDojo(
      store, config, await connectDojo(pairing, "testnet4"), { through: 4 },
    );
    requireCondition(!synced.halted, synced.halted ?? "");

    let targetAddress: string | undefined;

    for (let index = 1; index <= 4; index++) {
      const id = expectedIds[index];
      requireCondition(id, "Missing diagnostic request ID");

      const allocation = store.allocate(
        id,
        0,
        nextIndex => {
          requireCondition(
            nextIndex === index,
            "Unexpected next index; stop other allocation processes",
          );
          return deriveAddress(config, nextIndex);
        },
        // Deliberately exceeds the lookahead; that is what this tests.
        { enforceLookahead: false },
      );

      requireCondition(
        allocation.idx === index,
        "Diagnostic allocation has an unexpected index",
      );

      if (index === 4) targetAddress = allocation.address;
    }

    requireCondition(targetAddress, "Gap-test address was not generated");

    console.log(JSON.stringify({
      network: config.network,
      deliberatelyUnpaidIndices: [1, 2, 3],
      paymentIndex: 4,
      paymentAddress: targetAddress,
      suggestedTestAmountSats: 2000,
      remainingStagingSlots: 0,
      instruction:
        "Pay only this index-4 address. Check automatic merchant-wallet " +
        "discovery without manually importing an address or key.",
    }, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Gap test failed");
  process.exitCode = 1;
});
