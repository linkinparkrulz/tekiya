import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Unavailable } from "../src/config.js";
import {
  MONERO, MONERO_RESERVATION, MONERO_PENDING_SETUP, MoneroSettings, XMR_GAP_LIMIT, allocateMonero, enableMonero,
  callWallet, configuredMoneroSettings, disableMonero, moneroSettings, xmrBlocker,
  formatXmr, moneroUri, parseXmrAmount, syncMonero, validateNode, recoverMonero, MoneroRpcError,
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
    // Like monero-wallet-rpc: everything but creating or opening a wallet
    // needs an open wallet.
    if (!["generate_from_keys", "open_wallet"].includes(method) && !wallet.open) {
      return fail(-13, "No wallet file");
    }
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
        wallet.next.clear();
        return reply({ address: PRIMARY, info: "" });
      }
      case "open_wallet":
        if (!wallet.files.has(String(params.filename))) {
          return fail(-1, "Failed to open wallet");
        }
        wallet.open = String(params.filename);
        return reply({});
      case "store": return reply({});
      case "get_address": return reply({ address: PRIMARY,
        addresses: Array.from({ length: (wallet.next.get(Number(params.account_index)) ?? 0) + 1 },
          (_, address_index) => ({ address_index,
            address: `7${String(params.account_index)}${String(address_index).padStart(93, "x")}` })),
      });
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

test("ownership works without a container machine-id", async t => {
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === "/etc/machine-id") {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await allocateMonero(store, "container_missing_id", 0);
  } finally {
    store.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("queued identical IDs re-read the committed mapping", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    const before = wallet.calls.filter(c => c === "create_address").length;
    const results = await Promise.all(Array.from({ length: 3 }, () =>
      allocateMonero(store, "queued_identical_id", 1)));
    assert.deepEqual(results[0], results[1]);
    assert.deepEqual(results[0], results[2]);
    assert.equal(wallet.calls.filter(c => c === "create_address").length, before + 1);
  } finally { store.close(); }
});

test("RPC outages are unavailable, not invalid caller input", async () => {
  const url = process.env.NYM_MONERO_RPC;
  try {
    process.env.NYM_MONERO_RPC = "http://127.0.0.1:0/json_rpc";
    await assert.rejects(callWallet("get_height"), Unavailable);
  } finally { process.env.NYM_MONERO_RPC = url; }
  assert.ok(new MoneroRpcError(-1, "wallet failure") instanceof Unavailable);
});

test("committed retries need neither enabled issuance nor an available wallet", async () => {
  const store = new Store(":memory:");
  const offline = async () => { assert.fail("committed retry called RPC"); };
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    const id = "committed_retry_001";
    const allocation = await allocateMonero(store, id, 1);
    assert.deepEqual(await allocateMonero(store, id, 1, offline), allocation);
    disableMonero(store);
    store.replace(MONERO_RESERVATION, { requestId: "unrelated", amountAtomic: 0 });
    assert.deepEqual(await allocateMonero(store, id, 1, offline), allocation);
    await assert.rejects(allocateMonero(store, id, 2, offline), /different amount/);
    await assert.rejects(allocateMonero(store, id, -1, offline), /amountAtomic/);
  } finally { store.close(); }
});

test("queued committed retries return after disable without RPC", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    const id = "queued_disabled_001";
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const first = assert.rejects(allocateMonero(store, id, 1, async (method, params) => {
      if (method === "store") {
        await gate;
        disableMonero(store);
      }
      return callWallet(method, params);
    }), /disabled/);
    const retry = allocateMonero(store, id, 1, async () => {
      assert.fail("queued committed retry called RPC");
    });
    release();
    await first;
    assert.deepEqual(await retry, store.findXmr(id));
    assert.equal(store.get(MONERO_RESERVATION, MoneroSettings.pick({}).passthrough()), undefined);
  } finally { store.close(); }
});

test("daemon configuration retries on an already reopened wallet", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    wallet.open = undefined;
    wallet.daemon = undefined;
    await assert.rejects(syncMonero(store, async (method, params) => {
      if (method === "set_daemon") throw new Error("daemon unavailable");
      return callWallet(method, params);
    }), /daemon unavailable/);
    assert.ok(wallet.open);
    assert.equal(wallet.daemon, undefined);
    await syncMonero(store);
    assert.ok(wallet.daemon);
    wallet.daemon = undefined;
    await allocateMonero(store, "daemon_retry_000001", 0);
    assert.ok(wallet.daemon);
    for (const operation of [syncMonero, (s: Store, rpc: typeof callWallet) =>
      allocateMonero(s, "wrong_wallet_00001", 0, rpc)]) {
      wallet.open = undefined;
      await assert.rejects(operation(store, async (method, params) => {
        assert.notEqual(method, "set_daemon", "must verify identity before configuring daemon");
        if (method === "get_address") return { address: "wrong wallet" };
        return callWallet(method, params);
      }), /different address/);
    }
  } finally { store.close(); }
});

