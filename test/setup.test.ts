import test from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { Transaction } from "bitcoinjs-lib";
import { Approval, profiles } from "../src/config.js";
import {
  buildNotification, createWallet, identityStatement, messages,
} from "../src/bitcoin.js";
import { currentStep } from "../src/admin-pages.js";
import { sameOrigin } from "../src/admin.js";
import {
  approve, initialize, normalizeOnion, parsePairing, suggestFee,
  usableFunding,
} from "../src/setup.js";
import { Store } from "../src/store.js";

const onion = `${"a".repeat(56)}.onion`;
const dojo = `http://${"d".repeat(56)}.onion`;

test("onion addresses are accepted with or without a scheme", () => {
  assert.equal(normalizeOnion(` ${onion}/ `), `http://${onion}`);
  assert.equal(normalizeOnion(`http://${onion}`), `http://${onion}`);
});

test("pairings are read in Dojo's export format and Tekiya's", () => {
  const exported = JSON.stringify({
    pairing: { type: "dojo.api", version: "1.27.0", apikey: "k",
      url: `${dojo}/test/v2` },
  });
  assert.deepEqual(parsePairing(exported, "testnet4"), {
    network: "testnet4", baseUrl: `${dojo}/test/v2`, apikey: "k",
  });
  assert.throws(() => parsePairing(exported, "mainnet"), /for testnet4/);

  const mainnet = JSON.stringify({ pairing: { apikey: "k", url: `${dojo}/v2` } });
  assert.equal(parsePairing(mainnet, "mainnet").network, "mainnet");

  const own = JSON.stringify({
    network: "testnet4", baseUrl: `${dojo}/test/v2/`, apikey: "k",
  });
  assert.equal(parsePairing(own, "testnet4").apikey, "k");

  assert.throws(() => parsePairing("not json", "testnet4"), /valid JSON/);
  assert.throws(() => parsePairing(JSON.stringify({
    pairing: { apikey: "k", url: "http://example.com/v2" },
  }), "mainnet"));
});

test("notification fees follow the Dojo estimate within builder limits", () => {
  assert.equal(suggestFee(undefined), 237);
  assert.equal(suggestFee(0.5), 237);
  assert.equal(suggestFee(2), 474);
  assert.equal(suggestFee(1000), 10000);
});

test("only confirmed funding within the limit is offered", () => {
  const utxo = (value: number, confirmations: number, vout = 0) =>
    ({ txid: "aa".repeat(32), vout, value, confirmations });
  assert.equal(usableFunding([utxo(20000, 0)]), undefined);
  assert.equal(usableFunding([utxo(2000000, 3)]), undefined);
  assert.equal(
    usableFunding([utxo(10000, 1, 0), utxo(30000, 2, 1)])?.vout, 1,
  );
});

test("setup starts at the merchant step and refuses re-initialization", () => {
  const store = new Store(":memory:");
  try {
    assert.equal(currentStep(store, {}), "merchant");
    assert.throws(
      () => initialize(store, "testnet4", "PM8Tnotacode", onion),
      /not a valid BIP47 payment code/,
    );
    const code = createWallet("22".repeat(64), "testnet4").sender.toBase58();
    initialize(store, "testnet4", ` ${code}\n`, onion);
    assert.equal(currentStep(store, {}), "dojo");
    assert.throws(
      () => initialize(store, "testnet4", code, onion),
      /already initialized/,
    );
  } finally {
    store.close();
  }
});

test("dashboard forms accept only same-origin posts", () => {
  const request = (headers: Record<string, string>) =>
    ({ headers } as unknown as IncomingMessage);
  assert.equal(sameOrigin(request({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(sameOrigin(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(request({
    origin: "http://127.0.0.1:8089", host: "127.0.0.1:8089",
  })), true);
  assert.equal(sameOrigin(request({
    origin: "http://evil.example", host: "127.0.0.1:8089",
  })), false);
  assert.equal(sameOrigin(request({ host: "127.0.0.1:8089" })), false);
});

test("approval accepts Ashigaru's signed-message block and BIP47 suffix", () => {
  const network = "testnet4";
  const merchant = createWallet("22".repeat(64), network);
  const config = {
    network, seedHex: "11".repeat(64), merchantCode: merchant.sender.toBase58(),
    onion: `http://${onion}`, apiToken: "33".repeat(32),
  } as const;
  const funding = new Transaction();
  funding.addInput(Buffer.alloc(32, 7), 0);
  funding.addOutput(createWallet(config.seedHex, network).fundingScript, 50000n);
  const pending = buildNotification(config, funding.toHex(), 0, 1000);
  const statement = identityStatement(config, pending);
  const address = merchant.sender.getNotificationAddress();
  const sign = (text: string) => Buffer.from(messages.sign(
    text, merchant.sender.getNotificationPrivateKey(), true,
    profiles[network].bitcoin.messagePrefix,
  )).toString("base64");
  const block = (text: string, signature: string, signer = address) =>
    `-----BEGIN BITCOIN SIGNED MESSAGE-----\n${text}\n` +
    "-----BEGIN BITCOIN SIGNATURE-----\nVersion: Bitcoin-qt (1.0)\n" +
    `Address: ${signer}\n\n${signature}\n-----END BITCOIN SIGNATURE-----\n`;

  const ashigaru = `${statement}\n\nBIP47: ${config.merchantCode}`;
  const fresh = () => {
    const store = new Store(":memory:");
    return { store, run: (input: string) => approve(store, config, pending, input) };
  };

  // Ashigaru: full block, with the appended BIP47 line.
  let s = fresh();
  s.run(block(ashigaru, sign(ashigaru)));
  assert.ok(s.store.get("approval", Approval));
  s.store.close();

  // A bare signature over the exact statement.
  s = fresh();
  s.run(sign(statement));
  s.store.close();

  // Another code in the suffix, a different address or text is refused.
  s = fresh();
  const other = `${statement}\n\nBIP47: ${createWallet("44".repeat(64), network).sender.toBase58()}`;
  assert.throws(() => s.run(sign(other)), /does not match/);
  assert.throws(
    () => s.run(block(ashigaru, sign(ashigaru), "mxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")),
    /signed with mxxx/,
  );
  assert.throws(() => s.run(sign(`${statement}\n`)), /does not match/);
  assert.equal(s.store.get("approval", Approval), undefined);
  s.store.close();
});
