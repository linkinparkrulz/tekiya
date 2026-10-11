import { randomBytes } from "node:crypto";
import { Transaction } from "bitcoinjs-lib";
import { z } from "zod";
import {
  Approval, Config, NetworkName, Pairing, Pending,
  onionUrl, requireCondition,
} from "./config.js";
import {
  buildNotification, createWallet, deriveAddress, receiver, reconstruct,
  verifyIdentity,
} from "./bitcoin.js";
import { syncDojo, type DojoApi } from "./registrar.js";
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
  const code = merchantCode.trim();
  try {
    receiver(code, network);
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
  const api = await connectDojo(pairing, config.network);
  const replaced = Boolean(store.get("pairing", Pairing));
  store.replacePairing(pairing);
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
  readonly feeRate: number | undefined;
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
    feeRate: fees["6"] ?? fees["4"] ?? fees["2"],
  };
}

// The notification transaction is about 236 vB; builder limits apply.
export const NOTIFICATION_VBYTES = 237;
export const MAX_FUNDING_SATS = 1000000;

export function suggestFee(feeRate: number | undefined): number {
  const rate = Math.max(1, feeRate ?? 1);
  return Math.min(10000, Math.max(200, Math.ceil(rate * NOTIFICATION_VBYTES)));
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
  store.insert("notification", pending);
  return pending;
}

const Broadcast = z.object({ txid: z.string(), at: z.string() });

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
  const { confirmations } = await notificationStatus(api, pending);
  requireCondition(
    confirmations > 0,
    "The notification transaction is not confirmed yet",
  );
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
}

export function connectPaired(store: Store, config: Config): Promise<DojoApi> {
  const pairing = store.get("pairing", Pairing);
  requireCondition(pairing, "Connect a Dojo first");
  return connectDojo(pairing, config.network);
}
