import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  Config, Unavailable, requireCondition, type NetworkName,
} from "./config.js";
import { deriveAddress } from "./bitcoin.js";
import { requireApproval } from "./approval.js";
import { bitcoinUri } from "./html.js";
import {
  XMR_CONFIRMATIONS, allocateMonero, moneroNetwork, moneroSettings,
  moneroUri, xmrBlocker,
} from "./monero.js";
import {
  Store, type PaymentStatus, type XmrPaymentStatus,
} from "./store.js";

// Integration API for shop backends; documented in docs/API.md.

type ErrorCode = "unauthorized" | "not_found" | "invalid_request" | "unavailable";

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function authorized(header: unknown, secret: string): boolean {
  if (typeof header !== "string") return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(header), hash(`Bearer ${secret}`));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    requireCondition(size <= 4096, "Request body exceeds 4096 bytes");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body is not valid JSON");
  }
}

function present(status: PaymentStatus, network: NetworkName) {
  const { allocation } = status;
  return {
    id: allocation.request_id,
    asset: "BTC",
    address: allocation.address,
    amountSats: allocation.amount_sats,
    amountAtomic: allocation.amount_sats,
    uri: bitcoinUri(allocation.address, allocation.amount_sats),
    bitcoinUri: bitcoinUri(allocation.address, allocation.amount_sats),
    network,
    createdAt: allocation.created_at,
    received: {
      confirmedSats: status.confirmedSats,
      unconfirmedSats: status.unconfirmedSats,
      confirmedAtomic: status.confirmedSats,
      unconfirmedAtomic: status.unconfirmedSats,
    },
    status: status.state,
    firstConfirmedBlock: status.firstConfirmedBlock,
    checkedAt: status.checkedAt,
  };
}

function presentXmr(status: XmrPaymentStatus, network: NetworkName) {
  const { allocation } = status;
  return {
    id: allocation.request_id,
    asset: "XMR",
    address: allocation.address,
    amountAtomic: allocation.amount_atomic,
    uri: moneroUri(allocation.address, allocation.amount_atomic),
    network: moneroNetwork(network),
    createdAt: allocation.created_at,
    received: {
      confirmedAtomic: status.confirmedAtomic,
      unconfirmedAtomic: status.pendingAtomic,
    },
    status: status.state,
    confirmationsRequired: XMR_CONFIRMATIONS,
    checkedAt: status.checkedAt,
  };
}

function xmrStatusOf(store: Store, id: string): XmrPaymentStatus {
  const status = store.xmrPaymentStatus(id);
  if (!status) throw new ApiError(404, "not_found", "Unknown payment request");
  return status;
}

function statusOf(store: Store, id: string): PaymentStatus {
  const status = store.paymentStatus(id);
  if (!status) throw new ApiError(404, "not_found", "Unknown payment request");
  return status;
}

async function route(
  req: IncomingMessage,
  store: Store,
  network: NetworkName,
): Promise<unknown> {
  const config = store.get("config", Config);
  if (!config) throw new Unavailable("Not set up");
  if (!authorized(req.headers.authorization, config.apiToken)) {
    throw new ApiError(401, "unauthorized", "Missing or wrong bearer token");
  }
  const path = (req.url ?? "").split("?")[0] ?? "";
  const derive = (index: number) => deriveAddress(config, index);

  if (req.method === "GET" && path === "/v1/status") {
    let ready = false;
    let reason: string | undefined;
    try {
      requireApproval(store, config);
      ready = true;
      reason = store.issuanceBlocker(derive);
    } catch (error) {
      reason = error instanceof Error ? error.message : "Not ready";
    }
    const xmrReason = xmrBlocker(store);
    return {
      network,
      ready,
      issuing: reason === undefined,
      reason: reason ?? null,
      assets: {
        BTC: { issuing: reason === undefined, reason: reason ?? null },
        XMR: {
          enabled: moneroSettings(store) !== undefined,
          issuing: xmrReason === undefined,
          reason: xmrReason ?? null,
        },
      },
    };
  }

  if (req.method === "POST" && path === "/v1/payment-requests") {
    requireCondition(
      req.headers["content-type"]?.split(";")[0] === "application/json",
      "Expected application/json",
    );
    const input = z.discriminatedUnion("asset", [
      z.object({
        asset: z.literal("BTC"),
        amountSats: z.number().int().min(0).max(100000000).default(0),
      }).strict(),
      z.object({
        asset: z.literal("XMR"),
        amountAtomic: z.number().int().min(0).default(0),
      }).strict(),
    ]).parse({ asset: "BTC", ...z.object({}).passthrough()
      .parse(await readJson(req)) });
    const id = z.string({
      required_error: "Idempotency-Key header is required",
    }).parse(req.headers["idempotency-key"]);

    if (input.asset === "XMR") {
      const allocation = await allocateMonero(store, id, input.amountAtomic);
      return presentXmr(xmrStatusOf(store, allocation.request_id), network);
    }
    try {
      requireApproval(store, config);
    } catch (error) {
      throw new Unavailable(
        error instanceof Error ? error.message : "Not approved",
      );
    }
    const allocation = store.allocate(id, input.amountSats, derive);
    return present(statusOf(store, allocation.request_id), network);
  }

  const match = /^\/v1\/payment-requests\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (req.method === "GET" && match?.[1]) {
    // A web request may have both; ?asset=XMR selects Monero.
    const asset = new URL(req.url ?? "", "http://x").searchParams.get("asset");
    if (asset === "XMR" || (asset !== "BTC" && !store.paymentStatus(match[1]))) {
      return presentXmr(xmrStatusOf(store, match[1]), network);
    }
    return present(statusOf(store, match[1]), network);
  }

  throw new ApiError(404, "not_found", "No such API endpoint");
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  network: NetworkName,
): Promise<void> {
  const reply = (status: number, value: unknown): void => {
    res.writeHead(status);
    res.end(JSON.stringify(value));
  };
  try {
    reply(200, await route(req, store, network));
  } catch (error) {
    if (error instanceof ApiError) {
      reply(error.status, { error: error.message, code: error.code });
    } else if (error instanceof Unavailable) {
      reply(503, { error: error.message, code: "unavailable" });
    } else if (error instanceof z.ZodError) {
      reply(400, {
        error: error.issues.map(issue => issue.message).join("; "),
        code: "invalid_request",
      });
    } else {
      reply(400, {
        error: error instanceof Error ? error.message : "Request failed",
        code: "invalid_request",
      });
    }
  }
}
