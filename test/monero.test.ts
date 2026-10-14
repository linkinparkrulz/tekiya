import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Unavailable } from "../src/config.js";
import {
  MONERO, MoneroSettings, XMR_GAP_LIMIT, allocateMonero, enableMonero,
  callWallet, configuredMoneroSettings, disableMonero, moneroSettings, xmrBlocker,
  formatXmr, moneroUri, parseXmrAmount, syncMonero, validateNode, MoneroRpcError,
} from "../src/monero.js";
import { decodePrimaryAddress, deriveSubaddress } from "../src/monero-address.js";
import { Store } from "../src/store.js";
import { handleApi } from "../src/api.js";

// A throwaway stagenet wallet (see monero-address.test.ts).
const PRIMARY = "5AUnubSxNrKNcaKrNGpDK66XM2d7H5wR963yVx5Ps6aKSbUVYZTxWD1AqqBYDDd3DiaNKt42RZNaZGTGv3cwtxV6Q8mzane";
const VIEW_KEY = "a5ce85c7c6d283a529172b0c25938330c703e5c6590dfe9c5a0ccc145e087b02";
// Its subaddresses 1/1 and 1/5, from the reference wallet.
const SUB_1_1 = "78VE3oYkw34PwFvLepuvtnFzKg3hLTRJQVWaqXJt4xug1z6zJ3H63PEjhewEZsfknL4RiYfsqYNsVQM1i3GyJ6Z14dAQkGR";
const SUB_1_5 = "7BphSzMDW9dbzgs3cmE21nJaQuzvDbjGtLctkmti24CB9xXN44o5fum5Hp2zcQPovkUNQwbnKPemj166cYrrRD3w1s2KpXS";
// Another wallet's primary address (the mainnet vector's).
const OTHER = "44ZSdpMPz8hNot7sLZfifG6A17W4n9EGHfTbQAobkg4EgQ6XcebTXxpNKT6tMAFcu66kdH4pYQFb6AiTYMX7F1fVMz8uSUp";

const primary = decodePrimaryAddress(PRIMARY, "stagenet")!;
const subaddress = (account: number, index: number) =>
  deriveSubaddress(primary, VIEW_KEY, account, index, "stagenet");

// A stand-in for monero-wallet-rpc's JSON-RPC interface. It watches
// subaddresses 0..watched of each account, as the real wallet's lookahead.
const wallet = {
  files: new Set<string>(),
  open: undefined as string | undefined,
  accounts: 1,
  watched: 200,
  transfers: { in: [] as unknown[], pool: [] as unknown[] },
  calls: [] as string[],
  daemon: undefined as unknown,
};
const cache = new Map<string, string>();
const watchedIndex = (address: string) => {
  for (const major of [1, 2]) {
    for (let minor = 1; minor <= wallet.watched; minor++) {
      const key = `${major}/${minor}`;
      if (!cache.has(key)) cache.set(key, subaddress(major, minor));
      if (cache.get(key) === address) return { major, minor };
    }
  }
  return undefined;
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
        wallet.accounts = 1;
        return reply({ address: PRIMARY, info: "" });
      }
      case "open_wallet":
        if (!wallet.files.has(String(params.filename))) {
          return fail(-1, "Failed to open wallet");
        }
        wallet.open = String(params.filename);
        return reply({});
      case "store": return reply({});
      case "get_address": return reply({ address: PRIMARY, addresses: [] });
      case "get_address_index": {
        const index = watchedIndex(String(params.address));
        return index ? reply({ index })
          : fail(-2, "Address doesn't belong to the wallet");
      }
      case "get_height": return reply({ height: 1700000 });
      case "get_accounts":
        return reply({ subaddress_accounts: Array.from(
          { length: wallet.accounts }, (_, account_index) => ({ account_index }),
        ) });
      case "create_account":
        wallet.accounts++;
        return reply({ account_index: wallet.accounts - 1 });
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
const keys = { address: PRIMARY, viewKey: VIEW_KEY, node };

// Wallet calls that would change it; issuing must make none.
const MUTATIONS = ["generate_from_keys", "create_account", "create_address", "store"];

