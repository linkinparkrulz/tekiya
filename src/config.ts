import { networks, type Network } from "bitcoinjs-lib";
import { z } from "zod";
import type { Store } from "./store.js";

export const NetworkName = z.enum(["mainnet", "testnet4"]);
export type NetworkName = z.infer<typeof NetworkName>;

export interface NetworkProfile {
  readonly id: NetworkName;
  readonly coinType: 0 | 1;
  readonly bitcoin: Network;
}

export const profiles: Record<NetworkName, NetworkProfile> = {
  mainnet: {
    id: "mainnet",
    coinType: 0,
    bitcoin: networks.bitcoin,
  },
  testnet4: {
    id: "testnet4",
    coinType: 1,
    // Testnet4 shares these address and extended-key parameters.
    bitcoin: networks.testnet,
  },
};

export const ISSUANCE_LIMIT = 5;

export const PublicPayments = z.object({ enabled: z.boolean() });

// A saved choice takes precedence over the legacy environment opt-in.
export function publicPaymentsEnabled(store?: Pick<Store, "get">): boolean {
  return store?.get("public-payments", PublicPayments)?.enabled ??
    (process.env.NYM_PUBLIC_PAYMENTS === "true");
}

// Indices registered with the Dojo ahead of the next allocation.
export const REGISTRATION_POOL = 3;

// Receiving-wallet BIP47 lookahead (Ashigaru: 3). An index is issued
// only while it lies within that window past the last confirmed payment.
export const RECEIVER_LOOKAHEAD = 3;

// Issuance is temporarily unavailable; nothing was allocated.
export class Unavailable extends Error {}

export function requireCondition(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

export function onionUrl(
  value: string,
  originOnly = false,
  allowQuery = false,
): URL {
  const url = new URL(value);
  requireCondition(
    url.protocol === "http:" &&
      /^[a-z2-7]{56}\.onion$/.test(url.hostname) &&
      !url.username &&
      !url.password &&
      (allowQuery || !url.search) &&
      !url.hash &&
      (!url.port || url.port === "80"),
    "Expected an HTTP v3 onion URL; credentials, fragments, or disallowed query",
  );
  requireCondition(
    !originOnly || url.pathname === "/",
    "Expected an onion origin, without a path",
  );
  return url;
}

export const Config = z.object({
  network: NetworkName,
  merchantCode: z.string().min(80).max(200),
  onion: z.string().transform(value => onionUrl(value, true).origin),
  seedHex: z.string().regex(/^[0-9a-f]{128}$/),
  apiToken: z.string().regex(/^[0-9a-f]{64}$/),
});

export type Config = z.infer<typeof Config>;

export const Pairing = z.object({
  network: NetworkName,
  baseUrl: z.string().transform(value => onionUrl(value).href),
  apikey: z.string().min(1).max(4096),
});

export type Pairing = z.infer<typeof Pairing>;

export const Pending = z.object({
  fundingHex: z.string(),
  vout: z.number().int().nonnegative(),
  feeSats: z.number().int().positive(),
  txid: z.string().regex(/^[0-9a-f]{64}$/),
  hex: z.string(),
  recipient: z.string(),
  changeSats: z.number().int().nonnegative(),
  feeRate: z.number().positive(),
});

export type Pending = z.infer<typeof Pending>;

// Public page text. Plain text only; it is escaped when rendered.
const PlainText = (max: number) => z.string().trim().max(max)
  .regex(/^[^\p{Cc}]*$/u, "Control characters are not allowed");

export const Profile = z.object({
  name: PlainText(80).min(1, "Name must not be empty"),
  description: PlainText(280).default(""),
});

export type Profile = z.infer<typeof Profile>;

export const Approval = z.object({
  txid: z.string(),
  signature: z.string(),
  createdAt: z.string(),
});

export type Approval = z.infer<typeof Approval>;
