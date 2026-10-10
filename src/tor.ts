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

export function torJson(
  address: string,
  options: RequestOptions = {},
): Promise<unknown> {
  const url = onionUrl(address, false, true);
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
      "--proxy", proxyAddress(),
      "--noproxy", "",
      "--proto", "=http",
      "--connect-timeout", "30",
      "--max-time", "90",
      "--max-filesize", "2097152",
      "--fail", "--silent", "--show-error",
      "--config", "-",
    ], { stdio: ["pipe", "pipe", "pipe"] });

    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;

    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 2097152) {
        overflow = true;
        child.kill();
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.on("error", () => reject(new Error("Unable to execute curl")));
    child.on("close", code => {
      if (code !== 0 || overflow) {
        reject(new Error("Tor request failed; no direct fallback attempted"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("Backend response was not valid JSON"));
      }
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
      throw new Error("Dojo reported an API error");
    }
    return result;
  };
}
