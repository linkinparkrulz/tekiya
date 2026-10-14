import { randomBytes } from "node:crypto";
import { Transaction } from "bitcoinjs-lib";
import { z } from "zod";
import {
  Approval, Config, NetworkName, Pairing, Pending,
  onionUrl, requireCondition,
} from "./config.js";
import { MAX_FEE_RATE, NOTIFICATION_SATS } from "./bitcoin.js";
import {
  buildNotification, createWallet, deriveAddress, receiver, reconstruct,
  segwitCode, verifyIdentity,
} from "./bitcoin.js";
import { assertPairedClient, pairingGeneration, syncDojo, type DojoApi } from "./registrar.js";
import { Store, type Allocation } from "./store.js";
import { connectDojo } from "./tor.js";

// Setup steps shared by the CLI and the operator dashboard.

export function initialize(
  store: Store,
  network: NetworkName,
  merchantCode: string,
  onion: string,
): Config {
  requireCondition(
    !store.get("config", Config),
    "Installation already initialized; replacement refused",
  );
  let code: string;
  try {
    code = segwitCode(merchantCode.trim(), network);
  } catch {
    throw new Error("That is not a valid BIP47 payment code");
  }
  const config: Config = {
    network,
    merchantCode: code,
    onion: onionUrl(normalizeOnion(onion), true).origin,
    seedHex: randomBytes(64).toString("hex"),
    apiToken: randomBytes(32).toString("hex"),
  };
  store.insert("config", config);
  return config;
}

export const REAPPROVAL_NOTICE = "reapproval-notice";

/**
 * Installations created before merchant codes were stored in SegWit form
 * switch to it. The approval signed a statement naming the old code, so it
 * is withdrawn and the dashboard asks for one new signature.
 */
export function migrateMerchantCode(store: Store): boolean {
  const config = store.get("config", Config);
  if (!config) return false;
  const code = segwitCode(config.merchantCode, config.network);
  if (code === config.merchantCode) return false;
  store.db.exec("BEGIN IMMEDIATE");
  try {
    store.replace("config", { ...config, merchantCode: code });
    if (store.remove("approval")) {
      store.replace(REAPPROVAL_NOTICE, {
        reason: "Your merchant payment code is now stored in its SegWit " +
          "form, so the approval text changed. Sign it once more.",
      });
    }
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

// Accepts "abc…xyz.onion", with or without http:// and a trailing slash.
export function normalizeOnion(value: string): string {
  const text = value.trim().replace(/\/+$/, "");
  return /^[a-z]+:\/\//.test(text) ? text : `http://${text}`;
}

const DojoExport = z.object({
  pairing: z.object({
    apikey: z.string().min(1).max(4096),
    url: z.string(),
  }),
});

/**
 * Reads a pairing in Tekiya's form or as exported by Dojo's maintenance
 * tool. Dojo serves testnet under /test/, which sets the network label.
 */
export function parsePairing(text: string, network: NetworkName): Pairing {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The pairing is not valid JSON");
  }

  const exported = DojoExport.safeParse(value);
  const pairing = exported.success
    ? Pairing.parse({
      network: new URL(exported.data.pairing.url).pathname
        .startsWith("/test/") ? "testnet4" : "mainnet",
      baseUrl: exported.data.pairing.url,
      apikey: exported.data.pairing.apikey,
    })
    : Pairing.parse(value);

  requireCondition(
    pairing.network === network,
    `This Dojo pairing is for ${pairing.network}; this installation is ` +
    `${network}`,
  );
  return pairing;
}

export async function pairDojo(
  store: Store,
  config: Config,
  pairing: Pairing,
): Promise<{ api: DojoApi; replaced: boolean }> {
  const before = pairingGeneration(store);
  await connectDojo(pairing, config.network);
  requireCondition(pairingGeneration(store) === before, "Dojo pairing changed during login");
  const replaced = Boolean(store.get("pairing", Pairing));
  store.replacePairing(pairing);
  const api = await connectPaired(store, config);
  return { api, replaced };
}

const FundingResponse = z.object({
  info: z.object({
    fees: z.record(z.string(), z.number()).optional(),
  }).optional(),
  unspent_outputs: z.array(z.object({
    tx_hash: z.string().regex(/^[0-9a-f]{64}$/),
    tx_output_n: z.number().int().nonnegative(),
    value: z.number().int().positive(),
    confirmations: z.number().int().nonnegative().default(0),
    addr: z.string().nullish(),
  })).default([]),
});

export interface FundingUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly value: number;
  readonly confirmations: number;
}

export interface FundingObservation {
  readonly utxos: FundingUtxo[];
  // Dojo's estimates in sat/vB, keyed by target blocks ("2", "6", "24"…).
  readonly fees: Record<string, number>;
}