test("recovered burned indices block issuance without contacting the wallet", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await assert.rejects(allocateMonero(store, "burned_indices_001", 0, async (method, params) => {
      const result = await callWallet(method, params);
      if (method === "create_address") {
        wallet.next.set(1, XMR_GAP_LIMIT);
        throw new Error("lost response");
      }
      return result;
    }), /lost response/);
    await recoverMonero(store, { otherProcessesStopped: true });
    assert.deepEqual(store.xmrIndices(), []);
    assert.match(xmrBlocker(store)!, /paused/);
    await assert.rejects(allocateMonero(store, "burned_indices_002", 0, async () => {
      assert.fail("persisted gap should block before RPC");
    }), /index gap/);
    store.recordXmrReceived(XMR_GAP_LIMIT, 0, 1);
    assert.equal(xmrBlocker(store), undefined);
    await allocateMonero(store, "burned_indices_002", 0);
  } finally { store.close(); }
});

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
    assert.equal(configuredMoneroSettings(store), undefined);
    assert.equal(moneroSettings(store), undefined);

    const settings = await enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node, restoreHeight: 1600000,
    });
    assert.equal(settings.network, "stagenet");
    assert.equal(settings.account, 1);
    assert.equal(wallet.calls.at(-1), "store");
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
      address: PRIMARY, viewKey: VIEW_KEY, node, account: 2,
    }), /account cannot change/);
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

test("first enable preserves recovery credentials and reservation when wallet store fails", async () => {
  const store = new Store(":memory:");
  let created: { filename: string; password: string } | undefined;
  try {
    await assert.rejects(enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node,
    }, async (method, params) => {
      const result = await callWallet(method, params);
      if (method === "generate_from_keys") {
        created = params as { filename: string; password: string };
      }
      if (method === "store") throw new Error("lost store response");
      return result;
    }), /lost store response/);
    assert.ok(created);
    assert.ok(wallet.files.has(created.filename));
    const settings = store.get(MONERO_PENDING_SETUP, MoneroSettings);
    assert.ok(settings);
    assert.equal(settings.enabled, false);
    assert.equal(settings.walletFile, created.filename);
    assert.equal(settings.walletPassword, created.password);
    assert.ok(settings.walletPassword);
    assert.equal(moneroSettings(store), undefined);
    const reservation = store.get(MONERO_RESERVATION, MoneroSettings.pick({}).passthrough());
    assert.equal(reservation?.phase, "mutation");
    assert.equal(reservation?.active, false);
    await assert.rejects(enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node,
    }), /reserved/);
    assert.equal(configuredMoneroSettings(store), undefined);
    assert.deepEqual(store.get(MONERO_RESERVATION,
      MoneroSettings.pick({}).passthrough()), reservation);
  } finally {
    store.close();
  }
});

test("sync and allocation queue behind live owners", async () => {
  const store = new Store(":memory:");
  let release!: () => void;
  let pending: ReturnType<typeof allocateMonero> | undefined;
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    const reservationSchema = MoneroSettings.pick({}).passthrough();
    const result = await syncMonero(store);
    assert.equal(result?.height, 1700000);
    assert.equal(store.get(MONERO_RESERVATION, reservationSchema), undefined);

    const gate = new Promise<void>(resolve => { release = resolve; });
    pending = allocateMonero(store, "order_sync_00000001", 1, async (method, params) => {
      if (method === "get_height") await gate;
      return callWallet(method, params);
    });
    const held = store.get(MONERO_RESERVATION, reservationSchema);
    assert.equal(held?.requestId, "order_sync_00000001");
    const queued = syncMonero(store);
    assert.deepEqual(store.get(MONERO_RESERVATION, reservationSchema), held);
    release();
    await pending;
    await queued;
    assert.equal(store.get(MONERO_RESERVATION, reservationSchema), undefined);
  } finally {
    release?.();
    await pending;
    store.close();
  }
});

test("failed refresh releases its own read reservation and permits retry", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await allocateMonero(store, "order_refresh_000001", 1);
    await assert.rejects(syncMonero(store, async (method, params) => {
      assert.equal(store.get(MONERO_RESERVATION,
        MoneroSettings.pick({}).passthrough())?.requestId, "refresh");
      if (method === "get_transfers") throw new Error("failed transfer read");
      return callWallet(method, params);
    }), /failed transfer read/);
    assert.equal(store.get(MONERO_RESERVATION,
      MoneroSettings.pick({}).passthrough()), undefined);
    assert.equal((await syncMonero(store))?.height, 1700000);
    await allocateMonero(store, "order_refresh_000002", 1);
  } finally {
    store.close();
  }
});

