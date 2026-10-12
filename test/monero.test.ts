import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Unavailable } from "../src/config.js";
import {
  MONERO, MoneroSettings, XMR_GAP_LIMIT, allocateMonero, enableMonero,
  formatXmr, moneroUri, parseXmrAmount, syncMonero, validateNode,
} from "../src/monero.js";
import { Store } from "../src/store.js";
import { handleApi } from "../src/api.js";

const PRIMARY = `5${"A".repeat(94)}`;
const VIEW_KEY = "ab".repeat(32);

// A stand-in for monero-wallet-rpc's JSON-RPC interface.
const wallet = {
  files: new Set<string>(),
  open: undefined as string | undefined,
  accounts: 1,
  next: new Map<number, number>(),
  transfers: { in: [] as unknown[], pool: [] as unknown[] },
  calls: [] as string[],
  daemon: undefined as unknown,
};
let server: Server;

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const { method, params } = JSON.parse(body) as {
      method: string; params: Record<string, unknown>;
    };
    wallet.calls.push(method);
    const reply = (result: unknown) => res.end(JSON.stringify({ id: "0", result }));
    const fail = (code: number, message: string) =>
      res.end(JSON.stringify({ id: "0", error: { code, message } }));
    switch (method) {
      case "set_daemon": wallet.daemon = params; return reply({});
      case "generate_from_keys": {
        const file = String(params.filename);
        if (wallet.files.has(file)) return fail(-1, "Wallet already exists.");
        if (params.address !== PRIMARY || params.viewkey !== VIEW_KEY) {
          return fail(-1, "Failed to verify view key secret key");
        }
        wallet.files.add(file);
        wallet.open = file;
        return reply({ address: PRIMARY, info: "" });
      }
      case "open_wallet":
        if (!wallet.files.has(String(params.filename))) {
          return fail(-1, "Failed to open wallet");
        }
        wallet.open = String(params.filename);
        return reply({});
      case "get_address": return reply({ address: PRIMARY });
      case "get_height":
        if (!wallet.open) return fail(-13, "No wallet file");
        return reply({ height: 1700000 });
      case "get_accounts":
        return reply({ subaddress_accounts: Array.from(
          { length: wallet.accounts }, (_, account_index) => ({ account_index }),
        ) });
      case "create_account":
        wallet.accounts++;
        return reply({ account_index: wallet.accounts - 1 });
      case "create_address": {
        const account = Number(params.account_index);
        const index = (wallet.next.get(account) ?? 0) + 1;
        wallet.next.set(account, index);
        return reply({
          address: `7${String(account)}${String(index).padStart(93, "x")}`,
          address_index: index,
        });
      }
      case "get_transfers": return reply(wallet.transfers);
      default: return fail(-32601, `Method not found: ${method}`);
    }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  process.env.NYM_MONERO_RPC = `http://127.0.0.1:${port}/json_rpc`;
  process.env.NYM_MONERO_RPC_LOGIN_FILE = "/nonexistent/rpc-login";
});

after(() => server.close());

const node = `${"n".repeat(56)}.onion:18081`;

test("mainnet nodes must be onion or local", () => {
  assert.deepEqual(validateNode(node, "mainnet"), { address: node, viaTor: true });
  assert.deepEqual(validateNode("192.168.1.20", "mainnet"),
    { address: "192.168.1.20:18081", viaTor: false });
  assert.equal(validateNode("monerod:18089", "mainnet").viaTor, false);
  assert.throws(() => validateNode("node.example.com:18089", "mainnet"), /onion/);
  assert.throws(() => validateNode("8.8.8.8:18081", "mainnet"), /onion/);
  assert.throws(() => validateNode(`http://${node}/json_rpc`, "mainnet"));
});

test("stagenet also accepts clearnet nodes, always through Tor", () => {
  assert.deepEqual(validateNode("stagenet.community.rino.io", "stagenet"),
    { address: "stagenet.community.rino.io:38081", viaTor: true });
  assert.equal(validateNode("8.8.8.8:38081", "stagenet").viaTor, true);
  assert.equal(validateNode("192.168.1.20", "stagenet").viaTor, false);
  assert.equal(validateNode("192.168.1.20", "stagenet").address,
    "192.168.1.20:38081");
});

test("XMR amounts and URIs use exact piconero", () => {
  assert.equal(parseXmrAmount("0.05"), 50_000_000_000);
  assert.equal(parseXmrAmount("1.000000000001"), 1_000_000_000_001);
  assert.equal(formatXmr(50_000_000_000), "0.05");
  assert.equal(moneroUri("5abc", 50_000_000_000), "monero:5abc?tx_amount=0.05");
  assert.equal(moneroUri("5abc", 0), "monero:5abc");
  assert.throws(() => parseXmrAmount("0.0000000000001"));
  assert.throws(() => parseXmrAmount("1e3"));
});

