import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  Config, Unavailable, requireCondition, type NetworkName,
} from "./config.js";
import { deriveAddress } from "./bitcoin.js";
import { requireApproval } from "./approval.js";
import { bitcoinUri } from "./html.js";
import { Store, type PaymentStatus } from "./store.js";

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
    address: allocation.address,
    amountSats: allocation.amount_sats,
    bitcoinUri: bitcoinUri(allocation.address, allocation.amount_sats),
    network,
    createdAt: allocation.created_at,
    received: {
      confirmedSats: status.confirmedSats,
      unconfirmedSats: status.unconfirmedSats,
    },
    status: status.state,
    firstConfirmedBlock: status.firstConfirmedBlock,
    checkedAt: status.checkedAt,
  };
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
    return {
      network,
      ready,
      issuing: reason === undefined,
      reason: reason ?? null,
    };
  }

  if (req.method === "POST" && path === "/v1/payment-requests") {
    requireCondition(
      req.headers["content-type"]?.split(";")[0] === "application/json",
      "Expected application/json",
    );
    try {
      requireApproval(store, config);
    } catch (error) {
      throw new Unavailable(
        error instanceof Error ? error.message : "Not approved",
      );
    }
    const input = z.object({
      amountSats: z.number().int().min(0).max(100000000).default(0),
    }).strict().parse(await readJson(req));
    const id = z.string({
      required_error: "Idempotency-Key header is required",
    }).parse(req.headers["idempotency-key"]);
    const allocation = store.allocate(id, input.amountSats, derive);
    return present(statusOf(store, allocation.request_id), network);
  }

  const match = /^\/v1\/payment-requests\/([A-Za-z0-9_-]{1,128})$/.exec(path);
  if (req.method === "GET" && match?.[1]) {
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
