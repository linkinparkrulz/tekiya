import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Config, NetworkName, requireCondition } from "./config.js";
import { registerPaynym } from "./paynym.js";
import { Store } from "./store.js";

// Kept for existing instructions; `serve` now does this automatically and
// `npm run cli -- paynym` runs it on demand.
async function main(): Promise<void> {
  process.umask(0o077);
  const network = NetworkName.parse(process.env.NYM_NETWORK ?? "testnet4");
  const path = join(
    resolve(process.env.NYM_DATA ?? "private"), network, "state.sqlite",
  );
  requireCondition(existsSync(path), "Existing wallet database not found");

  const store = new Store(path);
  try {
    const config = store.get("config", Config);
    requireCondition(
      config && config.network === network,
      "Missing configuration or network mismatch",
    );
    console.log(JSON.stringify(await registerPaynym(store, config), null, 2));
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Claim failed");
  process.exitCode = 1;
});
