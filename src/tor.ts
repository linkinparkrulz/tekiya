import { spawn } from "node:child_process";
import { z } from "zod";
import {
  onionUrl, requireCondition,
  type NetworkName, type Pairing,
} from "./config.js";

export const DIRECTORY =
  "http://dojobayeryasshgghz537de5ckgd5hhi4z5sdeil3roeh65fwhdnu2yd.onion/data/dojos.json";

interface RequestOptions {
  form?: Record<string, string>;
  token?: string;
  // Seconds; defaults suit slow onion services.
  connectTimeout?: number;
  maxTime?: number;
}

function proxyAddress(): string {
  const value = process.env.NYM_TOR_PROXY ??
    "socks5h://127.0.0.1:9050";
  const url = new URL(value);
  requireCondition(
    url.protocol === "socks5h:" &&
      !url.username && !url.password &&
      !url.search && !url.hash &&
      (url.pathname === "" || url.pathname === "/"),
    "NYM_TOR_PROXY must be a socks5h proxy without credentials",
  );
  return value;
}

export type TorFailure =
  | "tor_unreachable" | "onion_unreachable" | "timeout" | "unauthorized"
  | "not_found" | "http_error" | "invalid_response" | "failed";

/** A failed request over Tor, with a message that says what to do. */
export class TorRequestError extends Error {
  constructor(
    readonly reason: TorFailure,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

// Curl exit codes: 5/7 proxy unreachable, 28 timeout, 97 SOCKS failure
// (the onion service could not be reached through Tor).
export function describeFailure(
  host: string,
  proxy: string,
  exitCode: number | null,
  stderr: string,
): TorRequestError {
  const detail = stderr.split("\n")[0]?.replace(/^curl: /, "").slice(0, 160);
  switch (exitCode) {
    case 5:
    case 7:
      return new TorRequestError("tor_unreachable",
        `Tor is not reachable at ${new URL(proxy).host}. Is the tor ` +
        "container running and finished starting? (docker compose ps; " +
        "docker compose logs tor)");
    case 97:
      return new TorRequestError("onion_unreachable",
        `Tor is running but could not reach ${host}. The onion service ` +
        "may be offline; Tekiya will retry.");
    case 28:
      return new TorRequestError("timeout",
        `Timed out over Tor reaching ${host}. If this persists while the ` +
        "service is up, check that this machine's clock is correct and " +
        "look at docker compose logs tor; Tekiya will retry.");
    default:
      return new TorRequestError("failed",
        `Tor request to ${host} failed (curl ${exitCode ?? "killed"}${
          detail ? `: ${detail}` : ""}); no direct fallback attempted`);
  }
}

export function describeHttpError(
  host: string,
  status: number,
  body: unknown,
): TorRequestError {
  // Dojo errors look like { status: "error", error: "…" }.
  const text = typeof body === "object" && body !== null && "error" in body &&
      typeof body.error === "string"
    ? ` (${body.error.replace(/[^\x20-\x7e]/g, "").slice(0, 120)})`
    : "";
  if (status > 0 && status < 400) {
    return new TorRequestError("http_error",
      `The Dojo at ${host} reported an error${text}.`, status);
  }
  if (status === 401 || status === 403) {
    return new TorRequestError("unauthorized",
      `The Dojo at ${host} refused the request${text}. If this persists, ` +
      "its API key changed: pair again with a current pairing.", status);
  }
  if (status === 404) {
    return new TorRequestError("not_found",
      `The Dojo at ${host} has no such endpoint${text}. Check the pairing ` +
      "URL; testnet Dojos use /test/v2/.", status);
  }
  return new TorRequestError("http_error",
    `The Dojo at ${host} answered HTTP ${status}${text}.`, status);
}

export function torJson(
  address: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const url = onionUrl(address, false, true);
  const proxy = proxyAddress();
  const lines = [
    `url = ${JSON.stringify(url.href)}`,
    `request = "${options.form ? "POST" : "GET"}"`,
  ];

  if (options.token) {
    requireCondition(
      /^[A-Za-z0-9_.-]+$/.test(options.token),
      "Malformed backend token",
    );
    lines.push(
      `header = ${JSON.stringify(
        `Authorization: Bearer ${options.token}`,
      )}`,
    );
  }
  if (options.form) {
    lines.push(
      'header = "Content-Type: application/x-www-form-urlencoded"',
      `data = ${JSON.stringify(
        new URLSearchParams(options.form).toString(),
      )}`,
    );
  }

  return new Promise((resolve, reject) => {
    // No shell; credentials go through stdin, not process arguments.
    // -q ignores curlrc; empty noproxy prevents environment bypass.
    const child = spawn("curl", [
      "-q",
      "--proxy", proxy,
      "--noproxy", "",
      "--proto", "=http",
      // Reaching an onion service (descriptor lookup and rendezvous) is
      // part of connecting and often takes over 30 s, longer after Tor
      // has just started.
      "--connect-timeout", String(options.connectTimeout ?? 90),
      "--max-time", String(options.maxTime ?? 150),
      "--max-filesize", "2097152",
      "--silent", "--show-error",
      "--write-out", "\n%{http_code}",
      "--config", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2097152) {
        overflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 1000) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("Unable to execute curl")));
    child.on("close", code => {
      if (overflow) {
        reject(new TorRequestError("invalid_response",
          `The response from ${url.hostname} was too large`));
        return;
      }
      if (code !== 0) {
        reject(describeFailure(url.hostname, proxy, code, stderr));
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const separator = text.lastIndexOf("\n");
      const status = Number(text.slice(separator + 1));
      let body: unknown;
      try {
        body = JSON.parse(text.slice(0, Math.max(separator, 0))) as unknown;
      } catch {
        body = undefined;
      }
      if (!Number.isInteger(status) || status >= 400 || status === 0) {
        reject(describeHttpError(url.hostname, status || 0, body));
        return;
      }
      if (body === undefined) {
        reject(new TorRequestError("invalid_response",
          `${url.hostname} did not answer with JSON`));
        return;
      }
      resolve(body);
    });
    child.stdin.end(lines.join("\n") + "\n");
  });
}

const Login = z.object({
  authorizations: z.object({
    access_token: z.string().min(1),
  }),
});

export async function connectDojo(
  pairing: Pairing,
  network: NetworkName,
) {
  requireCondition(
    pairing.network === network,
    "Dojo pairing network label does not match this installation",
  );
  const base = onionUrl(pairing.baseUrl);
  if (!base.pathname.endsWith("/")) base.pathname += "/";

  const login = Login.parse(await torJson(
    new URL("auth/login", base).href,
    { form: { apikey: pairing.apikey } },
  ));

  return async (
    path: string,
    form?: Record<string, string>,
  ): Promise<unknown> => {
    const result = await torJson(new URL(path, base).href, {
      token: login.authorizations.access_token,
      ...(form ? { form } : {}),
    });
    if (
      typeof result === "object" && result !== null &&
      "status" in result && result.status === "error"
    ) {
      throw describeHttpError(base.hostname, 200, result);
    }
    return result;
  };
}
