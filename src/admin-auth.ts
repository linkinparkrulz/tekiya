import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { requireCondition } from "./config.js";
import { Store } from "./store.js";

export const ADMIN_PASSWORD = "admin-password";
export const AdminPassword = z.object({
  algorithm: z.literal("scrypt"),
  salt: z.string().regex(/^[a-f0-9]{32}$/),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});

export function sameSecret(a: string, b: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

// No queue: cap both memory usage and outstanding work from unauthenticated clients.
let active = 0;
async function derive(password: string, salt: string): Promise<Buffer> {
  requireCondition(Buffer.byteLength(password) <= 1024, "Password exceeds 1024 bytes");
  requireCondition(active < 2, "Authentication busy; try again");
  active++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(salt, "hex"), 32,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
        (error, key) => error ? reject(error) : resolve(key));
    });
  } finally {
    active--;
  }
}

export async function bootstrapPassword(
  store: Store, password: string, confirmation: string,
): Promise<void> {
  requireCondition(password.length >= 12, "Password must be at least 12 characters");
  requireCondition(sameSecret(password, confirmation), "Passwords do not match");
  requireCondition(!store.get(ADMIN_PASSWORD, AdminPassword), "Password already configured");
  const salt = randomBytes(16).toString("hex");
  const hash = (await derive(password, salt)).toString("hex");
  // The unique settings key, not the check above, decides concurrent first-writer wins.
  store.insert(ADMIN_PASSWORD, { algorithm: "scrypt", salt, hash });
}

export async function verifyPassword(
  record: z.infer<typeof AdminPassword>, header: string,
): Promise<boolean> {
  if (!header.startsWith("Basic ") || header.length > 2048) return false;
  const supplied = Buffer.from(header.slice(6), "base64").toString("utf8");
  if (!supplied.startsWith("admin:")) return false;
  const password = supplied.slice(6);
  if (Buffer.byteLength(password) > 1024) return false;
  const hash = await derive(password, record.salt);
  return timingSafeEqual(hash, Buffer.from(record.hash, "hex"));
}
