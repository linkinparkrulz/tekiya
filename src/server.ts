import { createServer } from "node:http";
import { z } from "zod";
import {
  Approval, Config, Pending, Unavailable, requireCondition,
  type NetworkName,
} from "./config.js";
import {
  createWallet, deriveAddress, identityStatement, signedStatement,
} from "./bitcoin.js";
import { requireApproval } from "./approval.js";
import { serveAdmin } from "./admin.js";
import { Store } from "./store.js";
import { Monitor } from "./monitor.js";
import { migrateMerchantCode } from "./setup.js";
import { handleApi } from "./api.js";
import { handlePublic } from "./web.js";

const SYNC_INTERVAL_MS = 60000;

export function serve(store: Store, network: NetworkName): void {
  const port = z.coerce.number().int().min(1).max(65535)
    .parse(process.env.NYM_PORT ?? "8088");
  const host = process.env.NYM_LISTEN_HOST ?? "127.0.0.1";
  requireCondition(
    host === "127.0.0.1" || host === "0.0.0.0",
    "Unsupported listen host",
  );
  const stored = store.get("config", Config);
  requireCondition(
    !stored || stored.network === network,
    "Stored network mismatch",
  );
  if (migrateMerchantCode(store)) {
    console.log("Merchant payment code switched to its SegWit form");
  }

  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");

    const reply = (status: number, value: unknown): void => {
      res.writeHead(status);
      res.end(JSON.stringify(value));
    };

    try {
      // Read per request: setup in the dashboard creates it while serving.
      const config = store.get("config", Config);

      if (req.method === "GET" && req.url === "/health") {
        let ready = false;
        try {
          requireCondition(config, "Not set up");
          requireApproval(store, config);
          ready = true;
        } catch {}
        reply(200, {
          application: "Tekiya",
          network,
          ready,
          issuing: ready && config !== undefined && !store.issuanceBlocker(
            index => deriveAddress(config, index),
          ),
        });
        return;
      }

      if (req.method === "GET" && req.url === "/identity") {
        if (!config) {
          reply(503, { error: "Not set up" });
          return;
        }
        const pending = store.get("notification", Pending);
        const approval = store.get("approval", Approval);
        const signed = pending && approval
          ? signedStatement(config, pending, approval.signature)
          : undefined;
        const verified = signed !== undefined;
        reply(200, {
          network: config.network,
          onion: config.onion,
          merchantPaymentCode: config.merchantCode,
          dispenserPaymentCode: createWallet(
            config.seedHex, config.network,
          ).sender.toBase58(),
          // The exact signed text, so others can verify the signature.
          statement: signed ??
            (pending ? identityStatement(config, pending) : null),
          signature: verified ? approval?.signature : null,
          signatureValid: verified,
          notice: "Identity binding, not independent address verification",
        });
        return;
      }

      if ((req.url ?? "").startsWith("/v1/")) {
        await handleApi(req, res, store, network);
        return;
      }

      if (await handlePublic(req, res, store, network)) return;
      reply(404, { error: "Not found" });
    } catch (error) {
      reply(error instanceof Unavailable ? 503 : 400, {
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  });

  const monitor = new Monitor(store, network);
  monitor.start(SYNC_INTERVAL_MS);
  const admin = serveAdmin(store, network, monitor);

  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  // Wallet RPC may take 120 seconds; keep response sockets alive through it.
  server.timeout = 180000;
  server.maxHeadersCount = 30;

  server.listen(port, host, () => {
    console.log(
      `Tekiya ${network.toUpperCase()} payment service: ${host}:${port}`,
    );
  });

  const shutdown = (): void => {
    monitor.stop();
    admin?.close();
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
