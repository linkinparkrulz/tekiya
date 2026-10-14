import { ed25519 } from "@noble/curves/ed25519.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { requireCondition } from "./config.js";

// Monero subaddresses, derived from the primary address and the private
// view key alone, as the reference wallet does. Tekiya picks each index
// itself, so issuing an address never asks the wallet to create anything.

type Network = "mainnet" | "stagenet";

const PREFIX: Record<Network, { primary: number; subaddress: number }> = {
  mainnet: { primary: 18, subaddress: 42 },
  stagenet: { primary: 24, subaddress: 36 },
};

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
// Encoded length of a block of 0..8 bytes.
const BLOCK_CHARS = [0, 2, 3, 5, 6, 7, 9, 10, 11];

const Point = ed25519.Point;
const ORDER = Point.Fn.ORDER;

function encodeBase58(bytes: Uint8Array): string {
  let out = "";
  for (let start = 0; start < bytes.length; start += 8) {
    const block = bytes.subarray(start, start + 8);
    let value = 0n;
    for (const byte of block) value = value * 256n + BigInt(byte);
    let chars = "";
    for (let i = 0; i < BLOCK_CHARS[block.length]!; i++) {
      chars = ALPHABET[Number(value % 58n)]! + chars;
      value /= 58n;
    }
    out += chars;
  }
  return out;
}

function decodeBase58(text: string): Uint8Array | undefined {
  const bytes: number[] = [];
  for (let start = 0; start < text.length; start += 11) {
    const chunk = text.slice(start, start + 11);
    const size = BLOCK_CHARS.indexOf(chunk.length);
    if (size < 0) return undefined;
    let value = 0n;
    for (const char of chunk) {
      const digit = ALPHABET.indexOf(char);
      if (digit < 0) return undefined;
      value = value * 58n + BigInt(digit);
    }
    if (value >= 1n << BigInt(8 * size)) return undefined;
    const block = new Array<number>(size);
    for (let i = size - 1; i >= 0; i--) {
      block[i] = Number(value & 0xffn);
      value >>= 8n;
    }
    bytes.push(...block);
  }
  return Uint8Array.from(bytes);
}

function encodeAddress(prefix: number, spend: Uint8Array, view: Uint8Array): string {
  // Prefixes below 128 are a single varint byte.
  const body = Uint8Array.from([prefix, ...spend, ...view]);
  const checksum = keccak_256(body).subarray(0, 4);
  return encodeBase58(Uint8Array.from([...body, ...checksum]));
}

export interface PrimaryAddress {
  readonly spend: Uint8Array;
  readonly view: Uint8Array;
}

/** Decodes a primary address; undefined if it is not one for this network. */
export function decodePrimaryAddress(
  address: string,
  network: Network,
): PrimaryAddress | undefined {
  const bytes = decodeBase58(address);
  if (!bytes || bytes.length !== 69) return undefined;
  if (bytes[0] !== PREFIX[network].primary) return undefined;
  const checksum = keccak_256(bytes.subarray(0, 65)).subarray(0, 4);
  if (!checksum.every((byte, i) => byte === bytes[65 + i])) return undefined;
  const spend = bytes.slice(1, 33);
  const view = bytes.slice(33, 65);
  try {
    Point.fromBytes(spend);
    Point.fromBytes(view);
  } catch {
    return undefined;
  }
  return { spend, view };
}

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = value * 256n + BigInt(bytes[i]!);
  return value;
}

function scalar(viewKeyHex: string): bigint {
  const value = littleEndian(Buffer.from(viewKeyHex, "hex"));
  requireCondition(value > 0n && value < ORDER, "The private view key is not a valid key");
  return value;
}

/** Whether the private view key belongs to the primary address. */
export function viewKeyMatches(primary: PrimaryAddress, viewKeyHex: string): boolean {
  try {
    const derived = Point.BASE.multiply(scalar(viewKeyHex)).toBytes();
    return derived.every((byte, i) => byte === primary.view[i]);
  } catch {
    return false;
  }
}

function u32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

/**
 * Subaddress (account, index): D = B + Hs("SubAddr\0" || a || account || index)·G
 * and C = a·D, encoded with the subaddress prefix.
 */
export function deriveSubaddress(
  primary: PrimaryAddress,
  viewKeyHex: string,
  account: number,
  index: number,
  network: Network,
): string {
  requireCondition(
    Number.isInteger(account) && Number.isInteger(index) &&
      account >= 0 && index >= 0 && account <= 0xffffffff && index <= 0xffffffff &&
      (account > 0 || index > 0),
    "Subaddress indices must be nonnegative 32-bit integers, not 0/0",
  );
  const a = scalar(viewKeyHex);
  const data = Uint8Array.from([
    ...new TextEncoder().encode("SubAddr\0"),
    ...Buffer.from(viewKeyHex, "hex"), ...u32(account), ...u32(index),
  ]);
  const m = littleEndian(keccak_256(data)) % ORDER;
  const spend = Point.fromBytes(primary.spend);
  const d = m === 0n ? spend : spend.add(Point.BASE.multiply(m));
  const c = d.multiply(a);
  return encodeAddress(PREFIX[network].subaddress, d.toBytes(), c.toBytes());
}
