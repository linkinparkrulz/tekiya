import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { z } from "zod";
import {
  Config, Profile, onionUrl, requireCondition, type NetworkName,
} from "./config.js";
import { dashboard } from "./admin-pages.js";
import { escape, page, sendHtml } from "./html.js";
import type { Monitor } from "./monitor.js";
import {
  approve, broadcastNotification, confirmedNotification, connectPaired,
  FEE_CHOICE, FeeChoice, chosenRate, feeForRate, initialize,
  issueTestAddress, normalizeOnion, pairDojo, parsePairing,
  prepareNotification,
} from "./setup.js";
import { syncDojo } from "./registrar.js";
import { disableMonero, enableMonero } from "./monero.js";
import { Store } from "./store.js";

/**
 * Access modes for the operator dashboard:
 * - loopback (default): 127.0.0.1 only, no password; Host is checked so
 *   DNS-rebinding pages cannot use the operator's browser to reach it.
 * - password: HTTP basic auth, for a dashboard on a private network.
 * - proxy: an authenticating reverse proxy in front, such as Umbrel's.
 * - none: listening beyond loopback without auth; only behind a forwarder
 *   that itself is loopback-only (the bundled Compose setup).
 */
const AdminSettings = z.object({
  port: z.coerce.number().int().min(0).max(65535),
  host: z.enum(["127.0.0.1", "0.0.0.0"]),
  auth: z.enum(["loopback", "password", "proxy", "none"]),
  password: z.string().optional(),
  hosts: z.array(z.string()),
});

function settings() {
  const host = process.env.NYM_ADMIN_HOST ?? "127.0.0.1";
  const value = AdminSettings.parse({
    port: process.env.NYM_ADMIN_PORT ?? "8089",
    host,
    auth: process.env.NYM_ADMIN_AUTH ??
      (host === "127.0.0.1" ? "loopback" : undefined),
    password: process.env.NYM_ADMIN_PASSWORD,
    hosts: (process.env.NYM_ADMIN_HOSTS ?? "")
      .split(",").map(item => item.trim()).filter(Boolean),
  });
  requireCondition(
    value.auth !== "loopback" || value.host === "127.0.0.1",
    "NYM_ADMIN_AUTH=loopback requires NYM_ADMIN_HOST=127.0.0.1",
  );
  requireCondition(
    value.auth !== "password" || (value.password?.length ?? 0) >= 12,
    "NYM_ADMIN_PASSWORD must be at least 12 characters",
  );
  return value;
}

function sameSecret(a: string, b: string): boolean {
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(a), hash(b));
}

// Same-origin form posts only: blocks cross-site requests from other pages.
export function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers["sec-fetch-site"];
  if (typeof site === "string") return site === "same-origin";
  const origin = req.headers.origin;
  const host = req.headers.host;
  return typeof origin === "string" && typeof host === "string" &&
    (origin === `http://${host}` || origin === `https://${host}`);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > 16384) throw new Error("Form exceeds 16 KB");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

// The Tor container publishes the onion hostname to a shared file.
function detectOnion(): string | undefined {
  const file = process.env.NYM_ONION_HOSTNAME_FILE;
  if (!file) return undefined;
  try {
    return onionUrl(normalizeOnion(readFileSync(file, "utf8")), true).hostname;
  } catch {
    return undefined;
  }
}

function feeChoice(form: URLSearchParams): FeeChoice {
  const preset = form.get("preset") ?? "standard";
  return FeeChoice.parse(preset === "custom"
    ? { preset, customRate: Number(form.get("customRate")) }
    : { preset });
}

function describe(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => issue.message).join("; ");
  }
  return error instanceof Error ? error.message : "Action failed";
}

