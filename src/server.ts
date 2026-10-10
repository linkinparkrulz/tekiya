import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import {
  Approval, Pairing, Pending, Unavailable, requireCondition, type Config,
} from "./config.js";
import {
  createWallet, deriveAddress, identityStatement, verifyIdentity,
} from "./bitcoin.js";
import { Store } from "./store.js";
import { syncDojo } from "./registrar.js";
import { connectDojo } from "./tor.js";

const SYNC_INTERVAL_MS = 60000;

export function requireApproval(store: Store, config: Config): Pending {
  const pending = store.get("notification", Pending);
  const approval = store.get("approval", Approval);
  requireCondition(pending && approval, "Merchant connection is not approved");
  requireCondition(
    approval.txid === pending.txid &&
      verifyIdentity(config, pending, approval.signature),
    "Merchant approval is invalid",
  );
  return pending;
}

function authorized(header: unknown, secret: string): boolean {
  if (typeof header !== "string") return false;
  const hash = (value: string) =>
    createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    requireCondition(size <= 4096, "Request body exceeds 4096 bytes");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export function serve(store: Store, config: Config): void {
  const port = z.coerce.number().int().min(1).max(65535)
    .parse(process.env.NYM_PORT ?? "8088");
  const host = process.env.NYM_LISTEN_HOST ?? "127.0.0.1";
  requireCondition(
    host === "127.0.0.1" || host === "0.0.0.0",
    "Unsupported listen host",
  );

  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");

    const reply = (status: number, value: unknown): void => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };

    try {
      if (req.method === "GET" && req.url === "/health") {
        let ready = false;
        try {
          requireApproval(store, config);
          ready = true;
        } catch {}
        reply(200, {
          application: "Tekiya",
          network: config.network,
          ready,
          issuing: ready && !store.issuanceBlocker(
            index => deriveAddress(config, index),
          ),
        });
        return;
      }

      if (req.method === "GET" && req.url === "/identity") {
        const pending = store.get("notification", Pending);
        const approval = store.get("approval", Approval);
        const verified = Boolean(pending && approval &&
          verifyIdentity(config, pending, approval.signature));
        reply(200, {
          network: config.network,
          onion: config.onion,
          merchantPaymentCode: config.merchantCode,
          dispenserPaymentCode: createWallet(
            config.seedHex, config.network,
          ).sender.toBase58(),
          statement: pending ? identityStatement(config, pending) : null,
          signature: verified ? approval?.signature : null,
          signatureValid: verified,
          notice: "Identity binding, not independent address verification",
        });
        return;
      }

      if (req.method !== "POST" || req.url !== "/v1/payment-requests") {
        reply(404, { error: "Not found" });
        return;
      }

      if (!authorized(req.headers.authorization, config.apiToken)) {
        reply(401, { error: "Unauthorized" });
        return;
      }

      requireCondition(
        req.headers["content-type"]?.split(";")[0] === "application/json",
        "Expected application/json",
      );
      requireApproval(store, config);

      const input = z.object({
        amountSats: z.number().int().min(0).max(100000000).default(0),
      }).strict().parse(await readBody(req));

      const id = z.string().parse(req.headers["idempotency-key"]);
      const allocation = store.allocate(
        id, input.amountSats, index => deriveAddress(config, index),
      );
      const amount = allocation.amount_sats;
      const bitcoinUri = `bitcoin:${allocation.address}` +
        (amount ? `?amount=${(amount / 100000000).toFixed(8)}` : "");

      reply(200, {
        id: allocation.request_id,
        address: allocation.address,
        amountSats: amount,
        bitcoinUri,
        network: config.network,
      });
    } catch (error) {
      reply(error instanceof Unavailable ? 503 : 400, {
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  });

  // Requests never wait on Tor: they are served only from addresses this
  // loop has already registered.
  let syncing = false;
  const sync = async (): Promise<void> => {
    if (syncing) return;
    syncing = true;
    try {
      const pairing = store.get("pairing", Pairing);
      requireCondition(pairing, "No Dojo pairing");
      const result = await syncDojo(
        store, config, await connectDojo(pairing, config.network),
      );
      if (result.halted) console.error(result.halted);
    } catch (error) {
      console.error(`Dojo sync failed: ${
        error instanceof Error ? error.message : "unknown error"
      }`);
    } finally {
      syncing = false;
    }
  };
  void sync();
  const timer = setInterval(() => void sync(), SYNC_INTERVAL_MS);

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.timeout = 15000;
  server.maxHeadersCount = 30;

  server.listen(port, host, () => {
    console.log(
      `Tekiya ${config.network.toUpperCase()} development API: ${host}:${port}`,
    );
  });

  const shutdown = (): void => {
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