export async function observeFunding(
  config: Config,
  api: DojoApi,
): Promise<FundingObservation> {
  const address = createWallet(config.seedHex, config.network).fundingAddress;
  const response = FundingResponse.parse(
    await api("wallet", { active: address }),
  );
  const fees = response.info?.fees ?? {};
  return {
    utxos: response.unspent_outputs
      .filter(utxo => !utxo.addr || utxo.addr === address)
      .map(utxo => ({
        txid: utxo.tx_hash,
        vout: utxo.tx_output_n,
        value: utxo.value,
        confirmations: utxo.confirmations,
      })),
    fees,
  };
}

export const MAX_FUNDING_SATS = 1000000;

// Never below this, whatever the estimates say; matched when they are higher.
export const MIN_FEE_RATE = 25;

export type FeePresetId = "economy" | "standard" | "priority";

export interface FeePreset {
  readonly id: FeePresetId;
  readonly label: string;
  readonly hint: string;
  readonly rate: number;
}

/** Fee choices from the Dojo's estimates, each at least MIN_FEE_RATE. */
export function feePresets(fees: Record<string, number> = {}): FeePreset[] {
  const floor = (value: number | undefined) =>
    Math.min(MAX_FEE_RATE, Math.max(MIN_FEE_RATE,
      Math.ceil(Number.isFinite(value) ? value! : 0)));
  const economy = floor(fees["24"] ?? fees["12"] ?? fees["6"]);
  const standard = Math.max(economy, floor(fees["6"] ?? fees["4"]));
  const priority = Math.min(MAX_FEE_RATE, Math.max(
    floor(fees["2"]), Math.ceil(standard * 1.5),
  ));
  return [
    { id: "economy", label: "Economy", hint: "within a day", rate: economy },
    { id: "standard", label: "Standard", hint: "about an hour", rate: standard },
    { id: "priority", label: "Priority", hint: "next blocks", rate: priority },
  ];
}

export const FEE_CHOICE = "fee-choice";

export const FeeChoice = z.object({
  preset: z.enum(["economy", "standard", "priority", "custom"]),
  customRate: z.number().int().min(MIN_FEE_RATE).max(MAX_FEE_RATE).optional(),
}).refine(choice => choice.preset !== "custom" || choice.customRate !== undefined,
  "Custom fee requires a rate");

export type FeeChoice = z.infer<typeof FeeChoice>;

export function chosenRate(
  choice: FeeChoice | undefined,
  fees: Record<string, number> = {},
): number {
  if (choice) FeeChoice.parse(choice);
  if (choice?.preset === "custom" && choice.customRate) return choice.customRate;
  const presets = feePresets(fees);
  return (presets.find(preset => preset.id === (choice?.preset ?? "standard"))
    ?? presets[1])?.rate ?? MIN_FEE_RATE;
}

/**
 * Virtual size of this installation's notification transaction, measured by
 * building one from a stand-in funding output. Signatures vary by a byte,
 * so one vbyte of margin is added.
 */
export function notificationVbytes(config: Config, withChange: boolean): number {
  const wallet = createWallet(config.seedHex, config.network);
  const value = withChange ? 100000 : NOTIFICATION_SATS + 300;
  const funding = new Transaction();
  funding.addInput(Buffer.alloc(32, 1), 0);
  funding.addOutput(wallet.fundingScript, BigInt(value));
  const built = buildNotification(config, funding.toHex(), 0, 300);
  return Transaction.fromHex(built.hex).virtualSize() + 1;
}

/** The exact funding that pays the notification at this rate, no change. */
export function fundingRequired(config: Config, rate: number): number {
  return NOTIFICATION_SATS +
    Math.ceil(rate * notificationVbytes(config, false));
}

/**
 * The fee in sats for a funding output of this value at this rate. Without
 * change the whole remainder is fee, so the rate only sets a minimum.
 */
export function feeForRate(config: Config, value: number, rate: number): number {
  const withChange = Math.ceil(rate * notificationVbytes(config, true));
  if (value - NOTIFICATION_SATS - withChange >= 330) return withChange;
  const without = Math.ceil(rate * notificationVbytes(config, false));
  requireCondition(
    value - NOTIFICATION_SATS >= without,
    `The funding covers at most ${Math.floor(
      (value - NOTIFICATION_SATS) / notificationVbytes(config, false),
    )} sat/vB; send more or choose a lower fee`,
  );
  return value - NOTIFICATION_SATS;
}

// The output the dashboard offers for funding: confirmed and within limits.
export function usableFunding(utxos: FundingUtxo[]): FundingUtxo | undefined {
  return utxos
    .filter(utxo => utxo.confirmations > 0 && utxo.value <= MAX_FUNDING_SATS)
    .sort((a, b) => b.value - a.value)[0];
}

