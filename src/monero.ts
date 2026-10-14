import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
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

export const MONERO_RESERVATION = "monero-reservation";
export const MONERO_PENDING_SETUP = "monero-pending-setup";
const GENERATION = "monero-generation";
const HIGH_WATER = "monero-high-water";
const Owner = z.object({ host: z.string(), boot: z.string(), pid: z.number(), start: z.string() });
const Reservation = z.object({
  requestId: z.string(), amountAtomic: z.number(),
  token: z.string().optional(), owner: Owner.optional(),
  phase: z.enum(["read", "mutation"]).optional(), active: z.boolean().optional(),
  high: z.number().int().nonnegative().optional(),
});

function processStart(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}

function localOwner(): z.infer<typeof Owner> {
  // Minimal container images need not have a machine-id. Boot ID and PID
  // namespace still prevent comparing PIDs belonging to different containers.
  let machine = "";
  try { machine = readFileSync("/etc/machine-id", "utf8").trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return { host: `${hostname()}:${machine}:${readlinkSync("/proc/self/ns/pid")}`,
    boot: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    pid: process.pid, start: processStart(process.pid) };
}

function definitelyDead(owner: z.infer<typeof Owner> | undefined): boolean {
  if (!owner) return false;
  const local = localOwner();
  if (owner.host !== local.host) return false;
  if (owner.boot !== local.boot) return true;
  try { return processStart(owner.pid) !== owner.start; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
}

function transaction<T>(store: Store, action: () => T): T {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    store.db.exec("COMMIT");
    return result;
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
}

async function reserveWallet<T>(store: Store, requestId: string, amountAtomic: number,
  validate: () => T): Promise<{ token: string; value: T }> {
  const deadline = performance.now() + 130_000;
  const token = randomBytes(16).toString("hex");
  const owner = localOwner();
  for (;;) {
    const acquired = transaction(store, () => {
      const held = store.get(MONERO_RESERVATION, Reservation);
      if (held?.requestId === requestId) requireCondition(held.amountAtomic === amountAtomic,
        "Idempotency key already used with a different amount");
      if (held) {
        if (!held.owner || (held.phase !== "read" && (held.active === false || definitelyDead(held.owner)))) {
          throw new Unavailable("Monero wallet is reserved; explicit reconciliation required");
        }
        if (held.phase !== "read" || !definitelyDead(held.owner)) return undefined;
      }
      const value = validate();
      store.replace(MONERO_RESERVATION, { requestId, amountAtomic, token, owner,
        phase: "read", active: true });
      return { token, value };
    });
    if (acquired) return acquired;
    if (performance.now() >= deadline) throw new Unavailable("Monero wallet is reserved; timed out waiting");
    await delay(25);
  }
}

function finishWallet(store: Store, token: string, success = false): void {
  transaction(store, () => {
    const held = store.get(MONERO_RESERVATION, Reservation);
    requireCondition(held?.token === token, "Monero operation ownership changed");
    if (success || held.phase === "read") store.remove(MONERO_RESERVATION);
    else store.replace(MONERO_RESERVATION, { ...held, active: false });
  });
}

function mutateWallet(store: Store, token: string, high?: number): void {
  transaction(store, () => {
    const held = store.get(MONERO_RESERVATION, Reservation);
    requireCondition(held?.token === token, "Monero operation ownership changed");
    store.replace(MONERO_RESERVATION, { ...held, phase: "mutation", high });
  });
}

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
  requireCondition(input.restoreHeight === undefined ||
    (Number.isSafeInteger(input.restoreHeight) && input.restoreHeight >= 0),
  "Restore height must be a nonnegative safe integer");
  const { token, value: { previous, generation } } = await reserveWallet(store, "enable", 0, () => ({
    previous: configuredMoneroSettings(store), generation: store.get(GENERATION, z.string()),
  }));
  let success = false;
  try {
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

  // Preserve recovery credentials before any RPC can create a wallet file.
  store.replace(MONERO_PENDING_SETUP, { ...settings, enabled: false });
  mutateWallet(store, token);
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
    if (!(error instanceof MoneroRpcError) || error.code !== -1 ||
      error.message !== "Wallet already exists.") {
      // Only this known prevalidation failure is guaranteed not to create a file.
      if (error instanceof MoneroRpcError && error.code === -1 &&
        error.message === "Failed to verify view key secret key") {
        store.remove(MONERO_PENDING_SETUP);
        success = true;
        throw new Error(`The Monero wallet refused the keys: ${error.message}`);
      }
      throw error;
    }
    await rpc("open_wallet", {
      filename: settings.walletFile, password: settings.walletPassword,
    });
  }

  const Address = z.object({ address: z.string() });
  requireCondition(
    Address.parse(await rpc("get_address", { account_index: 0 })).address ===
      address,
    "The Monero wallet opened a different address",
  );
  await ensureAccount(rpc, account);
  await verifyWallet(store, rpc, settings);
  await rpc("store");
  transaction(store, () => {
    if (store.get(GENERATION, z.string()) !== generation) settings.enabled = false;
    store.replace(MONERO, settings);
    store.remove(MONERO_PENDING_SETUP);
  });
  success = true;
  return settings;
  } finally { finishWallet(store, token, success); }
}