test("subaddresses are issued once per request and paid at 10 confirmations", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    const first = await allocateMonero(store, "order_xmr_000000001", 50_000_000_000);
    assert.equal(wallet.calls.at(-1), "store");
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
    disableMonero(store);
    assert.equal(moneroSettings(store), undefined);
    assert.equal(configuredMoneroSettings(store)?.enabled, false);
    await syncMonero(store);
    status = store.xmrPaymentStatus("order_xmr_000000001");
    assert.equal(status?.state, "paid");
  } finally {
    wallet.transfers = { in: [], pool: [] };
    store.close();
  }
});

test("reservations serialize callers, reject amount conflicts, and fail closed on RPC failure", async () => {
  const store = new Store(":memory:");
  const other = new Store(":memory:");
  try {
    const settings = await enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node,
    });
    other.replace(MONERO, settings);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const id = "order_lock_00000001";
    const pending = allocateMonero(store, id, 1, async (method, params) => {
      if (method === "get_height") await gate;
      return callWallet(method, params);
    });
    await assert.rejects(allocateMonero(store, id, 2), /different amount/);
    const queued = allocateMonero(store, "order_lock_00000002", 1);
    // Identical ids in separate databases must not share an in-memory promise.
    const separate = await allocateMonero(other, id, 2);
    assert.equal(separate.amount_atomic, 2);
    release();
    assert.equal((await pending).amount_atomic, 1);
    await queued;
    await assert.rejects(allocateMonero(store, "order_crash_0000001", 0,
      async (method, params) => {
        if (method === "store") throw new Error("simulated crash before save");
        return callWallet(method, params);
      }), /simulated crash/);
    assert.ok(store.get(MONERO_RESERVATION, MoneroSettings.pick({}).passthrough()));
    await assert.rejects(allocateMonero(store, "order_crash_0000002", 0), /reserved/);
    assert.equal(store.findXmr("order_crash_0000001"), undefined);
  } finally {
    store.close();
    other.close();
  }
});

test("skipped wallet indices count toward the gap even without allocation rows", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    wallet.next.set(1, XMR_GAP_LIMIT);
    const before = wallet.calls.filter(c => c === "create_address").length;
    await assert.rejects(allocateMonero(store, "order_skipped_00001", 0), /index gap/);
    assert.equal(wallet.calls.filter(c => c === "create_address").length, before);
  } finally {
    store.close();
  }
});

test("a failed reservation survives database reopen and excludes another connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tekiya-monero-"));
  const path = join(dir, "store.sqlite");
  let store = new Store(path);
  const other = new Store(path);
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await assert.rejects(allocateMonero(store, "order_durable_00001", 1,
      async (method, params) => {
        const result = await callWallet(method, params);
        if (method === "create_address") throw new Error("lost RPC response");
        return result;
      }), /lost RPC/);
    await assert.rejects(allocateMonero(other, "order_durable_00002", 0), /reserved/);
    store.close();
    store = new Store(path);
    await assert.rejects(allocateMonero(store, "order_durable_00001", 2), /different amount/);
    await assert.rejects(allocateMonero(store, "order_durable_00002", 0), /reserved/);
  } finally {
    store.close();
    other.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Monero pauses after a long run of unpaid subaddresses", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    for (let i = 1; i <= XMR_GAP_LIMIT; i++) {
      store.insertXmr({
        request_id: `bulk_${String(i).padStart(12, "0")}`, subaddr_index: i,
        address: `71${String(i).padStart(93, "x")}`, amount_atomic: 0, created_at: "now",
      });
    }
    await assert.rejects(
      allocateMonero(store, "order_xmr_000000099", 0),
      (error: unknown) => error instanceof Unavailable,
    );
    wallet.next.set(1, XMR_GAP_LIMIT);
    store.recordXmrReceived(XMR_GAP_LIMIT, 1, 0);
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

test("a restarted wallet service is reopened before use", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    wallet.open = undefined;
    wallet.daemon = undefined;
    wallet.calls = [];
    await allocateMonero(store, "order_xmr_restart_01", 0);
    const open = wallet.calls.indexOf("open_wallet");
    const daemon = wallet.calls.indexOf("set_daemon");
    assert.ok(open >= 0 && daemon > open, wallet.calls.join(","));
    assert.ok(wallet.daemon);
  } finally {
    store.close();
  }
});