test("enabling creates a view-only wallet and a dedicated account", async () => {
  const store = new Store(":memory:");
  try {
    await assert.rejects(enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: "cd".repeat(32), node,
    }), /refused the keys/);
    assert.equal(store.get(MONERO, MoneroSettings), undefined);

    const settings = await enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node, restoreHeight: 1600000,
    });
    assert.equal(settings.network, "stagenet");
    assert.equal(settings.account, 1);
    assert.equal(wallet.accounts, 2);
    assert.deepEqual(wallet.daemon, {
      address: node, trusted: false, ssl_support: "disabled", proxy: "tor:9050",
    });
    // The view key is handed to the wallet, never stored by Tekiya.
    assert.ok(!JSON.stringify(store.get(MONERO, MoneroSettings)).includes(VIEW_KEY));

    // Enabling again reopens the same wallet; another address is refused.
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    assert.ok(wallet.calls.includes("open_wallet"));
    await assert.rejects(enableMonero(store, "testnet4", {
      address: `5${"B".repeat(94)}`, viewKey: VIEW_KEY, node,
    }), /another address/);
    assert.throws(() => validateNode("example.org", "mainnet"));

    // A clearnet stagenet node is set up with the Tor proxy.
    const other = new Store(":memory:");
    try {
      await enableMonero(other, "testnet4", {
        address: PRIMARY, viewKey: VIEW_KEY, node: "stagenet.community.rino.io:38081",
      });
      assert.deepEqual(wallet.daemon, {
        address: "stagenet.community.rino.io:38081", trusted: false,
        ssl_support: "disabled", proxy: "tor:9050",
      });
    } finally {
      other.close();
    }
  } finally {
    store.close();
  }
});

test("subaddresses are issued once per request and paid at 10 confirmations", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    const first = await allocateMonero(store, "order_xmr_000000001", 50_000_000_000);
    assert.deepEqual(
      await allocateMonero(store, "order_xmr_000000001", 50_000_000_000), first,
    );
    await assert.rejects(
      allocateMonero(store, "order_xmr_000000001", 1), /different amount/,
    );
    const second = await allocateMonero(store, "order_xmr_000000002", 0);
    assert.notEqual(second.address, first.address);

    wallet.transfers = {
      in: [
        { amount: 30_000_000_000, confirmations: 12,
          subaddr_index: { major: 1, minor: first.subaddr_index } },
        { amount: 20_000_000_000, confirmations: 3,
          subaddr_index: { major: 1, minor: first.subaddr_index } },
        // Account 0 belongs to the merchant's own use; ignored.
        { amount: 9, confirmations: 50, subaddr_index: { major: 0, minor: 1 } },
      ],
      pool: [{ amount: 1_000, confirmations: 0,
        subaddr_index: { major: 1, minor: second.subaddr_index } }],
    };
    await syncMonero(store);
    let status = store.xmrPaymentStatus("order_xmr_000000001");
    assert.equal(status?.confirmedAtomic, 30_000_000_000);
    assert.equal(status?.pendingAtomic, 20_000_000_000);
    assert.equal(status?.state, "seen");
    assert.equal(store.xmrPaymentStatus("order_xmr_000000002")?.state, "seen");

    wallet.transfers.in[1] = { amount: 20_000_000_000, confirmations: 10,
      subaddr_index: { major: 1, minor: first.subaddr_index } };
    await syncMonero(store);
    status = store.xmrPaymentStatus("order_xmr_000000001");
    assert.equal(status?.state, "paid");
  } finally {
    wallet.transfers = { in: [], pool: [] };
    store.close();
  }
});

test("Monero pauses after a long run of unpaid subaddresses", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    for (let i = 1; i <= XMR_GAP_LIMIT; i++) {
      store.insertXmr({
        request_id: `bulk_${String(i).padStart(12, "0")}`, subaddr_index: 1000 + i,
        address: `addr${i}`, amount_atomic: 0, created_at: "now",
      });
    }
    await assert.rejects(
      allocateMonero(store, "order_xmr_000000099", 0),
      (error: unknown) => error instanceof Unavailable,
    );
    store.recordXmrReceived(1000 + XMR_GAP_LIMIT, 1, 0);
    await allocateMonero(store, "order_xmr_000000099", 0);
  } finally {
    store.close();
  }
});

test("the API creates and reports Monero requests", async () => {
  const store = new Store(":memory:");
  const api = createServer((req, res) => void handleApi(req, res, store, "testnet4"));
  try {
    store.insert("config", {
      network: "testnet4", seedHex: "11".repeat(64),
      merchantCode: "PM8TJSBiQmNQDwTk6zLRcXjYJdaMpq9wzv9n6hhxStX4Fm2nLKbbgVDE9nDGpKVSvBnmaaEXFnBbHQyn9Wf6ExUBpe8QgjWyRqWWQwGEqXaGw7WSvMXN",
      onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
    });
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await new Promise<void>(done => api.listen(0, "127.0.0.1", done));
    const base = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
    const headers = {
      authorization: `Bearer ${"33".repeat(32)}`,
      "content-type": "application/json",
      "idempotency-key": "order_api_xmr_0001",
    };
    const created = await (await fetch(`${base}/v1/payment-requests`, {
      method: "POST", headers,
      body: JSON.stringify({ asset: "XMR", amountAtomic: 50_000_000_000 }),
    })).json() as Record<string, unknown>;
    assert.equal(created.asset, "XMR");
    assert.equal(created.network, "stagenet");
    assert.equal(created.status, "pending");
    assert.match(String(created.uri), /^monero:7.*\?tx_amount=0\.05$/);

    const read = await (await fetch(
      `${base}/v1/payment-requests/order_api_xmr_0001`, { headers },
    )).json() as Record<string, unknown>;
    assert.equal(read.address, created.address);

    const status = await (await fetch(`${base}/v1/status`, { headers }))
      .json() as { assets: { XMR: { enabled: boolean; issuing: boolean } } };
    assert.deepEqual(
      [status.assets.XMR.enabled, status.assets.XMR.issuing], [true, true],
    );
  } finally {
    api.close();
    store.close();
  }
});