export function disableMonero(store: Store): void {
  transaction(store, () => {
    store.replace(GENERATION, randomBytes(16).toString("hex"));
    const settings = store.get(MONERO, MoneroSettings);
    if (settings) store.replace(MONERO, { ...settings, enabled: false });
  });
}

export function moneroSettings(store: Store): MoneroSettings | undefined {
  const settings = configuredMoneroSettings(store);
  return settings?.enabled ? settings : undefined;
}

/** Configured wallet, including disabled issuance, for payment monitoring. */
export function configuredMoneroSettings(store: Store): MoneroSettings | undefined {
  return store.get(MONERO, MoneroSettings);
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
  }
}

async function verifyWallet(store: Store, rpc: MoneroRpc, settings: MoneroSettings): Promise<number> {
  await ensureOpen(rpc, settings);
  requireCondition(z.object({ address: z.string() }).parse(
    await rpc("get_address", { account_index: 0 })).address === settings.address,
  "The Monero wallet opened a different address");
  const addresses = z.object({ addresses: z.array(z.object({
    address_index: z.number().int().nonnegative(), address: z.string(),
  })).min(1) }).parse(await rpc("get_address", { account_index: settings.account })).addresses;
  const mapping = new Map(addresses.map(a => [a.address_index, a.address]));
  requireCondition(mapping.size === addresses.length, "Duplicate wallet address indices");
  for (const allocation of store.db.prepare("SELECT subaddr_index, address FROM xmr_allocations").all()) {
    requireCondition(mapping.get(Number(allocation.subaddr_index)) === allocation.address,
      "Monero wallet allocation mapping does not match; reconciliation required");
  }
  const high = Math.max(...mapping.keys());
  requireCondition(high >= (store.get(HIGH_WATER, z.number()) ?? 0),
    "Monero wallet lost reserved indices; reconciliation required");
  await setDaemon(rpc, settings.node, settings.network);
  return high;
}

/** Operator-only recovery. Stop every other Tekiya/wallet client first. Foreign
 * PID namespaces require that operator attestation; known-live local owners
 * are still rejected. Never recreates missing addresses. Unknown issued
 * indices are burned, not assigned to the failed request. Setup stays disabled.
 */
export async function recoverMonero(store: Store,
  options: { otherProcessesStopped: true }, rpc: MoneroRpc = callWallet): Promise<MoneroSettings> {
  requireCondition(options.otherProcessesStopped === true, "Stop other processes before reconciliation");
  const token = randomBytes(16).toString("hex");
  const { held, settings } = transaction(store, () => {
    const held = store.get(MONERO_RESERVATION, Reservation);
    requireCondition(held, "No Monero reservation to reconcile");
    requireCondition(held.owner && (held.active === false ||
      held.owner.host !== localOwner().host || definitelyDead(held.owner)),
      "Monero reservation owner may still be running; cannot reconcile");
    const settings = store.get(MONERO_PENDING_SETUP, MoneroSettings) ?? configuredMoneroSettings(store);
    requireCondition(settings, "Missing Monero recovery credentials");
    store.replace(MONERO_RESERVATION, { ...held, token, owner: localOwner(), active: true, phase: "mutation" });
    return { held, settings };
  });
  let success = false;
  try {
    const high = await verifyWallet(store, rpc, settings);
    requireCondition(held.high === undefined || high > held.high,
      "Uncertain allocation is not present in wallet; restore/reconcile wallet manually, do not clear reservation");
    await rpc("store");
    transaction(store, () => {
      store.replace(HIGH_WATER, high);
      if (store.get(MONERO_PENDING_SETUP, MoneroSettings)) {
        store.replace(MONERO, { ...settings, enabled: false });
        store.remove(MONERO_PENDING_SETUP);
      }
    });
    success = true;
    return configuredMoneroSettings(store)!;
  } finally { finishWallet(store, token, success); }
}