export function serveAdmin(
  store: Store,
  network: NetworkName,
  monitor: Monitor,
): { close: () => void } | undefined {
  const admin = settings();
  if (admin.port === 0) return undefined;
  requireCondition(
    admin.port !== Number(process.env.NYM_PORT ?? "8088"),
    "NYM_ADMIN_PORT must differ from NYM_PORT",
  );
  const allowedHosts = new Set([
    `127.0.0.1:${admin.port}`, `localhost:${admin.port}`, ...admin.hosts,
  ]);

  const requireConfig = (): Config => {
    const config = store.get("config", Config);
    requireCondition(config, "Connect your merchant wallet first");
    return config;
  };

  async function pair(form: URLSearchParams): Promise<void> {
    const config = requireConfig();
    const pairing = parsePairing(form.get("pairing") ?? "", network);
    const { api } = await pairDojo(store, config, pairing);
    // Register addresses at once; the monitor retries if this fails.
    await syncDojo(store, config, api).catch(() => undefined);
    await monitor.run();
  }

  // Each action returns on success; a thrown error is shown on the page.
  const actions: Record<string, (form: URLSearchParams) => Promise<void>> = {
    "/setup/init": async form => {
      initialize(
        store, network,
        form.get("merchantCode") ?? "",
        form.get("onion") || detectOnion() || "",
      );
      // Claims the dispenser's PayNym in the background.
      void monitor.run();
    },
    "/setup/pair": pair,
    "/settings/pair": pair,
    "/setup/fee": async form => {
      store.replace(FEE_CHOICE, feeChoice(form));
    },
    "/setup/notification": async form => {
      const config = requireConfig();
      const choice = feeChoice(form);
      store.replace(FEE_CHOICE, choice);
      const txid = form.get("txid") ?? "";
      const vout = Number(form.get("vout"));
      const utxo = monitor.state.funding?.utxos
        .find(item => item.txid === txid && item.vout === vout);
      requireCondition(utxo, "That funding output is no longer available");
      const rate = chosenRate(choice, monitor.state.funding?.fees);
      await prepareNotification(
        store, config, await connectPaired(store, config),
        txid, vout, feeForRate(config, utxo.value, rate),
      );
    },
    "/setup/broadcast": async () => {
      const config = requireConfig();
      await broadcastNotification(
        store, config, await connectPaired(store, config),
      );
      delete monitor.state.notificationConfirmations;
      await monitor.run();
    },
    "/setup/test-address": async () => {
      const config = requireConfig();
      await issueTestAddress(store, config, await connectPaired(store, config));
    },
    "/setup/approve": async form => {
      const config = requireConfig();
      const pending = await confirmedNotification(
        store, config, await connectPaired(store, config),
      );
      approve(store, config, pending, form.get("signature") ?? "");
    },
    "/settings/profile": async form => {
      const name = (form.get("name") ?? "").trim();
      if (!name) {
        store.remove("profile");
        return;
      }
      store.replace("profile", Profile.parse({
        name, description: form.get("description") ?? "",
      }));
    },
    "/settings/resume": async form => {
      requireCondition(
        form.get("reviewed") === "yes",
        "Confirm the recovery review first",
      );
      store.clearHalt();
    },
    "/check": () => monitor.run(),
    "/monero/enable": async form => {
      const height = form.get("restoreHeight") ?? "";
      await enableMonero(store, network, {
        address: form.get("address") ?? "",
        viewKey: form.get("viewKey") ?? "",
        node: form.get("node") ?? "",
        ...(height ? { restoreHeight: Number(height) } : {}),
        account: Number(form.get("account") ?? "1"),
      });
      await monitor.syncMonero();
    },
    "/monero/disable": async () => {
      disableMonero(store);
    },
    "/paynym": () => monitor.registerPaynym(),
  };

  const render = (error?: string): string => dashboard({
    store,
    network,
    monitor: monitor.state,
    detectedOnion: detectOnion(),
    ...(error ? { error } : {}),
  });

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (
        (admin.auth === "loopback" || admin.auth === "none") &&
        !allowedHosts.has(req.headers.host ?? "")
      ) {
        res.writeHead(421);
        res.end();
        return;
      }
      if (admin.auth === "password") {
        const header = req.headers.authorization ?? "";
        const supplied = header.startsWith("Basic ")
          ? Buffer.from(header.slice(6), "base64").toString("utf8")
            .replace(/^[^:]*:/, "")
          : "";
        if (!sameSecret(supplied, admin.password ?? "")) {
          res.setHeader(
            "WWW-Authenticate", 'Basic realm="Tekiya", charset="UTF-8"',
          );
          res.writeHead(401);
          res.end();
          return;
        }
      }

      const path = (req.url ?? "").split("?")[0] ?? "";
      if (req.method === "GET" && path === "/") {
        sendHtml(res, 200, render());
        return;
      }

      const action = actions[path];
      if (req.method === "POST" && action) {
        if (!sameOrigin(req)) {
          sendHtml(res, 403,
            render("Request blocked: it did not come from this page."));
          return;
        }
        try {
          await action(await readForm(req));
        } catch (error) {
          sendHtml(res, 400, render(describe(error)));
          return;
        }
        res.setHeader("Location", "/");
        res.writeHead(303);
        res.end();
        return;
      }

      sendHtml(res, 404, page("Not found", "<p>Not found.</p>"));
    } catch (error) {
      sendHtml(res, 500, page("Error", `<p>${escape(describe(error))}</p>`));
    }
  });

  // Setup actions wait on Tor; allow them time to finish.
  server.requestTimeout = 300000;

  server.listen(admin.port, admin.host, () => {
    console.log(`Tekiya dashboard on ${admin.host}:${admin.port} ` +
      `(access: ${admin.auth})`);
  });
  return { close: () => server.close() };
}