const ObservedTransaction = z.object({
  hex: z.string().max(800000).regex(/^(?:[0-9a-fA-F]{2})+$/),
  confirmations: z.number().int().nonnegative().default(0),
});

async function fetchTransaction(api: DojoApi, txid: string) {
  const observed = ObservedTransaction.parse(
    await api(`tx/${txid}?rawHex=1`),
  );
  requireCondition(
    Transaction.fromHex(observed.hex).getId() === txid,
    "Backend returned the wrong transaction",
  );
  return observed;
}

export async function prepareNotification(
  store: Store,
  config: Config,
  api: DojoApi,
  txid: string,
  vout: number,
  feeSats: number,
): Promise<Pending> {
  assertPairedClient(store, api);
  const generation = pairingGeneration(store);
  requireCondition(
    !store.get("notification", Pending),
    "Notification already exists; refusing a second setup transaction",
  );
  requireCondition(/^[0-9a-f]{64}$/.test(txid), "Invalid funding txid");
  const previous = await fetchTransaction(api, txid);
  requireCondition(
    previous.confirmations > 0,
    "The funding transaction is not confirmed yet",
  );
  const pending = buildNotification(config, previous.hex, vout, feeSats);
  requireCondition(pending.feeRate >= MIN_FEE_RATE,
    `The fee is below ${MIN_FEE_RATE} sat/vB`);
  const funding = await observeFunding(config, api);
  const matches = funding.utxos.filter(utxo => utxo.txid === txid && utxo.vout === vout);
  requireCondition(matches.length === 1 && matches[0]!.confirmations > 0 &&
    matches[0]!.value <= MAX_FUNDING_SATS &&
    BigInt(matches[0]!.value) === Transaction.fromHex(previous.hex).outs[vout]?.value,
  "Funding output is no longer confirmed and unspent, or its value differs");
  requireCondition(pairingGeneration(store) === generation, "Dojo pairing changed during preparation");
  store.insert("notification", pending);
  return pending;
}

const Broadcast = z.object({ txid: z.string(), at: z.string() });

const Confirmed = z.object({ txid: z.string(), at: z.string() });

/**
 * Whether the notification is known to be confirmed, without asking the
 * Dojo: recorded when first seen confirmed, and implied by later setup
 * steps, which all required it. Setup never goes backwards on a restart
 * while the Dojo is unreachable.
 */
export function notificationConfirmed(store: Store): boolean {
  const pending = store.get("notification", Pending);
  if (!pending) return false;
  return store.get("notification-confirmed", Confirmed)?.txid === pending.txid ||
    store.findAllocation(TEST_REQUEST_ID) !== undefined ||
    store.get("approval", Approval) !== undefined;
}

export function recordNotificationConfirmed(store: Store): void {
  const pending = store.get("notification", Pending);
  if (pending && !notificationConfirmed(store)) {
    store.replace("notification-confirmed", {
      txid: pending.txid, at: new Date().toISOString(),
    });
  }
}

export function broadcastRecorded(store: Store): boolean {
  const pending = store.get("notification", Pending);
  return Boolean(pending &&
    store.get("broadcast", Broadcast)?.txid === pending.txid);
}

export async function broadcastNotification(
  store: Store,
  config: Config,
  api: DojoApi,
): Promise<string> {
  const pending = store.get("notification", Pending);
  requireCondition(pending, "Prepare a notification first");
  reconstruct(config, pending);
  try {
    const response = z.object({
      status: z.literal("ok"),
      data: z.string(),
    }).parse(await api("pushtx/", { tx: pending.hex }));
    requireCondition(
      response.data === pending.txid,
      "Backend acknowledged an unexpected transaction ID",
    );
  } catch (error) {
    // A repeated broadcast is rejected once the transaction is known.
    const known = await notificationStatus(api, pending).catch(() => undefined);
    if (!known) throw error;
  }
  store.replace("broadcast", {
    txid: pending.txid,
    at: new Date().toISOString(),
  });
  return pending.txid;
}

// Throws when the backend cannot show the transaction.
export async function notificationStatus(
  api: DojoApi,
  pending: Pending,
): Promise<{ confirmations: number }> {
  const observed = await fetchTransaction(api, pending.txid);
  return { confirmations: observed.confirmations };
}

export async function confirmedNotification(
  store: Store,
  config: Config,
  api: DojoApi,
): Promise<Pending> {
  const pending = store.get("notification", Pending);
  requireCondition(pending, "Prepare a notification first");
  reconstruct(config, pending);
  const { confirmations } = await recordNotificationStatus(store, api, pending);
  requireCondition(
    confirmations > 0,
    "The notification transaction is not confirmed yet",
  );
  recordNotificationConfirmed(store);
  return pending;
}

