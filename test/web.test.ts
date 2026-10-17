import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { CSP, escape, page, qrSvg } from "../src/html.js";
import { handlePublic, parseBtcAmount } from "../src/web.js";
import { Profile, PublicPayments, profiles, publicPaymentsEnabled } from "../src/config.js";
import { Transaction } from "bitcoinjs-lib";
import { dashboard } from "../src/admin-pages.js";
import { TEST_REQUEST_ID } from "../src/setup.js";
import { Store } from "../src/store.js";
import { buildNotification, createWallet, deriveAddress, identityStatement, messages } from "../src/bitcoin.js";

test("public payment settings persist without setup and override the environment", () => {
  const previous = process.env.NYM_PUBLIC_PAYMENTS;
  const directory = mkdtempSync(join(tmpdir(), "tekiya-public-"));
  const path = join(directory, "store.sqlite");
  let store = new Store(path);
  try {
    delete process.env.NYM_PUBLIC_PAYMENTS;
    assert.equal(publicPaymentsEnabled(store), false);
    process.env.NYM_PUBLIC_PAYMENTS = "true";
    assert.equal(publicPaymentsEnabled(store), true);
    store.replace("public-payments", PublicPayments.parse({ enabled: false }));
    store.close();
    store = new Store(path);
    assert.equal(publicPaymentsEnabled(store), false);
    const view = { store, network: "testnet4" as const, monitor: {}, detectedOnion: undefined };
    const disabled = dashboard(view);
    assert.match(disabled, /action="\/settings\/public-payments"/);
    assert.match(disabled, /name="enabled" value="true"/);
    assert.match(disabled, /name="reviewed" value="yes" required/);
    assert.match(disabled, /irreversible/);
    assert.doesNotMatch(disabled, /NYM_PUBLIC_PAYMENTS/);
    process.env.NYM_PUBLIC_PAYMENTS = "false";
    store.replace("public-payments", PublicPayments.parse({ enabled: true }));
    store.close();
    store = new Store(path);
    assert.equal(publicPaymentsEnabled(store), true);
    const enabled = dashboard({ ...view, store });
    assert.match(enabled, /name="enabled" value="false"/);
    assert.doesNotMatch(enabled, /name="reviewed"/);
    assert.throws(() => PublicPayments.parse({ enabled: "false" }));
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.NYM_PUBLIC_PAYMENTS;
    else process.env.NYM_PUBLIC_PAYMENTS = previous;
  }
});

