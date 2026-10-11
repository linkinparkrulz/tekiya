import { spawn } from "node:child_process";
import { z } from "zod";
import {
  onionUrl, profiles, requireCondition, type Config,
} from "./config.js";
import { codeForms, createWallet, messages } from "./bitcoin.js";
import { Store } from "./store.js";

// The PayNym directory's onion service; NYM_PAYNYM_API overrides it.
export const DEFAULT_PAYNYM_API =
  "http://paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion/api/v1/";

const DirectoryProfile = z.object({
  nymID: z.string().min(1),
  nymName: z.string().min(1),
  codes: z.array(z.object({
    code: z.string(),
    claimed: z.boolean(),
  })),
  following: z.array(z.object({
    nymId: z.string().min(1),
  })).optional(),
});

type DirectoryProfile = z.infer<typeof DirectoryProfile>;

export const SavedIdentity = z.object({
  paymentCode: z.string(),
  nymID: z.string(),
  nymName: z.string(),
  claimed: z.literal(true),
  checkedAt: z.string(),
});

export const FollowRecord = z.object({
  dispenserPaymentCode: z.string(),
  merchantPaymentCode: z.string(),
  merchantNymID: z.string(),
  verifiedAt: z.string(),
});

type Endpoint = "nym" | "create" | "token" | "claim" | "follow";

// An onion URL over plain HTTP (Tor encrypts it), or HTTPS through Tor.
export function paynymApi(): URL {
  const value = process.env.NYM_PAYNYM_API ?? DEFAULT_PAYNYM_API;
  const url = new URL(value.endsWith("/") ? value : `${value}/`);
  if (url.protocol === "http:") return onionUrl(url.href);
  requireCondition(
    url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash,
    "NYM_PAYNYM_API must be an onion URL or an HTTPS URL",
  );
  return url;
}

function proxyAddress(): string {
  const proxy = process.env.NYM_TOR_PROXY ?? "socks5h://127.0.0.1:9050";
  const url = new URL(proxy);
  requireCondition(
    url.protocol === "socks5h:" && !url.username && !url.password &&
      !url.search && !url.hash &&
      (url.pathname === "" || url.pathname === "/"),
    "Expected a socks5h Tor proxy without credentials",
  );
  return proxy;
}

async function request(
  endpoint: Endpoint,
  body: Record<string, string>,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const api = paynymApi();
  if (token !== undefined) {
    requireCondition(
      token.length > 0 && token.length <= 4096 && /^[\x21-\x7e]+$/.test(token),
      "Directory supplied an invalid authentication token",
    );
  }

  const configuration = [
    `url = ${JSON.stringify(new URL(endpoint, api).href)}`,
    'request = "POST"',
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    `data = ${JSON.stringify(JSON.stringify(body))}`,
    ...(token === undefined ? [] : [
      `header = ${JSON.stringify(`auth-token: ${token}`)}`,
    ]),
  ].join("\n") + "\n";

  return new Promise((resolve, reject) => {
    // Tor only, no redirects or direct fallback; the token and signatures
    // go through stdin, not process arguments.
    const child = spawn("curl", [
      "-q",
      "--proxy", proxyAddress(),
      "--noproxy", "",
      "--proto", api.protocol === "https:" ? "=https" : "=http",
      "--connect-timeout", "60",
      "--max-time", "120",
      "--max-filesize", "1048576",
      "--silent", "--show-error",
      "--write-out", "\n%{http_code}",
      "--config", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1048576) {
        overflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("Unable to execute curl")));
    child.on("close", exitCode => {
      if (exitCode !== 0 || overflow) {
        reject(new Error(
          "The PayNym directory could not be reached over Tor. Tekiya " +
          "will retry; nothing was lost.",
        ));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const separator = text.lastIndexOf("\n");
      const status = Number(text.slice(separator + 1));
      if (separator < 0 || !Number.isInteger(status) || status < 100) {
        reject(new Error("Unable to parse the PayNym directory response"));
        return;
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text.slice(0, separator)) as unknown;
      } catch {}
      resolve({ status, body: parsed });
    });
    child.stdin.end(configuration);
  });
}

function requireSuccess(
  result: { status: number; body: unknown },
  operation: string,
): unknown {
  requireCondition(
    result.status >= 200 && result.status < 300,
    `PayNym ${operation} returned HTTP ${result.status}`,
  );
  if (
    typeof result.body === "object" && result.body !== null &&
    "status" in result.body && result.body.status === "error"
  ) {
    throw new Error(`PayNym ${operation} reported an error`);
  }
  return result.body;
}

async function lookup(code: string): Promise<DirectoryProfile | undefined> {
  const result = await request("nym", { nym: code });
  if (result.status === 404) return undefined;
  return DirectoryProfile.parse(requireSuccess(result, "lookup"));
}