export const TEST_REQUEST_ID = "setup_compatibility_test";

export async function issueTestAddress(
  store: Store,
  config: Config,
  api: DojoApi,
): Promise<Allocation> {
  await confirmedNotification(store, config, api);
  await syncDojo(store, config, api);
  // Reserved locally so the compatibility test cannot cause reuse.
  return store.allocate(
    TEST_REQUEST_ID, 0, index => deriveAddress(config, index),
  );
}

/**
 * Accepts a bare base64 signature or a wallet's full signed-message block
 * ("-----BEGIN BITCOIN SIGNED MESSAGE-----" … "-----END BITCOIN SIGNATURE-----").
 */
export function extractSignature(input: string, expectedAddress: string): string {
  const text = input.trim();
  const armor = /-----BEGIN BITCOIN SIGNATURE-----([\s\S]*?)-----END BITCOIN SIGNATURE-----/
    .exec(text);
  if (!armor) return text;

  const lines = (armor[1] ?? "").split(/\r?\n/).map(line => line.trim())
    .filter(Boolean);
  const address = lines.find(line => /^Address:/i.test(line))
    ?.replace(/^Address:\s*/i, "");
  requireCondition(
    address === undefined || address === expectedAddress,
    `The message was signed with ${address}; sign it with your PayNym ` +
    `notification address ${expectedAddress}`,
  );
  const signature = lines.filter(line => !/^[A-Za-z-]+:/.test(line)).join("");
  requireCondition(signature, "No signature found in the signed message");
  return signature;
}

export function approve(
  store: Store,
  config: Config,
  pending: Pending,
  input: string,
): void {
  const address = receiver(config.merchantCode, config.network)
    .getNotificationAddress();
  const text = extractSignature(input, address);
  requireCondition(
    verifyIdentity(config, pending, text),
    "The signature does not match the approval text. Sign the exact text " +
    `shown, unchanged, with your PayNym notification address ${address}.`,
  );
  requireCondition(!store.get("approval", Approval), "Already approved");
  store.insert("approval", {
    txid: pending.txid,
    signature: text,
    createdAt: new Date().toISOString(),
  });
  store.remove(REAPPROVAL_NOTICE);
}

export async function connectPaired(store: Store, config: Config): Promise<DojoApi> {
  const pairing = store.get("pairing", Pairing);
  requireCondition(pairing, "Connect a Dojo first");
  const generation = pairingGeneration(store);
  const api = await connectDojo(pairing, config.network, generation);
  assertPairedClient(store, api);
  return api;
}

export const NOTIFICATION_HEALTH = "notification-health";
export const NotificationHealth = z.object({
  txid: z.string(), pairingGeneration: z.string(),
  confirmations: z.number().int().nonnegative(), checkedAt: z.string(),
});

export function cachedConfirmedNotification(store: Store, config: Config): Pending {
  const pending = store.get("notification", Pending);
  requireCondition(pending, "Prepare a notification first");
  reconstruct(config, pending);
  const health = store.get(NOTIFICATION_HEALTH, NotificationHealth);
  const age = health ? Date.now() - Date.parse(health.checkedAt) : NaN;
  requireCondition(
    health && health.txid === pending.txid &&
      health.pairingGeneration === store.pairingGeneration() &&
      health.confirmations > 0 && Number.isFinite(age) &&
      age >= 0 && age <= 10 * 60 * 1000,
    "Notification verification pending; waiting for the Dojo",
  );
  return pending;
}

/** Monitor must call this instead of notificationStatus and gate health on freshness. */
export async function recordNotificationStatus(store: Store, api: DojoApi, pending: Pending) {
  assertPairedClient(store, api);
  const generation = pairingGeneration(store);
  const revision = store.get("notification-health-revision", z.number().int()) ?? 0;
  const status = await notificationStatus(api, pending);
  store.db.exec("BEGIN IMMEDIATE");
  try {
    requireCondition(pairingGeneration(store) === generation &&
      (store.get("notification-health-revision", z.number().int()) ?? 0) === revision &&
      store.get("notification", Pending)?.txid === pending.txid,
    "Notification observation is stale; results rejected");
    store.replace(NOTIFICATION_HEALTH, {
      txid: pending.txid, pairingGeneration: generation,
      confirmations: status.confirmations, checkedAt: new Date().toISOString(),
    });
    store.replace("notification-health-revision", revision + 1);
    if (status.confirmations > 0) recordNotificationConfirmed(store);
    store.db.exec("COMMIT");
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
  return status;
}
