import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { TorRequestError, torJson } from "../src/tor.js";
import { connectPaired } from "../src/setup.js";
import { Store } from "../src/store.js";
import type { Config } from "../src/config.js";

// Stand-in for Tor: a SOCKS5 proxy that forwards every host to a local
// HTTP server, or refuses hosts starting with "dead".
let http: Server;
let socks: net.Server;
let socksPort = 0;
const onion = (label: string) => `http://${label.padEnd(56, "a")}.onion`;
let onLogin = () => {};

before(async () => {
  http = createServer((req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(body);
    };
    if (req.url === "/ok") return reply(200, '{"fine":true}');
    if (req.url === "/auth/login") {
      onLogin();
      return reply(200, '{"authorizations":{"access_token":"token"}}');
    }
    if (req.url === "/denied") return reply(401, '{"status":"error","error":"Invalid API key"}');
    if (req.url === "/missing") return reply(404, "{}");
    if (req.url === "/broken") return reply(500, "{}");
    if (req.url === "/html") return reply(200, "<html>");
    // "/hang" never answers.
  });
  await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
  const httpPort = (http.address() as AddressInfo).port;

  socks = net.createServer(sock => {
    sock.once("data", () => {
      sock.write(Buffer.from([5, 0]));
      sock.once("data", request => {
        const host = request.subarray(5, 5 + (request[4] ?? 0)).toString();
        if (host.startsWith("dead")) {
          // General failure / host unreachable, as Tor reports it.
          sock.end(Buffer.from([5, 4, 0, 1, 0, 0, 0, 0, 0, 0]));
          return;
        }
        const upstream = net.connect(httpPort, "127.0.0.1", () => {
          sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          sock.pipe(upstream).pipe(sock);
        });
        upstream.on("error", () => sock.destroy());
      });
    });
    sock.on("error", () => {});
  });
  await new Promise<void>(done => socks.listen(0, "127.0.0.1", done));
  socksPort = (socks.address() as AddressInfo).port;
  process.env.NYM_TOR_PROXY = `socks5h://127.0.0.1:${socksPort}`;
});

after(() => {
  http.closeAllConnections();
  http.close();
  socks.close();
});

async function failure(url: string, options = {}): Promise<TorRequestError> {
  try {
    await torJson(url, options);
  } catch (error) {
    assert.ok(error instanceof TorRequestError, String(error));
    return error;
  }
  throw new Error("expected a failure");
}

test("successful requests return the JSON body", async () => {
  assert.deepEqual(await torJson(`${onion("good")}/ok`), { fine: true });
});

test("paired clients capture generation before login completes", async () => {
  const store = new Store(":memory:");
  const pairing = { network: "testnet4", baseUrl: onion("good"), apikey: "key" };
  try {
    store.replacePairing(pairing);
    onLogin = () => store.replacePairing(pairing);
    await assert.rejects(connectPaired(store, { network: "testnet4" } as Config), /stale/);
    onLogin = () => {};
    const api = await connectPaired(store, { network: "testnet4" } as Config);
    assert.equal(typeof api.pairingGeneration, "string");
  } finally { onLogin = () => {}; store.close(); }
});

test("Dojo HTTP errors say what to fix", async () => {
  const denied = await failure(`${onion("good")}/denied`);
  assert.equal(denied.reason, "unauthorized");
  assert.match(denied.message, /refused the request \(Invalid API key\).*pair again/);
  assert.equal((await failure(`${onion("good")}/missing`)).reason, "not_found");
  const broken = await failure(`${onion("good")}/broken`);
  assert.equal(broken.reason, "http_error");
  assert.match(broken.message, /HTTP 500/);
  assert.equal((await failure(`${onion("good")}/html`)).reason, "invalid_response");
});

test("an unreachable onion service is told apart from a missing Tor", async () => {
  const offline = await failure(`${onion("dead")}/ok`);
  assert.equal(offline.reason, "onion_unreachable", offline.message);
  assert.match(offline.message, /deadaaa.*may be offline/);

  const saved = process.env.NYM_TOR_PROXY;
  try {
    // A port with nothing listening: Tor is not running.
    const closed = net.createServer();
    await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
    const port = (closed.address() as AddressInfo).port;
    closed.close();
    process.env.NYM_TOR_PROXY = `socks5h://127.0.0.1:${port}`;
    const missing = await failure(`${onion("good")}/ok`);
    assert.equal(missing.reason, "tor_unreachable");
    assert.match(missing.message, /docker compose ps/);
  } finally {
    process.env.NYM_TOR_PROXY = saved;
  }
});

test("slow onion services time out with a clear message", async () => {
  const slow = await failure(`${onion("good")}/hang`, { maxTime: 1 });
  assert.equal(slow.reason, "timeout");
  assert.match(slow.message, /Timed out over Tor/);
});
