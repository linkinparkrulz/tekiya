import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Unavailable, requireCondition, type NetworkName } from "./config.js";
import {
  decodePrimaryAddress, deriveSubaddress, viewKeyMatches, type PrimaryAddress,
} from "./monero-address.js";
import { Store, type XmrAllocation } from "./store.js";

// Optional Monero payments. Tekiya derives each payment's subaddress itself
// from the merchant's primary address and view key; nothing is created in a
// wallet. A view-only monero-wallet-rpc only watches the chain and reports
// what those subaddresses received. Neither can spend.

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
  // Missing on installations set up before Tekiya derived subaddresses.
  viewKey: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  restoreHeight: z.number().int().nonnegative(),
  walletFile: z.string(),
  walletPassword: z.string(),
  enabledAt: z.string(),
});

export type MoneroSettings = z.infer<typeof MoneroSettings>;

export const MONERO = "monero";
// The watch wallet's file name and password, kept from the first attempt so
// a retried setup reopens the same wallet instead of creating another.
const MONERO_SETUP = "monero-setup";
const WalletNames = z.object({
  address: z.string(), walletFile: z.string(), walletPassword: z.string(),
});

function transaction<T>(store: Store, action: () => T): T {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    store.db.exec("COMMIT");
    return result;
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

// Primary addresses: 4… on mainnet, 5… on stagenet; 95 base58 characters.
export function validatePrimaryAddress(
  address: string,
  network: MoneroNetwork,
): string {
  const value = address.trim();
  const prefix = network === "mainnet" ? "4" : "5";
  requireCondition(
    /^[1-9A-HJ-NP-Za-km-z]{95}$/.test(value) && value.startsWith(prefix) &&
      decodePrimaryAddress(value, network),
    `Enter the wallet's primary ${network} address (95 characters, ` +
    `starting with ${prefix}), not a subaddress; check for typos`,
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

export class MoneroRpcError extends Unavailable {
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
    child.on("error", () => reject(new Unavailable("Unable to execute curl")));
    child.on("close", code => {
      if (code !== 0) {
        reject(new Unavailable("The Monero wallet service is not reachable"));
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
        reject(new Unavailable("The Monero wallet returned invalid JSON"));
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

// The dedicated account must exist for the wallet to report its transfers.
// Creating it is part of setup only; issuing addresses changes nothing.
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

function derive(settings: MoneroSettings, primary: PrimaryAddress, index: number): string {
  requireCondition(settings.viewKey, "Re-enter the Monero view key");
  return deriveSubaddress(primary, settings.viewKey, settings.account, index, settings.network);
}

function primaryOf(settings: MoneroSettings): PrimaryAddress {
  const primary = decodePrimaryAddress(settings.address, settings.network);
  requireCondition(primary, "The stored Monero address is not valid");
  return primary;
}

/**
 * The wallet must recognize a subaddress before it is handed out, or a
 * payment to it would go unseen. This also checks Tekiya's derivation
 * against the wallet's own.
 */
async function requireWatched(
  rpc: MoneroRpc,
  settings: MoneroSettings,
  index: number,
  address: string,
): Promise<void> {
  let result: unknown;
  try {
    result = await rpc("get_address_index", { address });
  } catch (error) {
    if (!(error instanceof MoneroRpcError)) throw error;
    throw new Unavailable(
      `The Monero wallet does not watch subaddress ${index} yet; ` +
      "it will once earlier payments confirm",
    );
  }
  const { major, minor } = z.object({
    index: z.object({ major: z.number(), minor: z.number() }),
  }).parse(result).index;
  requireCondition(
    major === settings.account && minor === index,
    `The Monero wallet places subaddress ${index} at ${major}/${minor}; ` +
    "the view key or wallet does not match",
  );
}

/**
 * Sets up the view-only watch wallet from the merchant's address and view
 * key (or reopens it), points it at the node and checks that it sees the
 * subaddresses Tekiya derives.
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
  const primary = decodePrimaryAddress(address, xmrNetwork)!;
  requireCondition(
    viewKeyMatches(primary, viewKey),
    "This private view key does not belong to that address",
  );
  validateNode(input.node, xmrNetwork);
  requireCondition(input.restoreHeight === undefined ||
    (Number.isSafeInteger(input.restoreHeight) && input.restoreHeight >= 0),
  "Restore height must be a nonnegative safe integer");

  const previous = configuredMoneroSettings(store);
  const account = input.account ?? previous?.account ?? 1;
  requireCondition(
    Number.isInteger(account) && account >= 1 && account <= 49,
    "Account must be between 1 and 49",
  );
  requireCondition(!previous || previous.account === account,
    "Monero account cannot change after setup");
  requireCondition(
    !previous || (previous.address === address && previous.network === xmrNetwork),
    "Monero was set up with another address. Disable it and start a " +
    "fresh installation to change wallets; issued subaddresses belong to it.",
  );

  const names = store.get(MONERO_SETUP, WalletNames);
  const reuse = previous ?? (names?.address === address ? names : undefined);
  const settings: MoneroSettings = {
    enabled: true,
    address,
    network: xmrNetwork,
    node: input.node.trim(),
    account,
    viewKey,
    restoreHeight: input.restoreHeight ?? previous?.restoreHeight ?? 0,
    walletFile: reuse?.walletFile ?? `tekiya-${randomBytes(4).toString("hex")}`,
    walletPassword: reuse?.walletPassword ?? randomBytes(24).toString("hex"),
    enabledAt: previous?.enabledAt ?? new Date().toISOString(),
  };
  // Every address issued so far must be what these keys derive.
  for (const row of store.db.prepare(
    "SELECT subaddr_index, address FROM xmr_allocations",
  ).all()) {
    requireCondition(
      derive(settings, primary, Number(row.subaddr_index)) === row.address,
      "These keys do not derive the Monero addresses already issued",
    );
  }
  if (!previous) {
    store.replace(MONERO_SETUP, {
      address, walletFile: settings.walletFile, walletPassword: settings.walletPassword,
    });
  }

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
    // The wallet already exists from an earlier attempt.
    if (!(error instanceof MoneroRpcError) || !/already exists/i.test(error.message)) {
      throw error instanceof MoneroRpcError
        ? new Error(`The Monero wallet refused the keys: ${error.message}`)
        : error;
    }
    await rpc("open_wallet", {
      filename: settings.walletFile, password: settings.walletPassword,
    });
  }
  await checkIdentity(rpc, settings);
  await setDaemon(rpc, settings.node, settings.network);
  await ensureAccount(rpc, account);
  const next = nextXmrIndex(store);
  await requireWatched(rpc, settings, next, derive(settings, primary, next));
  await rpc("store");

  store.replace(MONERO, settings);
  store.remove(MONERO_SETUP);
  return settings;
}

export function disableMonero(store: Store): void {
  const settings = store.get(MONERO, MoneroSettings);
  if (settings) store.replace(MONERO, { ...settings, enabled: false });
}

export function moneroSettings(store: Store): MoneroSettings | undefined {
  const settings = configuredMoneroSettings(store);
  return settings?.enabled ? settings : undefined;
}

/** Configured wallet, including disabled issuance, for payment monitoring. */
export function configuredMoneroSettings(store: Store): MoneroSettings | undefined {
  return store.get(MONERO, MoneroSettings);
}

async function checkIdentity(rpc: MoneroRpc, settings: MoneroSettings): Promise<void> {
  requireCondition(
    z.object({ address: z.string() }).parse(
      await rpc("get_address", { account_index: 0 }),
    ).address === settings.address,
    "The Monero wallet opened a different address",
  );
}

// After a wallet service restart nothing is open; reopen on demand.
async function ensureOpen(rpc: MoneroRpc, settings: MoneroSettings) {
  try {
    await rpc("get_height");
  } catch (error) {
    if (!(error instanceof MoneroRpcError) || error.code !== -13) throw error;
    await rpc("open_wallet", {
      filename: settings.walletFile, password: settings.walletPassword,
    });
    await checkIdentity(rpc, settings);
    await setDaemon(rpc, settings.node, settings.network);
  }
}

function nextXmrIndex(store: Store): number {
  const row = store.db.prepare(
    "SELECT COALESCE(MAX(subaddr_index), 0) AS high FROM xmr_allocations",
  ).get()!;
  return Number(row.high) + 1;
}

export function xmrBlocker(store: Store): string | undefined {
  const settings = moneroSettings(store);
  if (!settings) return "Monero is not enabled";
  if (!settings.viewKey) {
    return "Re-enter the view key under Monero in the dashboard to keep issuing";
  }
  if (xmrIndexGap(store) >= XMR_GAP_LIMIT) {
    return `Monero paused: ${XMR_GAP_LIMIT} subaddresses in a row are unpaid`;
  }
  return undefined;
}

function xmrIndexGap(store: Store): number {
  const row = store.db.prepare(`
    SELECT COALESCE(MAX(subaddr_index), 0) AS seen FROM xmr_received
    WHERE confirmed_atomic > 0 OR pending_atomic > 0
  `).get()!;
  return nextXmrIndex(store) - 1 - Number(row.seen);
}

/**
 * One subaddress per request id, derived from the next unused index. A
 * repeat with the same id returns it; the same id with another amount is
 * refused. The wallet is only asked whether it watches the address.
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
  const existing = (): XmrAllocation | undefined => {
    const found = store.findXmr(requestId);
    if (found) {
      requireCondition(found.amount_atomic === amountAtomic,
        "Idempotency key already used with a different amount");
    }
    return found;
  };
  const found = existing();
  if (found) return found;

  // Concurrent requests may pick the same index; the later one tries again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const blocker = xmrBlocker(store);
    if (blocker) throw new Unavailable(blocker);
    const settings = moneroSettings(store)!;
    const index = nextXmrIndex(store);
    const address = derive(settings, primaryOf(settings), index);
    await ensureOpen(rpc, settings);
    await requireWatched(rpc, settings, index, address);

    const allocation = transaction(store, () => {
      const found = existing();
      if (found) return found;
      if (nextXmrIndex(store) !== index) return undefined;
      const blocker = xmrBlocker(store);
      if (blocker) throw new Unavailable(blocker);
      const allocation: XmrAllocation = {
        request_id: requestId,
        subaddr_index: index,
        address,
        amount_atomic: amountAtomic,
        created_at: new Date().toISOString(),
      };
      store.insertXmr(allocation);
      return allocation;
    });
    if (allocation) return allocation;
  }
  throw new Unavailable("Monero issuance is busy; try again");
}

/** Refreshes received totals for every issued subaddress. */
export async function syncMonero(
  store: Store,
  rpc: MoneroRpc = callWallet,
): Promise<MoneroRefresh | undefined> {
  const settings = configuredMoneroSettings(store);
  if (!settings) return undefined;
  const result = await refreshMonero(settings, store.xmrIndices(), rpc);
  for (const [index, value] of result.received) {
    store.recordXmrReceived(index, value.confirmed, value.pending);
  }
  return result;
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