test("RPC outages are unavailable, not invalid caller input", async () => {
  const url = process.env.NYM_MONERO_RPC;
  try {
    process.env.NYM_MONERO_RPC = "http://127.0.0.1:0/json_rpc";
    await assert.rejects(callWallet("get_height"), Unavailable);
  } finally { process.env.NYM_MONERO_RPC = url; }
  assert.ok(new MoneroRpcError(-1, "wallet failure") instanceof Unavailable);
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

test("enabling checks the keys locally, then sets up the watch wallet", async () => {
  const store = new Store(":memory:");
  try {
    wallet.calls = [];
    // A view key from another wallet is refused before the wallet is asked.
    await assert.rejects(enableMonero(store, "testnet4", {
      ...keys, viewKey: "cd".repeat(31) + "0c",
    }), /does not belong/);
    await assert.rejects(enableMonero(store, "testnet4", {
      ...keys, address: PRIMARY.slice(0, 94) + (PRIMARY.endsWith("e") ? "f" : "e"),
    }), /check for typos/);
    assert.equal(wallet.calls.length, 0);
    assert.equal(configuredMoneroSettings(store), undefined);

    const settings = await enableMonero(store, "testnet4", {
      ...keys, restoreHeight: 1600000,
    });
    assert.equal(settings.network, "stagenet");
    assert.equal(settings.account, 1);
    assert.equal(settings.viewKey, VIEW_KEY);
    assert.equal(wallet.accounts, 2);
    assert.deepEqual(wallet.daemon, {
      address: node, trusted: false, ssl_support: "disabled", proxy: "tor:9050",
    });

    // Enabling again reopens the same wallet; changes of wallet are refused.
    await enableMonero(store, "testnet4", keys);
    assert.ok(wallet.calls.includes("open_wallet"));
    await assert.rejects(enableMonero(store, "testnet4", { ...keys, account: 2 }),
      /account cannot change/);
    assert.throws(() => validateNode("example.org", "mainnet"));

    // A clearnet stagenet node is set up with the Tor proxy.
    const other = new Store(":memory:");
    try {
      await enableMonero(other, "testnet4", {
        ...keys, node: "stagenet.community.rino.io:38081",
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

test("a failed setup step is simply retried with the same wallet", async () => {
  const store = new Store(":memory:");
  try {
    const files = wallet.files.size;
    await assert.rejects(enableMonero(store, "testnet4", keys, async (method, params) => {
      if (method === "set_daemon") throw new Unavailable("node unreachable");
      return callWallet(method, params);
    }), /node unreachable/);
    assert.equal(configuredMoneroSettings(store), undefined);
    await enableMonero(store, "testnet4", keys);
    assert.equal(wallet.files.size, files + 1);
    assert.ok(moneroSettings(store));
  } finally { store.close(); }
});

test("issuing derives the address and never changes the wallet", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", keys);
    wallet.calls = [];
    const first = await allocateMonero(store, "order_xmr_000000001", 50_000_000_000);
    assert.equal(first.subaddr_index, 1);
    assert.equal(first.address, SUB_1_1);
    for (let i = 2; i <= 5; i++) {
      await allocateMonero(store, `order_xmr_00000000${i}`, 0);
    }
    assert.equal(store.findXmr("order_xmr_000000005")?.address, SUB_1_5);
    assert.deepEqual(wallet.calls.filter(call => MUTATIONS.includes(call)), []);
  } finally { store.close(); }
});

test("requests are idempotent and concurrent requests get distinct indices", async () => {
  const store = new Store(":memory:");
  const offline = async () => { assert.fail("committed retry called RPC"); };
  try {
    await enableMonero(store, "testnet4", keys);
    const same = await Promise.all(Array.from({ length: 3 }, () =>
      allocateMonero(store, "queued_identical_id", 1)));
    assert.deepEqual(same[0], same[1]);
    assert.deepEqual(same[0], same[2]);
    const distinct = await Promise.all(Array.from({ length: 4 }, (_, i) =>
      allocateMonero(store, `concurrent_order_${i}`, 0)));
    assert.deepEqual(
      [...new Set(distinct.map(a => a.subaddr_index))].sort(), [2, 3, 4, 5],
    );
    // A committed request needs neither the wallet nor enabled issuance.
    disableMonero(store);
    assert.deepEqual(await allocateMonero(store, "queued_identical_id", 1, offline), same[0]);
    await assert.rejects(allocateMonero(store, "queued_identical_id", 2, offline), /different amount/);
    await assert.rejects(allocateMonero(store, "queued_identical_id", -1, offline), /amountAtomic/);
    await assert.rejects(allocateMonero(store, "new_order_disabled", 0, offline), Unavailable);
  } finally { store.close(); }
});

test("an address the wallet does not watch is not issued", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", keys);
    await assert.rejects(allocateMonero(store, "unwatched_order_001", 0, async (method, params) => {
      if (method === "get_address_index") throw new MoneroRpcError(-2, "Address doesn't belong to the wallet");
      return callWallet(method, params);
    }), (error: unknown) => error instanceof Unavailable && /does not watch/.test(String(error)));
    await assert.rejects(allocateMonero(store, "mismatch_order_0001", 0, async (method, params) => {
      if (method === "get_address_index") return { index: { major: 1, minor: 7 } };
      return callWallet(method, params);
    }), /does not match/);
    assert.deepEqual(store.xmrIndices(), []);
    // A wallet outage leaves nothing behind: the next try just works.
    await assert.rejects(allocateMonero(store, "outage_order_00001", 0, async () => {
      throw new Unavailable("The Monero wallet service is not reachable");
    }), /not reachable/);
    assert.equal((await allocateMonero(store, "outage_order_00001", 0)).subaddr_index, 1);
  } finally { store.close(); }
});

test("subaddresses are paid at 10 confirmations", async () => {
  const store = new Store(":memory:");
  try {
    await enableMonero(store, "testnet4", keys);
    const first = await allocateMonero(store, "order_xmr_000000001", 50_000_000_000);
    const second = await allocateMonero(store, "order_xmr_000000002", 0);
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

    // Monitoring continues while issuing is switched off.
    wallet.transfers.in[1] = { amount: 20_000_000_000, confirmations: 10,
      subaddr_index: { major: 1, minor: first.subaddr_index } };
    disableMonero(store);
    assert.equal(moneroSettings(store), undefined);
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
    await enableMonero(store, "testnet4", keys);
    for (let i = 1; i <= XMR_GAP_LIMIT; i++) {
      store.insertXmr({
        request_id: `bulk_${String(i).padStart(12, "0")}`, subaddr_index: i,
        address: `fake-${i}`, amount_atomic: 0, created_at: "now",
      });
    }
    assert.match(xmrBlocker(store)!, /paused/);
    await assert.rejects(
      allocateMonero(store, "order_xmr_000000099", 0),
      (error: unknown) => error instanceof Unavailable,
    );
    store.recordXmrReceived(XMR_GAP_LIMIT, 1, 0);
    assert.equal(xmrBlocker(store), undefined);
    const next = await allocateMonero(store, "order_xmr_000000099", 0);
    assert.equal(next.subaddr_index, XMR_GAP_LIMIT + 1);
    assert.equal(next.address, subaddress(1, XMR_GAP_LIMIT + 1));
  } finally {
    store.close();
  }
});

test("installations without a stored view key ask for it once", async () => {
  const store = new Store(":memory:");
  try {
    const settings = await enableMonero(store, "testnet4", keys);
    const issued = await allocateMonero(store, "legacy_order_00001", 0);
    const { viewKey: _, ...legacy } = settings;
    store.replace(MONERO, legacy);
    assert.match(xmrBlocker(store)!, /Re-enter the view key/);
    await assert.rejects(allocateMonero(store, "legacy_order_00002", 0), /Re-enter/);
    // Payments to issued addresses are still followed.
    assert.ok(await syncMonero(store));

    // Keys that do not derive the issued addresses are refused.
    store.db.prepare("UPDATE xmr_allocations SET address = 'other' WHERE request_id = ?")
      .run(issued.request_id);
    await assert.rejects(enableMonero(store, "testnet4", keys), /already issued/);
    store.db.prepare("UPDATE xmr_allocations SET address = ? WHERE request_id = ?")
      .run(issued.address, issued.request_id);
    await enableMonero(store, "testnet4", keys);
    assert.equal(xmrBlocker(store), undefined);
    assert.equal((await allocateMonero(store, "legacy_order_00002", 0)).subaddr_index, 2);
  } finally { store.close(); }
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
    await enableMonero(store, "testnet4", keys);
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
    assert.equal(created.address, SUB_1_1);
    assert.equal(created.uri, `monero:${SUB_1_1}?tx_amount=0.05`);

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
    await enableMonero(store, "testnet4", keys);
    wallet.open = undefined;
    wallet.daemon = undefined;
    wallet.calls = [];
    await allocateMonero(store, "order_xmr_restart_01", 0);
    const open = wallet.calls.indexOf("open_wallet");
    const daemon = wallet.calls.indexOf("set_daemon");
    assert.ok(open >= 0 && daemon > open, wallet.calls.join(","));
    assert.ok(wallet.daemon);
    // A different wallet behind the same file is refused before use.
    wallet.open = undefined;
    await assert.rejects(syncMonero(store, async (method, params) => {
      if (method === "get_address") return { address: OTHER };
      return callWallet(method, params);
    }), /different address/);
  } finally {
    store.close();
  }
});

test("invalid restore heights are refused", async () => {
  const store = new Store(":memory:");
  try {
    for (const restoreHeight of [-1, 1.5, NaN, Infinity]) {
      await assert.rejects(enableMonero(store, "testnet4", { ...keys, restoreHeight }),
        /Restore height/);
    }
    assert.equal(configuredMoneroSettings(store), undefined);
  } finally { store.close(); }
});

test("settings stay readable", () => {
  assert.ok(MoneroSettings.safeParse({
    enabled: true, address: PRIMARY, network: "stagenet", node, account: 1,
    restoreHeight: 0, walletFile: "w", walletPassword: "p", enabledAt: "now",
  }).success);
});