export function xmrBlocker(store: Store): string | undefined {
  if (!moneroSettings(store)) return "Monero is not enabled";
  const held = store.get(MONERO_RESERVATION, Reservation);
  if (held && held.phase !== "read" && held.active !== true) return "Monero wallet is reserved";
  if (xmrIndexGap(store) >= XMR_GAP_LIMIT) {
    return `Monero paused: ${XMR_GAP_LIMIT} subaddresses in a row are unpaid`;
  }
  return undefined;
}

function xmrIndexGap(store: Store, walletHigh = 0): number {
  const row = store.db.prepare(`
    SELECT COALESCE((SELECT MAX(subaddr_index) FROM xmr_allocations), 0) AS high,
      COALESCE((SELECT MAX(subaddr_index) FROM xmr_received
        WHERE confirmed_atomic > 0 OR pending_atomic > 0), 0) AS seen
  `).get()!;
  return Math.max(Number(row.high), walletHigh, store.get(HIGH_WATER, z.number()) ?? 0) - Number(row.seen);
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
  const committed = store.findXmr(requestId);
  if (committed) {
    requireCondition(committed.amount_atomic === amountAtomic,
      "Idempotency key already used with a different amount");
    return committed;
  }
  const { token, value: { existing, settings, generation } } = await reserveWallet(store, requestId, amountAtomic, () => {
    const existing = store.findXmr(requestId);
    if (existing) {
      requireCondition(existing.amount_atomic === amountAtomic,
        "Idempotency key already used with a different amount");
      return { existing };
    }
    const settings = moneroSettings(store);
    requireCondition(settings, "Monero is not enabled");
    if (xmrIndexGap(store) >= XMR_GAP_LIMIT) throw new Unavailable("Monero paused: subaddress index gap");
    return { existing, settings, generation: store.get(GENERATION, z.string()) };
  });
  let success = false;
  try {
    if (existing) return existing;
    const high = await verifyWallet(store, rpc, settings!);
    if (xmrIndexGap(store, high) >= XMR_GAP_LIMIT) {
      throw new Unavailable(`Monero paused: ${XMR_GAP_LIMIT} subaddress index gap`);
    }
    requireCondition(moneroSettings(store) && store.get(GENERATION, z.string()) === generation,
      "Monero was disabled during allocation");
    mutateWallet(store, token, high);
    const created = await createSubaddress(settings!, requestId, rpc);
    requireCondition(created.index > high, "Monero wallet recycled a subaddress index");
    if (xmrIndexGap(store, created.index) > XMR_GAP_LIMIT) {
      throw new Unavailable("Monero wallet skipped beyond the subaddress gap; reconcile reservation");
    }
    const allocation: XmrAllocation = {
      request_id: requestId,
      subaddr_index: created.index,
      address: created.address,
      amount_atomic: amountAtomic,
      created_at: new Date().toISOString(),
    };
    store.insertXmr(allocation);
    success = true;
    requireCondition(moneroSettings(store) && store.get(GENERATION, z.string()) === generation,
      "Monero was disabled during allocation");
    return allocation;
  } finally { finishWallet(store, token, success); }
}

/** Refreshes received totals for every issued subaddress. */
export async function syncMonero(
  store: Store,
  rpc: MoneroRpc = callWallet,
): Promise<MoneroRefresh | undefined> {
  const { token, value: settings } = await reserveWallet(store, "refresh", 0,
    () => configuredMoneroSettings(store));
  try {
    if (!settings) return undefined;
    await verifyWallet(store, rpc, settings);
    const result = await refreshMonero(settings, store.xmrIndices(), rpc);
    for (const [index, value] of result.received) {
      store.recordXmrReceived(index, value.confirmed, value.pending);
    }
    return result;
  } finally {
    // Refresh creates no accounts or addresses, so a failed read is retryable.
    finishWallet(store, token);
  }
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
  await rpc("store");
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
