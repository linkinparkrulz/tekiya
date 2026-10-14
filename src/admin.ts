import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { createConnection } from "node:net";
import { createServer, type IncomingMessage } from "node:http";
import { ADMIN_PASSWORD, AdminPassword, bootstrapPassword, sameSecret, verifyPassword } from "./admin-auth.js";
import { z } from "zod";
import {
  Config, Profile, PublicPayments, onionUrl, requireCondition, type NetworkName,
} from "./config.js";
import { dashboard } from "./admin-pages.js";
import { deriveAddress } from "./bitcoin.js";
import { escape, page, sendHtml } from "./html.js";
import type { Monitor } from "./monitor.js";
import {
  approve, broadcastNotification, cachedConfirmedNotification, connectPaired,
  FEE_CHOICE, FeeChoice, chosenRate, feeForRate, initialize,
  normalizeOnion, pairDojo, parsePairing,
  prepareNotification, TEST_REQUEST_ID,
} from "./setup.js";
import { syncDojo } from "./registrar.js";
import { disableMonero, enableMonero } from "./monero.js";
import { Store } from "./store.js";

/**
 * Access modes for the operator dashboard:
 * - setup (default): local password bootstrap, then stored-hash Basic auth.
 * - loopback: 127.0.0.1 only, no password; Host is checked so
 *   DNS-rebinding pages cannot use the operator's browser to reach it.
 * - password: HTTP basic auth, for a dashboard on a private network.
 * - proxy: an authenticating reverse proxy in front, such as Umbrel's.
 * - none: listening beyond loopback without auth; only behind a forwarder
 *   that itself is loopback-only. Compose uses setup over a Unix socket.
 */
const AdminSettings = z.object({
  port: z.coerce.number().int().min(0).max(65535),
  host: z.enum(["127.0.0.1", "0.0.0.0"]),
  auth: z.enum(["setup", "loopback", "password", "proxy", "none"]),
  socket: z.string().min(1).optional(),
  password: z.string().optional(),
  hosts: z.array(z.string()),
});

