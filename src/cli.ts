import {
  chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  Approval, Config, NetworkName, Pending, Profile, requireCondition,
} from "./config.js";
import {
  createWallet, deriveAddress, identityStatement,
} from "./bitcoin.js";
import { Store } from "./store.js";
import { syncDojo } from "./registrar.js";
import {
  approve, broadcastNotification, confirmedNotification, connectPaired,
  initialize, issueTestAddress, pairDojo, parsePairing, prepareNotification,
} from "./setup.js";
import { DIRECTORY, torJson } from "./tor.js";
import { serve } from "./server.js";

process.umask(0o077);

function print(value: unknown): void {
  console.log(typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2));
}

function argument(args: string[], index: number, usage: string): string {
  const value = args[index];
  requireCondition(value, usage);
  return value;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const network = NetworkName.parse(process.env.NYM_NETWORK ?? "testnet4");
  const root = resolve(process.env.NYM_DATA ?? "private");
  const directory = join(root, network);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);

  requireCondition(
    !existsSync(join(root, "state.sqlite")),
    "Legacy unlabelled state found. Archive it; do not migrate blindly.",
  );

  if (command === "directory") {
    const data = await torJson(DIRECTORY);
    const path = join(directory, "directory.json");
    writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    print(`Saved untrusted directory snapshot to ${path}`);
    print("Select and label the backend manually in this staging build.");
    return;
  }

  const store = new Store(join(directory, "state.sqlite"));
  let serving = false;

  try {
    if (command === "serve") {
      // Starts before setup: the operator dashboard performs it.
      serve(store, network);
      serving = true;
      return;
    }

    if (command === "init") {
      const usage = "Usage: init MERCHANT_PAYMENT_CODE ONION_ORIGIN";
      initialize(
        store, network, argument(args, 0, usage), argument(args, 1, usage),
      );
      print(`Initialized ${network}. Back up private state before funding.`);
      return;
    }

    const config = store.get("config", Config);
    requireCondition(config, "Initialize this network first");
    requireCondition(config.network === network, "Stored network mismatch");

    const getPending = (): Pending => {
      const pending = store.get("notification", Pending);
      requireCondition(pending, "Prepare a notification first");
      return pending;
    };

    switch (command) {
      case "info": {
        const wallet = createWallet(config.seedHex, network);
        print({
          network,
          onion: config.onion,
          merchantCode: config.merchantCode,
          dispenserCode: wallet.sender.toBase58(),
          fundingAddress: wallet.fundingAddress,
          fundingPath: wallet.fundingPath,
          notificationTxid: store.get("notification", Pending)?.txid ?? null,
          approved: Boolean(store.get("approval", Approval)),
          allocations: store.db.prepare(
            "SELECT COUNT(*) AS count FROM allocations",
          ).get()?.count,
        });
        break;
      }

      case "token":
        print(config.apiToken);
        break;

      case "pair": {
        const filename = argument(args, 0, "Usage: pair PRIVATE_PAIRING_FILE");
        const pairing = parsePairing(readFileSync(filename, "utf8"), network);
        const { api, replaced } = await pairDojo(store, config, pairing);
        print("Dojo login succeeded; the configured network label matches.");
        print("Backend chain identity has not been independently proven.");
        print("The merchant wallet is assumed to use this same Dojo.");
        if (replaced) {
          print("Previous pairing replaced; its registrations were cleared.");
        }
        try {
          print({ sync: await syncDojo(store, config, api) });
        } catch (error) {
          print(`Address registration failed: ${
            error instanceof Error ? error.message : "unknown error"
          }. Run sync before serving.`);
        }
        if (replaced) {
          print("Switch the merchant wallet to this Dojo only after a " +
            "successful sync, so existing payments are imported first.");
        }
        break;
      }

      case "sync":
        print(await syncDojo(store, config, await connectPaired(store, config)));
        break;

      case "status": {
        const blocker = store.issuanceBlocker(
          index => deriveAddress(config, index),
        );
        print({
          network,
          nextIndex: store.nextIndex(),
          lastConfirmedPayment: store.lastConfirmedPayment(),
          registered: store.db.prepare(
            "SELECT idx FROM registrations ORDER BY idx",
          ).all().map(row => row.idx),
          payments: store.db.prepare(
            "SELECT idx, txid, block_height FROM payments ORDER BY idx",
          ).all(),
          issuing: !blocker,
          blocker: blocker ?? null,
        });
        break;
      }

      case "profile": {
        if (args[0] === "--clear") {
          store.remove("profile");
          print("Profile cleared; the page shows the default title.");
          break;
        }
        if (args.length > 0) {
          store.replace("profile", Profile.parse({
            name: args[0],
            description: args[1] ?? "",
          }));
        }
        print(store.get("profile", Profile) ?? "No profile set.");
        break;
      }

      case "resume-issuance": {
        requireCondition(
          args[0] === "--recovery-reviewed",
          "Usage: resume-issuance --recovery-reviewed",
        );
        print(store.clearHalt()
          ? "Halt cleared."
          : "Issuance was not halted.");
        break;
      }

      case "prepare": {
        const usage = "Usage: prepare FUNDING_TXID VOUT FEE_SATS";
        const pending = await prepareNotification(
          store, config, await connectPaired(store, config),
          argument(args, 0, usage),
          Number(argument(args, 1, usage)),
          Number(argument(args, 2, usage)),
        );
        print({
          txid: pending.txid,
          recipient: pending.recipient,
          feeSats: pending.feeSats,
          feeRate: pending.feeRate,
          changeSats: pending.changeSats,
        });
        print("Prepared and saved, not broadcast.");
        break;
      }

      case "broadcast": {
        requireCondition(
          args[0] === getPending().txid,
          "Usage: broadcast EXACT_PREPARED_NOTIFICATION_TXID",
        );
        const txid = await broadcastNotification(
          store, config, await connectPaired(store, config),
        );
        print({ txid, broadcastAcknowledged: true });
        break;
      }

      case "test-address": {
        const allocation = await issueTestAddress(
          store, config, await connectPaired(store, config),
        );
        print({
          ...allocation,
          network,
          instruction: "Receive and spend a small test payment in the merchant wallet.",
        });
        break;
      }

      case "statement":
        print(identityStatement(config, getPending()));
        break;

      case "approve": {
        const pending = await confirmedNotification(
          store, config, await connectPaired(store, config),
        );
        const filename = argument(args, 0, "Usage: approve SIGNATURE_FILE");
        approve(store, config, pending, readFileSync(filename, "utf8"));
        print("Merchant approval accepted.");
        print("Confirmation status is trusted Dojo data, not an SPV proof.");
        break;
      }

      default:
        throw new Error(
          "Commands: serve (setup runs in its dashboard), init, info, token, " +
          "directory, pair, sync, status, profile, resume-issuance, prepare, " +
          "broadcast, test-address, statement, approve",
        );
    }
  } finally {
    if (!serving) store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Command failed");
  process.exitCode = 1;
});
