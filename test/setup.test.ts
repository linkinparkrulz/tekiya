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
  FeeChoice, approve, chosenRate, feeForRate, feePresets, fundingRequired,
  initialize, normalizeOnion, notificationConfirmed, parsePairing,
   recordNotificationConfirmed, usableFunding, confirmedNotification,
   prepareNotification, NotificationHealth, NOTIFICATION_HEALTH,
   cachedConfirmedNotification,
} from "../src/setup.js";
import { Store } from "../src/store.js";

const onion = `${"a".repeat(56)}.onion`;
const dojo = `http://${"d".repeat(56)}.onion`;

test("cached confirmation requires current, fresh positive health, not historical progress", t => {
  t.mock.method(Date, "now", () => Date.parse("2026-10-12T12:00:00Z"));
  const store = new Store(":memory:");
  try {
    const code = createWallet("22".repeat(64), "testnet4").sender.toBase58();
    const config = initialize(store, "testnet4", code, onion);
    const funding = new Transaction();
    funding.addInput(Buffer.alloc(32, 7), 0);
    funding.addOutput(createWallet(config.seedHex, "testnet4").fundingScript, 50000n);
    const pending = buildNotification(config, funding.toHex(), 0, 1000);
    store.insert("notification", pending);
    const check = () => cachedConfirmedNotification(store, config);
    assert.throws(check, /verification pending/);
    recordNotificationConfirmed(store);
    assert.ok(notificationConfirmed(store));
    assert.throws(check, /verification pending/);

    const health = {
      txid: pending.txid, pairingGeneration: store.pairingGeneration(),
      confirmations: 1, checkedAt: new Date(Date.now()).toISOString(),
    };
    store.replace(NOTIFICATION_HEALTH, health);
    assert.deepEqual(check(), pending);
    store.replace(NOTIFICATION_HEALTH, {
      ...health, checkedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    });
    assert.deepEqual(check(), pending);

    for (const change of [
      { checkedAt: new Date(Date.now() - 10 * 60 * 1000 - 1).toISOString() },
      { checkedAt: new Date(Date.now() + 1).toISOString() },
      { checkedAt: "invalid" },
      { confirmations: 0 },
      { pairingGeneration: "other-pairing" },
      { txid: "00".repeat(32) },
    ]) {
      store.replace(NOTIFICATION_HEALTH, { ...health, ...change });
      assert.throws(check, /verification pending/, JSON.stringify(change));
    }

    store.replace(NOTIFICATION_HEALTH, health);
    store.replace("notification", { ...pending, txid: "00".repeat(32) });
    assert.throws(check, /reconstruction/);
  } finally { store.close(); }
});

test("onion addresses are accepted with or without a scheme", () => {
  assert.equal(normalizeOnion(` ${onion}/ `), `http://${onion}`);
  assert.equal(normalizeOnion(`http://${onion}`), `http://${onion}`);
});

test("historical confirmation preserves progress but cannot bypass a fresh check", async () => {
  const store = new Store(":memory:");
  try {
    const code = createWallet("22".repeat(64), "testnet4").sender.toBase58();
    const config = initialize(store, "testnet4", code, onion);
    const funding = new Transaction();
    funding.addInput(Buffer.alloc(32, 7), 0);
    funding.addOutput(createWallet(config.seedHex, "testnet4").fundingScript, 50000n);
    const pending = buildNotification(config, funding.toHex(), 0, 1000);
    store.insert("notification", pending);
    recordNotificationConfirmed(store);
    await assert.rejects(confirmedNotification(store, config, async () => ({
      hex: pending.hex, confirmations: 0,
    })), /not confirmed yet/);
    assert.equal(store.get(NOTIFICATION_HEALTH, NotificationHealth)?.confirmations, 0);
    await assert.rejects(confirmedNotification(store, config, async () => {
      throw new Error("offline");
    }), /offline/);
    assert.ok(notificationConfirmed(store));
    assert.equal((await confirmedNotification(store, config, async () => ({
      hex: pending.hex, confirmations: 1,
    }))).txid, pending.txid);
  } finally { store.close(); }
});