export function adminSettings(env: NodeJS.ProcessEnv = process.env) {
  const host = env.NYM_ADMIN_HOST ?? "127.0.0.1";
  const value = AdminSettings.parse({
    port: env.NYM_ADMIN_PORT ?? "8089",
    host,
    auth: env.NYM_ADMIN_AUTH ?? "setup",
    socket: env.NYM_ADMIN_SOCKET,
    password: env.NYM_ADMIN_PASSWORD,
    hosts: (env.NYM_ADMIN_HOSTS ?? "")
      .split(",").map(item => item.trim()).filter(Boolean),
  });
  requireCondition(
    value.auth !== "setup" || !!value.socket || value.host === "127.0.0.1",
    "NYM_ADMIN_AUTH=setup requires a Unix socket or loopback binding",
  );
  requireCondition(!value.socket || isAbsolute(value.socket), "NYM_ADMIN_SOCKET must be absolute");
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
): ReturnType<typeof createServer> | undefined {
  const admin = adminSettings();
  if (admin.port === 0 && !admin.socket) return undefined;
  requireCondition(
    !!admin.socket || admin.port !== Number(process.env.NYM_PORT ?? "8088"),
    "NYM_ADMIN_PORT must differ from NYM_PORT",
  );
  const allowedHosts = new Set([
    `127.0.0.1:${admin.port}`, `localhost:${admin.port}`, ...admin.hosts,
  ]);
  const nonce = randomBytes(32).toString("hex");
  const setupPage = (error = "") => page("Set admin password", `
    <h1>Set admin password</h1>
    <p>Create a password of at least 12 characters. Your username will be admin.</p>
    ${error ? `<p role="alert">${escape(error)}</p>` : ""}
    <form method="post" action="/setup/password">
      <input type="hidden" name="nonce" value="${nonce}">
      <label>Password <input type="password" name="password" minlength="12" required autocomplete="new-password"></label>
      <label>Confirm password <input type="password" name="confirmation" minlength="12" required autocomplete="new-password"></label>
      <button type="submit">Set password</button>
    </form>`);

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
      try {
        cachedConfirmedNotification(store, config);
      } catch (error) {
        void monitor.run().catch(() => undefined);
        throw error;
      }
      store.allocate(TEST_REQUEST_ID, 0, index => deriveAddress(config, index));
    },
    "/setup/approve": async form => {
      const config = requireConfig();
      let pending;
      try {
        pending = cachedConfirmedNotification(store, config);
      } catch (error) {
        void monitor.run().catch(() => undefined);
        throw error;
      }
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
    "/settings/public-payments": async form => {
      const value = form.get("enabled");
      requireCondition(value === "true" || value === "false", "Choose whether public payments are enabled");
      requireCondition(value !== "true" || form.get("reviewed") === "yes",
        "Acknowledge the anonymous address-exhaustion risk before enabling public payments");
      store.replace("public-payments", PublicPayments.parse({ enabled: value === "true" }));
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

  const render = (error?: string, draft?: Record<string, string>): string =>
    dashboard({
      store,
      network,
      monitor: monitor.state,
      detectedOnion: detectOnion(),
      ...(error ? { error } : {}),
      ...(draft ? { draft } : {}),
    });

  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (
        (admin.auth === "setup" || admin.auth === "loopback" || admin.auth === "none") &&
        !allowedHosts.has(req.headers.host ?? "")
      ) {
        res.writeHead(421);
        res.end();
        return;
      }
      const path = (req.url ?? "").split("?")[0] ?? "";
      const stored = admin.auth === "setup" ? store.get(ADMIN_PASSWORD, AdminPassword) : undefined;
      if (admin.auth === "setup" && !stored) {
        if (req.method === "GET" && path === "/") {
          sendHtml(res, 200, setupPage());
        } else if (req.method === "POST" && path === "/setup/password") {
          if (!sameOrigin(req)) {
            sendHtml(res, 403, setupPage("Request blocked: it did not come from this page."));
            return;
          }
          const form = await readForm(req);
          if (!sameSecret(form.get("nonce") ?? "", nonce)) {
            sendHtml(res, 403, setupPage("Invalid setup token"));
            return;
          }
          try {
            await bootstrapPassword(store, form.get("password") ?? "", form.get("confirmation") ?? "");
          } catch {
            sendHtml(res, 400, setupPage("Use matching passwords of 12 or more characters (maximum 1024 bytes). Setup may already be complete or busy."));
            return;
          }
          res.writeHead(303, { Location: "/" });
          res.end();
        } else {
          sendHtml(res, 404, setupPage());
        }
        return;
      }
      if (admin.auth === "password" || stored) {
        const header = req.headers.authorization ?? "";
        const supplied = header.startsWith("Basic ")
          ? Buffer.from(header.slice(6), "base64").toString("utf8")
            .replace(/^[^:]*:/, "")
          : "";
        let authenticated = false;
        try {
          authenticated = stored ? await verifyPassword(stored, header)
            : sameSecret(supplied, admin.password ?? "");
        } catch {
          res.writeHead(503, { "Retry-After": "1" });
          res.end();
          return;
        }
        if (!authenticated) {
          res.setHeader(
            "WWW-Authenticate", 'Basic realm="Tekiya", charset="UTF-8"',
          );
          res.writeHead(401);
          res.end();
          return;
        }
      }

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
        const form = await readForm(req);
        try {
          await action(form);
        } catch (error) {
          // Keep what was typed for another try; secrets are never echoed.
          const draft = Object.fromEntries(
            [...form].filter(([key]) => !/key|signature|pairing|password|confirmation/i.test(key)),
          );
          sendHtml(res, 400, render(describe(error), draft));
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

  if (admin.socket) {
    const socket = admin.socket;
    const directory = lstatSync(dirname(socket));
    requireCondition(directory.isDirectory() && directory.uid === process.getuid?.() &&
      (directory.mode & 0o022) === 0,
    "Admin socket directory must exist, be app-owned, and not group/world writable");
    const listen = () => {
      // Restrict the socket from creation, before the listening callback runs.
      const mask = process.umask(0o177);
      try {
        server.listen(socket, () => {
          chmodSync(socket, 0o600);
          console.log(`Tekiya dashboard on ${socket} (access: ${admin.auth})`);
        });
      } finally { process.umask(mask); }
    };
    let existing;
    try { existing = lstatSync(socket); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing) {
      requireCondition(existing.isSocket() && existing.uid === process.getuid?.(),
        "Refusing to remove a non-socket or foreign-owned admin path");
      const probe = createConnection(socket);
      probe.once("connect", () => {
        probe.destroy();
        server.emit("error", new Error("Admin socket already in use"));
      });
      probe.once("error", error => {
        if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") {
          server.emit("error", error);
          return;
        }
        const current = lstatSync(socket);
        if (!current.isSocket() || current.ino !== existing.ino || current.dev !== existing.dev) {
          server.emit("error", new Error("Admin socket changed during startup"));
          return;
        }
        unlinkSync(socket);
        listen();
      });
    } else listen();
  } else server.listen(admin.port, admin.host, () => {
    console.log(`Tekiya dashboard on ${admin.host}:${admin.port} ` +
      `(access: ${admin.auth})`);
  });
  return server;
}