test("web requests survive flag changes; blocked requests allocate nothing", async () => {
  const previous = process.env.NYM_PUBLIC_PAYMENTS;
  process.env.NYM_PUBLIC_PAYMENTS = "true";
  const store = new Store(":memory:");
  const merchant = createWallet("22".repeat(64), "testnet4").sender;
  const config = {
    network: "testnet4" as const, seedHex: "11".repeat(64),
    merchantCode: merchant.toBase58(),
    onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
  };
  store.insert("config", config);
  const funding = new Transaction();
  funding.addInput(Buffer.alloc(32, 7), 0);
  funding.addOutput(createWallet(config.seedHex, config.network).fundingScript, 50000n);
  const pending = buildNotification(config, funding.toHex(), 0, 1000);
  store.insert("notification", pending);
  const healthy = {
    txid: pending.txid, pairingGeneration: store.pairingGeneration(),
    confirmations: 1, checkedAt: new Date().toISOString(),
  };
  store.insert("notification-health", healthy);
  store.insert("approval", { txid: pending.txid, createdAt: "now", signature:
    Buffer.from(messages.sign(identityStatement(config, pending),
      merchant.getNotificationPrivateKey(), true,
      profiles.testnet4.bitcoin.messagePrefix)).toString("base64") });
  store.register(0, deriveAddress(config, 0));
  const server = createServer((req, res) => void handlePublic(req, res, store, "testnet4"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (nonce: string, amount: string) => fetch(`${base}/pay`, {
    method: "POST", body: new URLSearchParams({ nonce, amount }), redirect: "manual",
  });
  try {
    const btc = "ab".repeat(16);
    assert.equal((await post(btc, "0.1")).status, 303);
    assert.equal(store.findAllocation(`web_${btc}`)?.amount_sats, 10000000);
    store.register(1, deriveAddress(config, 1));
    const allocation = store.findAllocation(`web_${btc}`);
    for (const [name, unhealthy, reason] of [
      ["unconfirmed", { ...healthy, confirmations: 0 }, /no longer confirmed/],
      ["stale", { ...healthy, checkedAt: new Date(Date.now() - 11 * 60 * 1000).toISOString() }, /stale/],
      ["missing", undefined, /verification pending/],
      ["pairing", { ...healthy, pairingGeneration: "different-pairing" }, /verification pending/],
      ["txid", { ...healthy, txid: "ff".repeat(32) }, /verification pending/],
    ] as const) {
      store.remove("notification-health");
      if (unhealthy) store.insert("notification-health", unhealthy);
      const nonce = "34".repeat(16);
      const refused = await post(nonce, "0.1");
      assert.equal(refused.status, 503, name);
      assert.match(await refused.text(), reason, name);
      assert.equal(store.findAllocation(`web_${nonce}`), undefined, name);
      assert.equal((await post(btc, "0.1")).status, 303, name);
      assert.equal((await fetch(`${base}/pay/${btc}`)).status, 200, name);
      assert.deepEqual(store.findAllocation(`web_${btc}`), allocation, name);
      assert.equal(store.nextIndex(), 1, name);
    }
    store.replace("notification-health", healthy);
    // A resubmitted form keeps its first amount.
    assert.equal((await post(btc, "0.5")).status, 303);
    assert.equal(store.findAllocation(`web_${btc}`)?.amount_sats, 10000000);
    // Index 1 goes to another request; index 2 is not registered yet.
    store.allocate("api_request_000001", 0, index => deriveAddress(config, index));
    const blocked = "ef".repeat(16);
    assert.equal((await post(blocked, "1.00000001")).status, 400);
    assert.equal((await post(blocked, "0.1")).status, 503);
    assert.equal(store.findAllocation(`web_${blocked}`), undefined);
    store.register(2, deriveAddress(config, 2));
    const legacy = "12".repeat(16);
    store.allocate(`web_${legacy}`, 42, index => deriveAddress(config, index));
    process.env.NYM_PUBLIC_PAYMENTS = "false";
    // Existing requests stay readable and resubmittable while disabled.
    assert.equal((await post(legacy, "invalid")).status, 303);
    assert.equal((await post(btc, "invalid")).status, 303);
    assert.equal((await fetch(`${base}/pay/${legacy}`)).status, 200);
    store.register(3, deriveAddress(config, 3));
    store.recordPayment(2, "44".repeat(32), 100);
    store.allocate(TEST_REQUEST_ID, 0, index => deriveAddress(config, index));
    store.insert("pairing", {
      network: "testnet4", baseUrl: config.onion, apikey: "test",
    });
    const view = { store, network: config.network, monitor: {}, detectedOnion: undefined };
    const disabled = dashboard(view);
    assert.match(disabled, /Anonymous payments: .*disabled/);
    assert.match(disabled, /Public page: .*not issuing/);
    assert.doesNotMatch(disabled, /Monero/);
    process.env.NYM_PUBLIC_PAYMENTS = "true";
    assert.match(dashboard(view), /name="enabled" value="false"/);
  } finally {
    if (previous === undefined) delete process.env.NYM_PUBLIC_PAYMENTS;
    else process.env.NYM_PUBLIC_PAYMENTS = previous;
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
  }
});

test("anonymous creation is opt-in; disabling preserves existing private pages", async () => {
  const previous = process.env.NYM_PUBLIC_PAYMENTS;
  const store = new Store(":memory:");
  const config = {
    network: "testnet4" as const, seedHex: "11".repeat(64),
    merchantCode: createWallet("22".repeat(64), "testnet4").sender.toBase58(),
    onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
  };
  store.insert("config", config);
  const nonce = "ab".repeat(16);
  const id = `web_${nonce}`;
  store.register(0, deriveAddress(config, 0));
  store.allocate(id, 0, index => deriveAddress(config, index));
  const server = createServer((req, res) => {
    void handlePublic(req, res, store, "testnet4");
  });
  try {
    for (const value of [undefined, "false", "1", "TRUE", "true"]) {
      if (value === undefined) delete process.env.NYM_PUBLIC_PAYMENTS;
      else process.env.NYM_PUBLIC_PAYMENTS = value;
      assert.equal(publicPaymentsEnabled(), value === "true");
    }
    process.env.NYM_PUBLIC_PAYMENTS = "true";
    store.replace("public-payments", { enabled: false });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(base)).status, 503);
    assert.equal((await fetch(`${base}/pay`, {
      method: "POST", body: `nonce=${"cd".repeat(16)}`,
    })).status, 503);
    assert.equal(store.findAllocation(`web_${"cd".repeat(16)}`), undefined);
    assert.equal((await fetch(`${base}/pay/${nonce}`)).status, 200);
    assert.equal((await fetch(`${base}/pay/${"ef".repeat(16)}`)).status, 404);
  } finally {
    if (previous === undefined) delete process.env.NYM_PUBLIC_PAYMENTS;
    else process.env.NYM_PUBLIC_PAYMENTS = previous;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    store.db.close();
  }
});

test("BTC amounts convert to exact satoshis", () => {
  assert.equal(parseBtcAmount(""), 0);
  assert.equal(parseBtcAmount(" 0.0001 "), 10000);
  assert.equal(parseBtcAmount("0.00000001"), 1);
  assert.equal(parseBtcAmount("1"), 100000000);
  assert.equal(parseBtcAmount("0.1"), 10000000);
  for (const bad of ["abc", "1e3", "-1", "0.000000001", "1,5", ".5", "1.00000001", "2"]) {
    assert.throws(() => parseBtcAmount(bad), bad);
  }
});

test("markup is escaped", () => {
  assert.equal(
    escape(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
});

test("the inline stylesheet matches the CSP hash", () => {
  const css = /<style>([\s\S]*)<\/style>/.exec(page("t", ""))?.[1];
  assert.ok(css);
  const hash = createHash("sha256").update(css).digest("base64");
  assert.ok(CSP.includes(`'sha256-${hash}'`));
  assert.ok(!CSP.includes("unsafe"));
});

test("QR codes are self-contained SVG", () => {
  const svg = qrSvg("bitcoin:tb1qexample?amount=0.0001", "QR <label>");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.ok(svg.includes('aria-label="QR &lt;label&gt;"'));
  assert.ok(!/script|href|style/.test(svg));
});

test("profile text is plain, bounded and trimmed", () => {
  assert.deepEqual(
    Profile.parse({ name: "  Corner Café  " }),
    { name: "Corner Café", description: "" },
  );
  assert.throws(() => Profile.parse({ name: "  " }));
  assert.throws(() => Profile.parse({ name: "x".repeat(81) }));
  assert.throws(() => Profile.parse({ name: "a", description: "x".repeat(281) }));
  assert.throws(() => Profile.parse({ name: "line\nbreak" }));
});
