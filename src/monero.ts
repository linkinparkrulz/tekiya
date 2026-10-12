import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Unavailable, requireCondition, type NetworkName } from "./config.js";
import { Store, type XmrAllocation } from "./store.js";

// Optional Monero payments through a view-only monero-wallet-rpc. The
// wallet holds the merchant's view key; Tekiya never stores it and the
// wallet cannot spend.

export const PICONERO_PER_XMR = 1_000_000_000_000;
// Funds become spendable after 10 blocks; earlier they count as pending.
export const XMR_CONFIRMATIONS = 10;
// Monero wallets look 200 subaddresses ahead; stay well inside that.
export const XMR_GAP_LIMIT = 150;

export type MoneroNetwork = "mainnet" | "stagenet";

export function moneroNetwork(network: NetworkName): MoneroNetwork {
  return network === "mainnet" ? "mainnet" : "stagenet";
}

export const MoneroSettings = z.object({
  enabled: z.boolean(),
  address: z.string(),
  network: z.enum(["mainnet", "stagenet"]),
  node: z.string(),
  account: z.number().int().min(1).max(49),
  restoreHeight: z.number().int().nonnegative(),
  walletFile: z.string(),
  walletPassword: z.string(),
  enabledAt: z.string(),
});

export type MoneroSettings = z.infer<typeof MoneroSettings>;

export const MONERO = "monero";

// Primary addresses: 4… on mainnet, 5… on stagenet; 95 base58 characters.
export function validatePrimaryAddress(
  address: string,
  network: MoneroNetwork,
): string {
  const value = address.trim();
  const prefix = network === "mainnet" ? "4" : "5";
  requireCondition(
    /^[1-9A-HJ-NP-Za-km-z]{95}$/.test(value) && value.startsWith(prefix),
    `Enter the wallet's primary ${network} address (95 characters, ` +
    `starting with ${prefix}), not a subaddress`,
  );
  return value;
}

export function validateViewKey(key: string): string {
  const value = key.trim().toLowerCase();
  requireCondition(
    /^[0-9a-f]{64}$/.test(value),
    "The private view key is 64 hexadecimal characters",
  );
  return value;
}

function isPrivateHost(host: string): boolean {
  if (host === "localhost" || host === "::1") return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) {
    return true;
  }
  const match = /^172\.(\d+)\./.exec(host);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  // Single-label names, such as a Compose service, are local.
  return /^[a-z0-9-]+$/i.test(host) && !host.includes(".");
}

/**
 * A node on a .onion address (reached through Tor) or on this machine or
 * private network. Stagenet also accepts clearnet nodes, as public test
 * nodes are mostly clearnet; they too are reached only through Tor.
 */
export function validateNode(
  value: string,
  network: MoneroNetwork,
): { address: string; viaTor: boolean } {
  const text = value.trim().replace(/\/+$/, "");
  const url = new URL(/^[a-z]+:\/\//.test(text) ? text : `http://${text}`);
  const example = network === "mainnet"
    ? "abc…xyz.onion:18081" : "stagenet.community.rino.io:38081";
  requireCondition(
    url.protocol === "http:" && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash,
    `Enter the node as host:port, for example ${example}`,
  );
  const onion = /^[a-z2-7]{56}\.onion$/.test(url.hostname);
  const local = !onion && isPrivateHost(url.hostname);
  requireCondition(
    onion || local || network === "stagenet",
    "Use a .onion node or one on your own machine or network",
  );
  const port = url.port || (network === "mainnet" ? "18081" : "38081");
  return { address: `${url.hostname}:${port}`, viaTor: !local };
}

export function parseXmrAmount(value: string): number {
  const text = value.trim();
  if (text === "") return 0;
  const match = /^(\d{1,4})(?:\.(\d{1,12}))?$/.exec(text);
  requireCondition(match, "Enter the amount as XMR, like 0.05");
  const atomic = Number(match[1]) * PICONERO_PER_XMR +
    Number((match[2] ?? "").padEnd(12, "0"));
  requireCondition(atomic <= 1000 * PICONERO_PER_XMR, "At most 1000 XMR");
  return atomic;
}

export function formatXmr(atomic: number): string {
  const whole = Math.floor(atomic / PICONERO_PER_XMR);
  const fraction = String(atomic % PICONERO_PER_XMR).padStart(12, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function moneroUri(address: string, atomic: number): string {
  return `monero:${address}` +
    (atomic ? `?tx_amount=${formatXmr(atomic)}` : "");
}

// --- JSON-RPC client ------------------------------------------------------

export class MoneroRpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

export type MoneroRpc = (method: string, params?: object) => Promise<unknown>;

function rpcUrl(): string {
  return process.env.NYM_MONERO_RPC ?? "http://monero-wallet:18083/json_rpc";
}

function rpcLogin(): string | undefined {
  const file = process.env.NYM_MONERO_RPC_LOGIN_FILE ??
    "/monero-secret/rpc-login";
  try {
    const login = readFileSync(file, "utf8").trim();
    return /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(login) ? login : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Calls the wallet over its private network with HTTP digest auth (curl
 * implements it). No proxy: the wallet is never reached through Tor.
 */
export const callWallet: MoneroRpc = (method, params = {}) => {
  const login = rpcLogin();
  const lines = [
    `url = ${JSON.stringify(rpcUrl())}`,
    'header = "Content-Type: application/json"',
    `data = ${JSON.stringify(JSON.stringify({
      jsonrpc: "2.0", id: "0", method, params,
    }))}`,
    ...(login ? ["digest", `user = ${JSON.stringify(login)}`] : []),
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "-q", "--noproxy", "*", "--proto", "=http",
      "--connect-timeout", "10", "--max-time", "120",
      "--max-filesize", "4194304",
      "--fail", "--silent", "--show-error", "--config", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("Unable to execute curl")));
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error("The Monero wallet service is not reachable"));
        return;
      }
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          result?: unknown;
          error?: { code: number; message: string };
        };
        if (body.error) {
          reject(new MoneroRpcError(body.error.code, body.error.message));
        } else {
          resolve(body.result);
        }
      } catch {
        reject(new Error("The Monero wallet returned invalid JSON"));
      }
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
};

