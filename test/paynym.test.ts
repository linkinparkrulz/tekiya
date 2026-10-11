import test from "node:test";
import assert from "node:assert/strict";
import { Transaction } from "bitcoinjs-lib";
import { Config, profiles } from "../src/config.js";
import {
  buildNotification, codeForms, createWallet, identityStatement, messages,
  receiver, segwitCode, verifyIdentity,
} from "../src/bitcoin.js";
import { DEFAULT_PAYNYM_API, paynymApi } from "../src/paynym.js";
import { migrateMerchantCode } from "../src/setup.js";
import { Store } from "../src/store.js";

const network = "testnet4";
const merchant = createWallet("22".repeat(64), network).sender;
const segwit = merchant.toBase58();
const legacy = codeForms(segwit, network)[1] ?? "";

test("payment codes convert to SegWit form without changing keys", () => {
  assert.equal(receiver(legacy, network).segwit, false);
  assert.equal(segwitCode(legacy, network), segwit);
  assert.equal(segwitCode(segwit, network), segwit);
  assert.equal(
    receiver(legacy, network).getNotificationAddress(),
    receiver(segwit, network).getNotificationAddress(),
  );
});

test("unapproved installations switch to the SegWit merchant code", () => {
  const store = new Store(":memory:");
  try {
    const config: Config = {
      network, seedHex: "11".repeat(64), merchantCode: legacy,
      onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
    };
    store.insert("config", config);
    assert.equal(migrateMerchantCode(store), true);
    assert.equal(store.get("config", Config)?.merchantCode, segwit);
    assert.equal(migrateMerchantCode(store), false);
  } finally {
    store.close();
  }
});

test("approved installations keep the code they signed", () => {
  const store = new Store(":memory:");
  try {
    store.insert("config", {
      network, seedHex: "11".repeat(64), merchantCode: legacy,
      onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
    });
    store.insert("approval", { txid: "x", signature: "y", createdAt: "z" });
    assert.equal(migrateMerchantCode(store), false);
    assert.equal(store.get("config", Config)?.merchantCode, legacy);
  } finally {
    store.close();
  }
});

test("Ashigaru's suffix may carry either form of the merchant code", () => {
  const config: Config = {
    network, seedHex: "11".repeat(64), merchantCode: segwit,
    onion: `http://${"a".repeat(56)}.onion`, apiToken: "33".repeat(32),
  };
  const funding = new Transaction();
  funding.addInput(Buffer.alloc(32, 7), 0);
  funding.addOutput(createWallet(config.seedHex, network).fundingScript, 50000n);
  const pending = buildNotification(config, funding.toHex(), 0, 1000);
  const sign = (text: string) => Buffer.from(messages.sign(
    text, merchant.getNotificationPrivateKey(), true,
    profiles[network].bitcoin.messagePrefix,
  )).toString("base64");
  const statement = identityStatement(config, pending);
  for (const code of [segwit, legacy]) {
    assert.ok(verifyIdentity(config, pending, sign(`${statement}\n\nBIP47: ${code}`)));
  }
});

test("the PayNym directory is reached at its onion service by default", () => {
  const saved = process.env.NYM_PAYNYM_API;
  try {
    delete process.env.NYM_PAYNYM_API;
    assert.equal(paynymApi().href, DEFAULT_PAYNYM_API);
    process.env.NYM_PAYNYM_API = "https://paynym.rs/api/v1";
    assert.equal(paynymApi().href, "https://paynym.rs/api/v1/");
    process.env.NYM_PAYNYM_API = "http://paynym.rs/api/v1/";
    assert.throws(() => paynymApi());
  } finally {
    if (saved === undefined) delete process.env.NYM_PAYNYM_API;
    else process.env.NYM_PAYNYM_API = saved;
  }
});
