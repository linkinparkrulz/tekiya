import {
  chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { Transaction } from "bitcoinjs-lib";
import { z } from "zod";
import {
  Approval, Config, NetworkName, Pairing, Pending,
  onionUrl, requireCondition,
} from "./config.js";
import {
  buildNotification, createWallet, deriveAddress,
  identityStatement, receiver, reconstruct, verifyIdentity,
} from "./bitcoin.js";
import { Store } from "./store.js";
import { syncDojo } from "./registrar.js";
import { connectDojo, DIRECTORY, torJson } from "./tor.js";
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

const ObservedTransaction = z.object({
  hex: z.string().max(800000).regex(/^(?:[0-9a-fA-F]{2})+$/),
  confirmations: z.number().int().positive(),
});

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
    if (command === "init") {
      requireCondition(
        !store.get("config", Config),
        "Installation already initialized; replacement refused",
      );
      const merchantCode = argument(
        args, 0, "Usage: init MERCHANT_PAYMENT_CODE ONION_ORIGIN",
      );
      const onion = onionUrl(argument(
        args, 1, "Usage: init MERCHANT_PAYMENT_CODE ONION_ORIGIN",
      ), true).origin;
      receiver(merchantCode, network);

      const config: Config = {
        network,
        merchantCode,
        onion,
        seedHex: randomBytes(64).toString("hex"),
        apiToken: randomBytes(32).toString("hex"),
      };
      store.insert("config", config);
      print(`Initialized ${network}. Back up private state before funding.`);
      return;
    }

    const config = store.get("config", Config);
    requireCondition(config, "Initialize this network first");
    requireCondition(config.network === network, "Stored network mismatch");

    const getPairing = (): Pairing => {
      const pairing = store.get("pairing", Pairing);
      requireCondition(pairing, "Import a Dojo pairing file first");
      return pairing;
    };

    const getPending = (): Pending => {
      const pending = store.get("notification", Pending);
      requireCondition(pending, "Prepare a notification first");
      return pending;
    };

    const confirmedNotification = async () => {
      const pending = getPending();
      reconstruct(config, pending);
      const api = await connectDojo(getPairing(), network);
      const observed = ObservedTransaction.parse(
        await api(`tx/${pending.txid}?rawHex=1`),
      );
      requireCondition(
        Transaction.fromHex(observed.hex).getId() === pending.txid,
        "Backend returned the wrong notification transaction",
      );
      return { pending, api };
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
        const pairing = Pairing.parse(
          JSON.parse(readFileSync(filename, "utf8")) as unknown,
        );
        const api = await connectDojo(pairing, network);
        const replaced = Boolean(store.get("pairing", Pairing));
        store.replacePairing(pairing);
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

      case "sync": {
        const api = await connectDojo(getPairing(), network);
        print(await syncDojo(store, config, api));
        break;
      }

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
        requireCondition(
          !store.get("notification", Pending),
          "Notification already exists; refusing a second setup transaction",
        );
        const txid = z.string().regex(/^[0-9a-f]{64}$/).parse(
          argument(args, 0, "Usage: prepare FUNDING_TXID VOUT FEE_SATS"),
        );
        const vout = Number(argument(
          args, 1, "Usage: prepare FUNDING_TXID VOUT FEE_SATS",
        ));
        const feeSats = Number(argument(
          args, 2, "Usage: prepare FUNDING_TXID VOUT FEE_SATS",
        ));
        const api = await connectDojo(getPairing(), network);
        const previous = ObservedTransaction.parse(
          await api(`tx/${txid}?rawHex=1`),
        );
        requireCondition(
          Transaction.fromHex(previous.hex).getId() === txid,
          "Backend returned the wrong funding transaction",
        );
        const pending = buildNotification(
          config, previous.hex, vout, feeSats,
        );
        store.insert("notification", pending);
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
        const pending = reconstruct(config, getPending());
        requireCondition(
          args[0] === pending.txid,
          "Usage: broadcast EXACT_PREPARED_NOTIFICATION_TXID",
        );
        const api = await connectDojo(getPairing(), network);
        const response = z.object({
          status: z.literal("ok"),
          data: z.string(),
        }).parse(await api("pushtx/", { tx: pending.hex }));
        requireCondition(
          response.data === pending.txid,
          "Backend acknowledged an unexpected transaction ID",
        );
        print({ txid: pending.txid, broadcastAcknowledged: true });
        break;
      }

      case "test-address": {
        const { api } = await confirmedNotification();
        await syncDojo(store, config, api);
        // Reserved locally so the compatibility test cannot cause reuse.
        const allocation = store.allocate(
          "setup_compatibility_test", 0,
          index => deriveAddress(config, index),
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
        const { pending } = await confirmedNotification();
        const filename = argument(args, 0, "Usage: approve SIGNATURE_FILE");
        const signature = readFileSync(filename, "utf8").trim();
        requireCondition(
          verifyIdentity(config, pending, signature),
          "Merchant signature does not match the exact approval statement",
        );
        store.insert("approval", {
          txid: pending.txid,
          signature,
          createdAt: new Date().toISOString(),
        });
        print("Merchant approval accepted.");
        print("Confirmation status is trusted Dojo data, not an SPV proof.");
        break;
      }

      case "serve":
        serve(store, config);
        serving = true;
        break;

      default:
        throw new Error(
          "Commands: init, info, token, directory, pair, sync, status, " +
          "resume-issuance, prepare, broadcast, test-address, statement, " +
          "approve, serve",
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