// --- Wallet operations ----------------------------------------------------

async function setDaemon(
  rpc: MoneroRpc,
  node: string,
  network: MoneroNetwork,
): Promise<void> {
  const { address, viaTor } = validateNode(node, network);
  await rpc("set_daemon", {
    address,
    trusted: false,
    ssl_support: "disabled",
    // Remote nodes through the Tor container; local nodes directly.
    ...(viaTor ? { proxy: process.env.NYM_MONERO_PROXY ?? "tor:9050" } : {}),
  });
}

async function ensureAccount(rpc: MoneroRpc, account: number): Promise<void> {
  const Accounts = z.object({
    subaddress_accounts: z.array(z.object({ account_index: z.number() })),
  });
  let count = Accounts.parse(await rpc("get_accounts")).subaddress_accounts.length;
  while (count <= account) {
    await rpc("create_account", { label: count === account ? "Tekiya" : "" });
    count++;
  }
}

/**
 * Creates (or reopens) the view-only wallet from the merchant's address and
 * view key, points it at the node and prepares the dedicated account.
 */
export async function enableMonero(
  store: Store,
  network: NetworkName,
  input: {
    address: string;
    viewKey: string;
    node: string;
    restoreHeight?: number;
    account?: number;
  },
  rpc: MoneroRpc = callWallet,
): Promise<MoneroSettings> {
  const xmrNetwork = moneroNetwork(network);
  const address = validatePrimaryAddress(input.address, xmrNetwork);
  const viewKey = validateViewKey(input.viewKey);
  validateNode(input.node, xmrNetwork);
  const account = input.account ?? 1;
  requireCondition(
    Number.isInteger(account) && account >= 1 && account <= 49,
    "Account must be between 1 and 49",
  );

  const previous = store.get(MONERO, MoneroSettings);
  requireCondition(
    !previous || previous.address === address,
    "Monero was set up with another address. Disable it and start a " +
    "fresh installation to change wallets; issued subaddresses belong to it.",
  );

  const settings: MoneroSettings = {
    enabled: true,
    address,
    network: xmrNetwork,
    node: input.node.trim(),
    account,
    restoreHeight: input.restoreHeight ?? previous?.restoreHeight ?? 0,
    walletFile: previous?.walletFile ?? `tekiya-${randomBytes(4).toString("hex")}`,
    walletPassword: previous?.walletPassword ?? randomBytes(24).toString("hex"),
    enabledAt: previous?.enabledAt ?? new Date().toISOString(),
  };

  // The wallet must be open before anything else, the node included:
  // monero-wallet-rpc answers "No wallet file" otherwise.
  try {
    await rpc("generate_from_keys", {
      filename: settings.walletFile,
      address,
      viewkey: viewKey,
      password: settings.walletPassword,
      restore_height: settings.restoreHeight,
      autosave_current: true,
    });
  } catch (error) {
    // The wallet already exists from an earlier enable.
    if (!(error instanceof MoneroRpcError) || !/exist/i.test(error.message)) {
      throw error instanceof MoneroRpcError
        ? new Error(`The Monero wallet refused the keys: ${error.message}`)
        : error;
    }
    await rpc("open_wallet", {
      filename: settings.walletFile, password: settings.walletPassword,
    });
  }
  await setDaemon(rpc, settings.node, settings.network);

  const Address = z.object({ address: z.string() });
  requireCondition(
    Address.parse(await rpc("get_address", { account_index: 0 })).address ===
      address,
    "The Monero wallet opened a different address",
  );
  await ensureAccount(rpc, account);
  store.replace(MONERO, settings);
  return settings;
}

export function disableMonero(store: Store): void {
  const settings = store.get(MONERO, MoneroSettings);
  if (settings) store.replace(MONERO, { ...settings, enabled: false });
}

export function moneroSettings(store: Store): MoneroSettings | undefined {
  const settings = store.get(MONERO, MoneroSettings);
  return settings?.enabled ? settings : undefined;
}

