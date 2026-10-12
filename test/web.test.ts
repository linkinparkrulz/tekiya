import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { CSP, escape, page, qrSvg } from "../src/html.js";
import { handlePublic, parseBtcAmount } from "../src/web.js";
import { Profile, publicPaymentsEnabled } from "../src/config.js";
import { Store } from "../src/store.js";
import { createWallet, deriveAddress } from "../src/bitcoin.js";

test("payment-page storage is bounded and existing requests survive the cap", () => {
  const store = new Store(":memory:");
  try {
    for (let i = 0; i < 1000; i++) store.createWebRequest(`request_${i}`, "BTC", i);
    assert.throws(() => store.createWebRequest("overflow", "XMR", 0), /limit reached/);
    store.createWebRequest("request_0", "XMR", 100);
    assert.equal(store.findWebRequest("request_0")?.currency, "BTC");
    assert.equal(store.findWebRequest("overflow"), undefined);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM web_requests").get()?.count, 1000);
  } finally {
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
  store.createWebRequest(id, "BTC", 0);
  const server = createServer((req, res) => {
    void handlePublic(req, res, store, "testnet4");
  });
  try {
    for (const value of [undefined, "false", "1", "TRUE", "true"]) {
      if (value === undefined) delete process.env.NYM_PUBLIC_PAYMENTS;
      else process.env.NYM_PUBLIC_PAYMENTS = value;
      assert.equal(publicPaymentsEnabled(), value === "true");
    }
    delete process.env.NYM_PUBLIC_PAYMENTS;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(base)).status, 503);
    assert.equal((await fetch(`${base}/pay`, {
      method: "POST", body: `nonce=${"cd".repeat(16)}`,
    })).status, 503);
    assert.equal(store.findAllocation(`web_${"cd".repeat(16)}`), undefined);
    assert.equal((await fetch(`${base}/pay/${nonce}`)).status, 200);
    assert.equal((await fetch(`${base}/pay/${nonce}?coin=btc`)).status, 200);
    assert.equal((await fetch(`${base}/pay/${nonce}/coin`, {
      method: "POST", body: "coin=xmr", redirect: "manual",
    })).status, 503);
    assert.equal(store.findXmr(id), undefined);
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
  for (const bad of ["abc", "1e3", "-1", "0.000000001", "1,5", ".5"]) {
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
