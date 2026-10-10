import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  Config, NetworkName, profiles, requireCondition,
} from "./config.js";
import { createWallet, messages } from "./bitcoin.js";
import { Store } from "./store.js";

const API = "https://paynym.rs/api/v1/";

const Profile = z.object({
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

type Profile = z.infer<typeof Profile>;

const SavedIdentity = z.object({
  paymentCode: z.string(),
  nymID: z.string(),
  nymName: z.string(),
  claimed: z.literal(true),
  checkedAt: z.string(),
});

async function request(
  endpoint: "nym" | "create" | "token" | "claim" | "follow",
  body: Record<string, string>,
  token?: string,
): Promise<{ status: number; body: unknown }> {
  const proxy = process.env.NYM_TOR_PROXY ??
    "socks5h://127.0.0.1:9050";
  const proxyUrl = new URL(proxy);

  requireCondition(
    proxyUrl.protocol === "socks5h:" &&
      !proxyUrl.username &&
      !proxyUrl.password &&
      !proxyUrl.search &&
      !proxyUrl.hash &&
      (proxyUrl.pathname === "" || proxyUrl.pathname === "/"),
    "Expected a socks5h Tor proxy without credentials",
  );

  if (token !== undefined) {
    requireCondition(
      token.length > 0 &&
        token.length <= 4096 &&
        /^[\x21-\x7e]+$/.test(token),
      "Directory supplied an invalid authentication token",
    );
  }

  const configuration = [
    `url = ${JSON.stringify(`${API}${endpoint}`)}`,
    'request = "POST"',
    'header = "Content-Type: application/json"',
    'header = "Accept: application/json"',
    `data = ${JSON.stringify(JSON.stringify(body))}`,
    ...(token === undefined ? [] : [
      `header = ${JSON.stringify(`auth-token: ${token}`)}`,
    ]),
  ].join("\n") + "\n";

  return new Promise((resolveRequest, reject) => {
    // TLS verification stays enabled. No redirects or direct fallback.
    // Token and signature are passed on stdin, not process arguments.
    const child = spawn("curl", [
      "-q",
      "--proxy", proxy,
      "--noproxy", "",
      "--proto", "=https",
      "--connect-timeout", "30",
      "--max-time", "90",
      "--max-filesize", "1048576",
      "--silent",
      "--show-error",
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
          "PayNym request failed through Tor. No direct fallback attempted. " +
          "If a claim was submitted, rerunning will check its status first.",
        ));
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const separator = text.lastIndexOf("\n");
        const status = Number(text.slice(separator + 1));
        requireCondition(
          separator >= 0 && Number.isInteger(status) &&
            status >= 100 && status <= 599,
          "Invalid HTTP status",
        );

        const payload = text.slice(0, separator);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(payload) as unknown;
        } catch {
          // The caller reports the HTTP status without leaking response data.
        }

        resolveRequest({ status, body: parsed });
      } catch {
        reject(new Error("Unable to parse PayNym response"));
      }
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

async function lookup(code: string): Promise<Profile | undefined> {
  const result = await request("nym", { nym: code });
  if (result.status === 404) return undefined;
  return Profile.parse(requireSuccess(result, "lookup"));
}

function isClaimed(profile: Profile | undefined, code: string): boolean {
  return profile?.codes.some(
    entry => entry.code === code && entry.claimed,
  ) ?? false;
}

async function main(): Promise<void> {
  process.umask(0o077);

  const network = NetworkName.parse(
    process.env.NYM_NETWORK ?? "testnet4",
  );
  const root = resolve(process.env.NYM_DATA ?? "private");
  const path = join(root, network, "state.sqlite");

  requireCondition(existsSync(path), "Existing wallet database not found");

  const store = new Store(path);
  try {
    const config = store.get("config", Config);
    requireCondition(
      config && config.network === network,
      "Missing configuration or network mismatch",
    );

    const wallet = createWallet(config.seedHex, network);
    const code = wallet.sender.toBase58();

    console.log(`Network: ${network}`);
    console.log(`Dispenser payment code: ${code}`);
    console.log("Checking PayNym directory through Tor…");

    let profile = await lookup(code);

    if (!profile) {
      console.log("Creating dispenser directory entry…");
      const result = await request("create", { code });
      requireSuccess(result, "create");
    }

    if (!isClaimed(profile, code)) {
      console.log("Requesting claim token…");
      const result = await request("token", { code });
      const token = z.object({
        token: z.string().min(1).max(4096),
      }).parse(requireSuccess(result, "token")).token;

      const signature = Buffer.from(messages.sign(
        token,
        wallet.sender.getNotificationPrivateKey(),
        true,
        profiles[network].bitcoin.messagePrefix,
      )).toString("base64");

      console.log("Submitting locally signed claim…");
      requireSuccess(
        await request("claim", { signature }, token),
        "claim",
      );
    }

    // Verify the exact code, not just a successful claim response.
    for (let attempt = 0; attempt < 3; attempt++) {
      profile = await lookup(code);
      if (isClaimed(profile, code)) break;
      if (attempt < 2) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 3000));
      }
    }

    requireCondition(
      profile && isClaimed(profile, code),
      "Directory has not confirmed this exact payment code as claimed. " +
      "Do not regenerate the wallet; rerun this command to reconcile.",
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

    console.log("Looking up the configured merchant…");
    const merchantProfile = await lookup(config.merchantCode);

    requireCondition(
      merchantProfile &&
        merchantProfile.codes.some(
          entry => entry.code === config.merchantCode,
        ),
      "Merchant directory profile is missing or does not contain the " +
      "exact configured payment code. The dispenser claim is preserved.",
    );

    requireCondition(
      merchantProfile.nymID !== profile.nymID,
      "Merchant and dispenser resolve to the same directory identity",
    );

    const target = merchantProfile.nymID;
    const followsMerchant = (candidate: Profile | undefined): boolean =>
      candidate?.following?.some(entry => entry.nymId === target) ?? false;

    if (!followsMerchant(profile)) {
      console.log("Requesting dispenser follow authorization…");
      const tokenResult = await request("token", { code });
      const followToken = z.object({
        token: z.string().min(1).max(4096),
      }).parse(requireSuccess(tokenResult, "follow token")).token;

      const followSignature = Buffer.from(messages.sign(
        followToken,
        wallet.sender.getNotificationPrivateKey(),
        true,
        profiles[network].bitcoin.messagePrefix,
      )).toString("base64");

      console.log("Following the merchant…");
      requireSuccess(
        await request("follow", {
          target,
          signature: followSignature,
        }, followToken),
        "follow",
      );
    } else {
      console.log("Dispenser already follows the merchant.");
    }

    let verifiedProfile: Profile | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      verifiedProfile = await lookup(code);
      if (
        isClaimed(verifiedProfile, code) &&
        followsMerchant(verifiedProfile)
      ) {
        break;
      }
      if (attempt < 2) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 3000));
      }
    }

    requireCondition(
      verifiedProfile &&
        isClaimed(verifiedProfile, code) &&
        followsMerchant(verifiedProfile),
      "Directory has not confirmed both the claim and merchant follow. " +
      "Wallet and notification are unchanged. Rerun to reconcile; " +
      "do not initialize another wallet.",
    );

    const FollowRecord = z.object({
      dispenserPaymentCode: z.string(),
      merchantPaymentCode: z.string(),
      merchantNymID: z.string(),
      verifiedAt: z.string(),
    });

    const savedFollow = store.get("merchant-follow", FollowRecord);
    if (savedFollow) {
      requireCondition(
        savedFollow.dispenserPaymentCode === code &&
          savedFollow.merchantPaymentCode === config.merchantCode &&
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

    console.log(JSON.stringify({
      network,
      dispenserPaymentCode: code,
      nymID: profile.nymID,
      nymName: profile.nymName,
      claimed: true,
      merchantPaymentCode: config.merchantCode,
      merchantNymName: merchantProfile.nymName,
      merchantFollowVerified: true,
      notificationUnchanged: true,
    }, null, 2));
  } finally {
    store.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Claim failed");
  process.exitCode = 1;
});