// After a wallet service restart nothing is open; reopen on demand.
async function ensureOpen(rpc: MoneroRpc, settings: MoneroSettings) {
  try {
    await rpc("get_height");
  } catch (error) {
    if (!(error instanceof MoneroRpcError)) throw error;
    await rpc("open_wallet", {
      filename: settings.walletFile, password: settings.walletPassword,
    });
    await setDaemon(rpc, settings.node, settings.network);
  }
}

const allocating = new Map<string, Promise<XmrAllocation>>();

export function xmrBlocker(store: Store): string | undefined {
  if (!moneroSettings(store)) return "Monero is not enabled";
  if (store.xmrUnusedRun() >= XMR_GAP_LIMIT) {
    return `Monero paused: ${XMR_GAP_LIMIT} subaddresses in a row are unpaid`;
  }
  return undefined;
}

/**
 * One subaddress per request id, created once. A repeat with the same id
 * returns it; the same id with another amount is refused.
 */
export async function allocateMonero(
  store: Store,
  requestId: string,
  amountAtomic: number,
  rpc: MoneroRpc = callWallet,
): Promise<XmrAllocation> {
  requireCondition(
    /^[A-Za-z0-9_-]{16,128}$/.test(requestId),
    "Idempotency key must contain 16–128 letters, digits, _ or -",
  );
  requireCondition(
    Number.isSafeInteger(amountAtomic) && amountAtomic >= 0 &&
      amountAtomic <= 1000 * PICONERO_PER_XMR,
    "amountAtomic must be an integer from 0 through 1000 XMR",
  );
  const existing = store.findXmr(requestId);
  if (existing) {
    requireCondition(
      existing.amount_atomic === amountAtomic,
      "Idempotency key already used with a different amount",
    );
    return existing;
  }
  const running = allocating.get(requestId);
  if (running) return running;

  const task = (async () => {
    const blocker = xmrBlocker(store);
    if (blocker) throw new Unavailable(blocker);
    const settings = moneroSettings(store);
    requireCondition(settings, "Monero is not enabled");
    const created = await createSubaddress(settings, requestId, rpc);
    const allocation: XmrAllocation = {
      request_id: requestId,
      subaddr_index: created.index,
      address: created.address,
      amount_atomic: amountAtomic,
      created_at: new Date().toISOString(),
    };
    store.insertXmr(allocation);
    return allocation;
  })().finally(() => allocating.delete(requestId));
  allocating.set(requestId, task);
  return task;
}

/** Refreshes received totals for every issued subaddress. */
export async function syncMonero(
  store: Store,
  rpc: MoneroRpc = callWallet,
): Promise<MoneroRefresh | undefined> {
  const settings = moneroSettings(store);
  if (!settings) return undefined;
  const result = await refreshMonero(settings, store.xmrIndices(), rpc);
  for (const [index, value] of result.received) {
    store.recordXmrReceived(index, value.confirmed, value.pending);
  }
  return result;
}

export async function createSubaddress(
  settings: MoneroSettings,
  label: string,
  rpc: MoneroRpc = callWallet,
): Promise<{ index: number; address: string }> {
  await ensureOpen(rpc, settings);
  const created = z.object({
    address: z.string(),
    address_index: z.number().int().positive(),
  }).parse(await rpc("create_address", {
    account_index: settings.account, label,
  }));
  return { index: created.address_index, address: created.address };
}

const Transfer = z.object({
  amount: z.number().int().nonnegative(),
  confirmations: z.number().int().nonnegative().default(0),
  subaddr_index: z.object({ major: z.number(), minor: z.number() }),
});

export interface MoneroRefresh {
  readonly height: number;
  readonly received: Map<number, { confirmed: number; pending: number }>;
}

/** Totals received per issued subaddress, split at 10 confirmations. */
export async function refreshMonero(
  settings: MoneroSettings,
  indices: number[],
  rpc: MoneroRpc = callWallet,
): Promise<MoneroRefresh> {
  await ensureOpen(rpc, settings);
  const height = z.object({ height: z.number() })
    .parse(await rpc("get_height")).height;
  const received = new Map<number, { confirmed: number; pending: number }>(
    indices.map(index => [index, { confirmed: 0, pending: 0 }]),
  );
  if (indices.length === 0) return { height, received };

  const transfers = z.object({
    in: z.array(Transfer).default([]),
    pool: z.array(Transfer).default([]),
  }).parse(await rpc("get_transfers", {
    in: true, pool: true,
    account_index: settings.account,
    subaddr_indices: indices,
  }));
  for (const [list, pool] of [[transfers.in, false], [transfers.pool, true]] as const) {
    for (const transfer of list) {
      if (transfer.subaddr_index.major !== settings.account) continue;
      const entry = received.get(transfer.subaddr_index.minor);
      if (!entry) continue;
      if (!pool && transfer.confirmations >= XMR_CONFIRMATIONS) {
        entry.confirmed += transfer.amount;
      } else {
        entry.pending += transfer.amount;
      }
    }
  }
  return { height, received };
}
