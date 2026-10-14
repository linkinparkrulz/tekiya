import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Transaction } from "bitcoinjs-lib";
import { z } from "zod";
import { profiles, type Config } from "../src/config.js";
import {
  buildNotification, createWallet, deriveAddress, identityStatement, messages,
} from "../src/bitcoin.js";
import { handleApi } from "../src/api.js";
import { Store, paymentState } from "../src/store.js";

const network = "testnet4";
const merchant = createWallet("22".repeat(64), network).sender;
const config: Config = {
  network, seedHex: "11".repeat(64), merchantCode: merchant.toBase58(),
  onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
};
const auth = { authorization: `Bearer ${config.apiToken}` };

function installation(approved = true): Store {
  const store = new Store(":memory:");
  store.insert("config", config);
  const funding = new Transaction();
  funding.addInput(Buffer.alloc(32, 7), 0);
  funding.addOutput(createWallet(config.seedHex, network).fundingScript, 50000n);
  const pending = buildNotification(config, funding.toHex(), 0, 1000);
  store.insert("notification", pending);
  store.insert("notification-health", {
    txid: pending.txid, pairingGeneration: store.pairingGeneration(),
    confirmations: 1, checkedAt: new Date().toISOString(),
  });
  if (approved) {
    const signature = Buffer.from(messages.sign(
      identityStatement(config, pending), merchant.getNotificationPrivateKey(),
      true, profiles[network].bitcoin.messagePrefix,
    )).toString("base64");
    store.insert("approval", { txid: pending.txid, signature, createdAt: "now" });
  }
  for (let i = 0; i < 5; i++) store.register(i, deriveAddress(config, i));
  return store;
}

async function serve(store: Store): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => void handleApi(req, res, store, network));
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

async function call(
  base: string, path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
) {
  const response = await fetch(base + path, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const create = (base: string, key: string, amountSats: number) =>
  call(base, "/v1/payment-requests", {
    method: "POST",
    headers: { ...auth, "idempotency-key": key },
    body: { amountSats },
  });

test("payment state follows confirmed and pending amounts", () => {
  assert.equal(paymentState(5000, 0, 0), "pending");
  assert.equal(paymentState(5000, 0, 5000), "seen");
  assert.equal(paymentState(5000, 2000, 3000), "seen");
  assert.equal(paymentState(5000, 2000, 0), "underpaid");
  assert.equal(paymentState(5000, 6000, 0), "paid");
  assert.equal(paymentState(0, 0, 0), "pending");
  assert.equal(paymentState(0, 1, 0), "paid");
});

test("a store can create a request and follow it to paid", async () => {
  const store = installation();
  const { server, base } = await serve(store);
  try {
    assert.deepEqual((await call(base, "/v1/status")).body, {
      error: "Missing or wrong bearer token", code: "unauthorized",
    });
    assert.deepEqual(
      (await call(base, "/v1/status", { headers: auth })).body,
      {
        network, ready: true, issuing: true, reason: null,
        assets: {
          BTC: { issuing: true, reason: null },
          XMR: { enabled: false, issuing: false, reason: "Monero is not enabled" },
        },
      },
    );

    const created = await create(base, "order_0000000000000001", 5000);
    assert.equal(created.status, 200);
    assert.equal(created.body.status, "pending");
    assert.equal(created.body.address, deriveAddress(config, 0));
    assert.deepEqual(created.body.received, {
      confirmedSats: 0, unconfirmedSats: 0, confirmedAtomic: 0, unconfirmedAtomic: 0,
    });
    assert.equal(created.body.asset, "BTC");

    const path = "/v1/payment-requests/order_0000000000000001";
    store.recordReceived(0, 0, 5000);
    assert.equal((await call(base, path, { headers: auth })).body.status, "seen");

    store.recordReceived(0, 5000, 0);
    store.recordPayment(0, "ab".repeat(32), 154100);
    const paid = (await call(base, path, { headers: auth })).body;
    assert.equal(paid.status, "paid");
    assert.equal(paid.firstConfirmedBlock, 154100);
    assert.equal(typeof paid.checkedAt, "string");

    // Same key and amount returns the same request; another amount is refused.
    assert.equal((await create(base, "order_0000000000000001", 5000)).body.address,
      created.body.address);
    const conflict = await create(base, "order_0000000000000001", 6000);
    assert.equal(conflict.status, 400);
    assert.equal(conflict.body.code, "invalid_request");

    const unknown = await call(base, "/v1/payment-requests/nope", { headers: auth });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "not_found");
    assert.equal((await call(base, "/v1/other", { headers: auth })).status, 404);
  } finally {
    server.close();
    store.close();
  }
});

test("the store is told why issuance is paused", async () => {
  const store = installation();
  const { server, base } = await serve(store);
  try {
    for (let i = 1; i <= 3; i++) {
      assert.equal((await create(base, `order_000000000000000${i}`, 1000)).status, 200);
    }
    const refused = await create(base, "order_0000000000000004", 1000);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "unavailable");
    const status = (await call(base, "/v1/status", { headers: auth })).body;
    assert.equal(status.issuing, false);
    assert.match(String(status.reason), /lookahead/);
  } finally {
    server.close();
    store.close();
  }
});

test("notification health blocks new allocations but preserves existing retries", async () => {
  const store = installation();
  const { server, base } = await serve(store);
  try {
    const id = "order_existing_health";
    const created = await create(base, id, 1000);
    assert.equal(created.status, 200);
    const pending = store.get("notification", z.object({ txid: z.string() }))!;
    const healthy = {
      txid: pending.txid, pairingGeneration: store.pairingGeneration(),
      confirmations: 1, checkedAt: new Date().toISOString(),
    };
    for (const [name, unhealthy, reason] of [
      ["unconfirmed", { ...healthy, confirmations: 0 }, /no longer confirmed/],
      ["stale", { ...healthy, checkedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }, /stale/],
      ["missing", undefined, /verification pending/],
      ["pairing", { ...healthy, pairingGeneration: "different-pairing" }, /verification pending/],
      ["txid", { ...healthy, txid: "ff".repeat(32) }, /verification pending/],
    ] as const) {
      store.remove("notification-health");
      if (unhealthy) store.insert("notification-health", unhealthy);
      const refused = await create(base, `order_health_${name}`, 1000);
      assert.equal(refused.status, 503, name);
      assert.equal(refused.body.code, "unavailable", name);
      assert.match(String(refused.body.error), reason, name);
      assert.equal(store.findAllocation(`order_health_${name}`), undefined, name);
      const status = (await call(base, "/v1/status", { headers: auth })).body;
      assert.equal(status.issuing, false, name);
      assert.match(String(status.reason), reason, name);
      assert.deepEqual(await create(base, id, 1000), created, name);
      assert.equal(store.nextIndex(), 1, name);
    }
    store.replace("notification-health", healthy);
    assert.equal((await create(base, "order_health_recovered", 1000)).status, 200);
  } finally {
    server.close();
    store.close();
  }
});

test("an unapproved installation is unavailable, not an error", async () => {
  const store = installation(false);
  const { server, base } = await serve(store);
  try {
    const refused = await create(base, "order_0000000000000001", 1000);
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "unavailable");
    const status = (await call(base, "/v1/status", { headers: auth })).body;
    assert.equal(status.ready, false);
    assert.equal(status.issuing, false);
  } finally {
    server.close();
    store.close();
  }
});