test("invalid restore heights write nothing; unknown setup RPC errors stay pending", async () => {
  const store = new Store(":memory:");
  try {
    for (const restoreHeight of [-1, 1.5, NaN, Infinity]) {
      await assert.rejects(enableMonero(store, "testnet4", {
        address: PRIMARY, viewKey: VIEW_KEY, node, restoreHeight,
      }), /Restore height/);
      assert.equal(store.get(MONERO_PENDING_SETUP, MoneroSettings), undefined);
      assert.equal(store.get(MONERO_RESERVATION, MoneroSettings.pick({}).passthrough()), undefined);
    }
    await assert.rejects(enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node,
    }, async () => { throw new MoneroRpcError(-1, "disk error after creation"); }), /disk error/);
    assert.equal(configuredMoneroSettings(store), undefined);
    assert.ok(store.get(MONERO_PENDING_SETUP, MoneroSettings));
    await assert.rejects(syncMonero(store), /reconciliation/);
  } finally { store.close(); }
});

test("read owners are reclaimed only when dead; reviewed recovery handles foreign namespaces", async () => {
  const store = new Store(":memory:");
  const schema = MoneroSettings.pick({}).passthrough();
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    let reservation: Record<string, unknown> | undefined;
    await assert.rejects(allocateMonero(store, "read_failure_000001", 0, async () => {
      reservation = store.get(MONERO_RESERVATION, schema);
      throw new Error("read failed");
    }), /read failed/);
    assert.equal(store.get(MONERO_RESERVATION, schema), undefined);
    const owner = reservation!.owner as Record<string, unknown>;
    store.replace(MONERO_RESERVATION, { ...reservation, phase: "mutation" });
    await assert.rejects(recoverMonero(store, { otherProcessesStopped: true }), /may still be running/);
    store.replace(MONERO_RESERVATION, { ...reservation, owner: { ...owner, start: "not-this-process" } });
    await allocateMonero(store, "reclaimed_read_0001", 0);
    store.replace(MONERO_RESERVATION, { ...reservation, phase: "mutation",
      owner: { ...owner, host: "another-host" } });
    await recoverMonero(store, { otherProcessesStopped: true });
    assert.equal(store.get(MONERO_RESERVATION, schema), undefined);
  } finally { store.close(); }
});

test("recovery saves uncertain allocations and burns indices, never blindly clears", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await assert.rejects(allocateMonero(store, "uncertain_create_001", 1, async (method, params) => {
      const result = await callWallet(method, params);
      if (method === "create_address") throw new Error("lost response");
      return result;
    }), /lost response/);
    await assert.rejects(recoverMonero(store, { otherProcessesStopped: true }, async (method, params) => {
      if (method === "get_address") return { address: "wrong wallet", addresses: [] };
      return callWallet(method, params);
    }), /different address/);
    await assert.rejects(recoverMonero(store, { otherProcessesStopped: true }, async (method, params) => {
      if (method === "store") throw new Error("save failed");
      return callWallet(method, params);
    }), /save failed/);
    await recoverMonero(store, { otherProcessesStopped: true });
    assert.equal(store.findXmr("uncertain_create_001"), undefined);
    assert.equal((await allocateMonero(store, "after_recovery_0001", 0)).subaddr_index, 2);
    await assert.rejects(allocateMonero(store, "uncertain_create_002", 0, async (method, params) => {
      if (method === "create_address") throw new Error("not sent");
      return callWallet(method, params);
    }), /not sent/);
    await assert.rejects(recoverMonero(store, { otherProcessesStopped: true }), /not present/);
  } finally { store.close(); }
});

test("wallet identity and stored mappings are verified for issuance and monitoring", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await allocateMonero(store, "identity_check_0001", 0);
    const badMapping = async (method: string, params?: object) => {
      if (method === "get_address" && (params as { account_index: number }).account_index === 1) {
        return { addresses: [{ address_index: 0, address: "wrong" }] };
      }
      return callWallet(method, params);
    };
    await assert.rejects(syncMonero(store, badMapping), /mapping/);
    await assert.rejects(allocateMonero(store, "identity_check_0002", 0, badMapping), /mapping/);
    await syncMonero(store);
  } finally { store.close(); }
});

test("disable wins against in-flight enable and allocation", async () => {
  const store = new Store(":memory:");
  try {
    const settings = await enableMonero(store, "testnet4", {
      address: PRIMARY, viewKey: VIEW_KEY, node,
    }, async (method, params) => {
      if (method === "store") disableMonero(store);
      return callWallet(method, params);
    });
    assert.equal(settings.enabled, false);
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await assert.rejects(allocateMonero(store, "disable_race_000001", 0, async (method, params) => {
      if (method === "get_height") disableMonero(store);
      return callWallet(method, params);
    }), /disabled/);
    assert.equal(store.findXmr("disable_race_000001"), undefined);
    await enableMonero(store, "testnet4", { address: PRIMARY, viewKey: VIEW_KEY, node });
    await assert.rejects(allocateMonero(store, "disable_race_000002", 0, async (method, params) => {
      if (method === "store") disableMonero(store);
      return callWallet(method, params);
    }), /disabled/);
    assert.ok(store.findXmr("disable_race_000002"));
  } finally { store.close(); }
});