function isClaimed(profile: DirectoryProfile | undefined, code: string) {
  return profile?.codes.some(entry => entry.code === code && entry.claimed)
    ?? false;
}

async function signedToken(code: string, config: Config): Promise<{
  token: string;
  signature: string;
}> {
  const token = z.object({ token: z.string().min(1).max(4096) })
    .parse(requireSuccess(await request("token", { code }), "token")).token;
  const signature = Buffer.from(messages.sign(
    token,
    createWallet(config.seedHex, config.network).sender
      .getNotificationPrivateKey(),
    true,
    profiles[config.network].bitcoin.messagePrefix,
  )).toString("base64");
  return { token, signature };
}

async function settle<T>(
  check: () => Promise<T | undefined>,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const value = await check();
    if (value !== undefined) return value;
    if (attempt < 2) await new Promise(done => setTimeout(done, 3000));
  }
  return undefined;
}

export interface PaynymStatus {
  readonly dispenser?: z.infer<typeof SavedIdentity>;
  readonly follow?: z.infer<typeof FollowRecord>;
}

export function paynymStatus(store: Store): PaynymStatus {
  const dispenser = store.get("dispenser-paynym", SavedIdentity);
  const follow = store.get("merchant-follow", FollowRecord);
  return {
    ...(dispenser ? { dispenser } : {}),
    ...(follow ? { follow } : {}),
  };
}

export function paynymComplete(store: Store): boolean {
  const status = paynymStatus(store);
  return Boolean(status.dispenser && status.follow);
}

/**
 * Creates and claims the dispenser's PayNym with its SegWit payment code,
 * then follows the merchant's PayNym. Every step is idempotent: a rerun
 * checks the directory first and only does what is still missing.
 */
export async function registerPaynym(
  store: Store,
  config: Config,
): Promise<PaynymStatus> {
  const sender = createWallet(config.seedHex, config.network).sender;
  requireCondition(sender.segwit, "The dispenser code must be SegWit");
  const code = sender.toBase58();

  let profile = await lookup(code);
  if (!profile) requireSuccess(await request("create", { code }), "create");

  if (!isClaimed(profile, code)) {
    const { token, signature } = await signedToken(code, config);
    requireSuccess(await request("claim", { signature }, token), "claim");
  }

  profile = await settle(async () => {
    const value = await lookup(code);
    return isClaimed(value, code) ? value : undefined;
  });
  requireCondition(
    profile,
    "The directory has not confirmed the dispenser's claim yet",
  );

  const saved = store.get("dispenser-paynym", SavedIdentity);
  if (saved) {
    requireCondition(
      saved.paymentCode === code && saved.nymID === profile.nymID,
      "Stored PayNym identity differs from the directory response",
    );
  } else {
    store.insert("dispenser-paynym", {
      paymentCode: code,
      nymID: profile.nymID,
      nymName: profile.nymName,
      claimed: true,
      checkedAt: new Date().toISOString(),
    });
  }

  // The merchant's PayNym may list either form of its code.
  const merchantForms = codeForms(config.merchantCode, config.network);
  let merchant: DirectoryProfile | undefined;
  for (const form of merchantForms) {
    merchant = await lookup(form);
    if (merchant) break;
  }
  requireCondition(
    merchant &&
      merchant.codes.some(entry => merchantForms.includes(entry.code)),
    "Your merchant PayNym was not found in the directory. Claim your " +
    "PayNym in your wallet; Tekiya will retry.",
  );
  requireCondition(
    merchant.nymID !== profile.nymID,
    "Merchant and dispenser resolve to the same directory identity",
  );

  const target = merchant.nymID;
  const follows = (value: DirectoryProfile | undefined) =>
    value?.following?.some(entry => entry.nymId === target) ?? false;

  if (!follows(profile)) {
    const { token, signature } = await signedToken(code, config);
    requireSuccess(
      await request("follow", { target, signature }, token),
      "follow",
    );
  }

  const verified = await settle(async () => {
    const value = await lookup(code);
    return follows(value) ? value : undefined;
  });
  requireCondition(
    verified,
    "The directory has not confirmed the follow yet; Tekiya will retry",
  );

  const savedFollow = store.get("merchant-follow", FollowRecord);
  if (savedFollow) {
    requireCondition(
      savedFollow.dispenserPaymentCode === code &&
        savedFollow.merchantNymID === target,
      "Saved follow record does not match the configured identities",
    );
  } else {
    store.insert("merchant-follow", {
      dispenserPaymentCode: code,
      merchantPaymentCode: config.merchantCode,
      merchantNymID: target,
      verifiedAt: new Date().toISOString(),
    });
  }

  return paynymStatus(store);
}