test("new preparation enforces the fee floor without persisting a rejected transaction", async () => {
  const store = new Store(":memory:");
  try {
    const code = createWallet("22".repeat(64), "testnet4").sender.toBase58();
    const config = initialize(store, "testnet4", code, onion);
    const funding = new Transaction();
    funding.addInput(Buffer.alloc(32, 7), 0);
    funding.addOutput(createWallet(config.seedHex, "testnet4").fundingScript, 50000n);
    let spent = true;
    const api = async (path: string) => path === "wallet" ? {
      unspent_outputs: spent ? [] : [{ tx_hash: funding.getId(), tx_output_n: 0,
        value: 50000, confirmations: 1 }],
    } : { hex: funding.toHex(), confirmations: 1 };
    await assert.rejects(prepareNotification(store, config, api, funding.getId(), 0, 1000), /below 25/);
    await assert.rejects(prepareNotification(store, config, api, funding.getId(), 0, 10000), /unspent/);
    spent = false;
    const pending = await prepareNotification(store, config, api, funding.getId(), 0, 10000);
    assert.ok(pending.feeRate >= 25);
  } finally { store.close(); }
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

test("fee presets never go below 25 sat/vB and match higher estimates", () => {
  const rates = (fees: Record<string, number>) =>
    feePresets(fees).map(preset => preset.rate);
  assert.deepEqual(rates({}), [25, 25, 38]);
  assert.deepEqual(rates({ "2": 3, "6": 2, "24": 1 }), [25, 25, 38]);
  assert.deepEqual(rates({ "2": 80, "6": 40, "24": 30 }), [30, 40, 80]);
  assert.equal(chosenRate(undefined, { "6": 40 }), 40);
  assert.equal(chosenRate({ preset: "custom", customRate: 60 }), 60);
  assert.throws(() => FeeChoice.parse({ preset: "custom", customRate: 5 }));
  assert.throws(() => chosenRate({ preset: "custom" }));
  assert.ok(feePresets({ "2": 1000000, "6": 1000000 }).every(preset =>
    FeeChoice.safeParse({ preset: "custom", customRate: preset.rate }).success));
});

test("exact funding pays the notification with no change left over", () => {
  const code = createWallet("22".repeat(64), "testnet4").sender.toBase58();
  const config = {
    network: "testnet4", seedHex: "11".repeat(64), merchantCode: code,
    onion: `http://${onion}`, apiToken: "33".repeat(32),
  } as const;
  const required = fundingRequired(config, 25);
  // 546 sats to the wallet plus about 205 vB at 25 sat/vB.
  assert.ok(required > 546 + 25 * 200 && required < 546 + 25 * 215, String(required));

  const funding = new Transaction();
  funding.addInput(Buffer.alloc(32, 9), 0);
  funding.addOutput(createWallet(config.seedHex, "testnet4").fundingScript,
    BigInt(required));
  const fee = feeForRate(config, required, 25);
  const pending = buildNotification(config, funding.toHex(), 0, fee);
  const tx = Transaction.fromHex(pending.hex);
  assert.equal(tx.outs.length, 2);
  assert.equal(pending.changeSats, 0);
  assert.ok(pending.feeRate >= 25, String(pending.feeRate));

  // More funding keeps the rate and returns the rest as change.
  const larger = feeForRate(config, 20000, 25);
  assert.ok(larger < 20000 - 546 - 330);
  assert.throws(() => feeForRate(config, required, 60), /covers at most/);
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

test("setup does not go back when the Dojo is unreachable after a restart", () => {
  const store = new Store(":memory:");
  try {
    const code = createWallet("22".repeat(64), "testnet4").sender.toBase58();
    const config = initialize(store, "testnet4", code, onion);
    store.insert("pairing", { network: "testnet4", baseUrl: `${dojo}/test/v2/`, apikey: "k" });
    const funding = new Transaction();
    funding.addInput(Buffer.alloc(32, 7), 0);
    funding.addOutput(createWallet(config.seedHex, "testnet4").fundingScript, 50000n);
    const pending = buildNotification(config, funding.toHex(), 0, 1000);
    store.insert("notification", pending);

    // Nothing known yet: the broadcast step.
    assert.equal(currentStep(store, {}), "broadcast");
    // Seen confirmed once, then Tekiya restarts with no Dojo answer.
    recordNotificationConfirmed(store);
    assert.equal(currentStep(store, {}), "test");
    // An installation that is further along never shows earlier steps.
    store.remove("notification-confirmed");
    store.insert("approval", { txid: pending.txid, signature: "s", createdAt: "now" });
    assert.notEqual(currentStep(store, {}), "broadcast");
    assert.ok(notificationConfirmed(store));
  } finally {
    store.close();
  }
});
