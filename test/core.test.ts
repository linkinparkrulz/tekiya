import test from "node:test";
import assert from "node:assert/strict";
import * as ecc from "tiny-secp256k1";
import { payments, Transaction } from "bitcoinjs-lib";
import {
  profiles, type Config, type NetworkName,
} from "../src/config.js";
import {
  createWallet, deriveAddress, buildNotification,
  identityStatement, verifyIdentity, messages,
} from "../src/bitcoin.js";
import { Store } from "../src/store.js";

function fixture(network: NetworkName): Config {
  return {
    network,
    seedHex: "11".repeat(64),
    merchantCode: createWallet("22".repeat(64), network).sender.toBase58(),
    onion: `http://${"a".repeat(56)}.onion`,
    apiToken: "33".repeat(32),
  };
}

for (const name of ["mainnet", "testnet4"] as const) {
  test(`${name}: destinations match merchant spending keys`, () => {
    const config = fixture(name);
    const sender = createWallet(config.seedHex, name);
    const merchant = createWallet("22".repeat(64), name);
    const network = profiles[name].bitcoin;

    for (let index = 0; index < 5; index++) {
      const key = merchant.sender.derivePaymentPrivateKey(
        sender.sender.toPaymentCodePublic(), index,
      );
      const pubkey = ecc.pointFromScalar(key, true);
      assert.ok(pubkey);
      const expected = payments.p2wpkh({ pubkey, network }).address;
      assert.equal(deriveAddress(config, index), expected);
    }

    assert.match(
      sender.fundingAddress,
      name === "mainnet" ? /^bc1q/ : /^tb1q/,
    );
  });

  test(`${name}: notification is recoverable and identity is bound`, () => {
    const config = fixture(name);
    const sender = createWallet(config.seedHex, name);
    const merchant = createWallet("22".repeat(64), name);
    const funding = new Transaction();
    funding.addInput(Buffer.alloc(32, 7), 0);
    funding.addOutput(sender.fundingScript, 50000n);

    const pending = buildNotification(
      config, funding.toHex(), 0, 1000,
    );
    const tx = Transaction.fromHex(pending.hex);
    const input = tx.ins[0];
    const payload = tx.outs[1];
    assert.ok(input && payload);
    const designatedPubkey = input.witness[1];
    assert.ok(designatedPubkey);

    const outpoint = Buffer.alloc(36);
    Buffer.from(funding.getId(), "hex").reverse().copy(outpoint);
    outpoint.writeUInt32LE(0, 32);

    const recovered =
      merchant.sender.getPaymentCodeFromNotificationTransactionData(
        payload.script, outpoint, designatedPubkey,
      );
    assert.equal(recovered.toBase58(), sender.sender.toBase58());
    assert.equal(
      50000n - tx.outs.reduce((sum, output) => sum + output.value, 0n),
      1000n,
    );

    const signature = Buffer.from(messages.sign(
      identityStatement(config, pending),
      merchant.sender.getNotificationPrivateKey(),
      true,
      profiles[name].bitcoin.messagePrefix,
    )).toString("base64");

    assert.equal(verifyIdentity(config, pending, signature), true);
    assert.equal(verifyIdentity({
      ...config,
      onion: `http://${"b".repeat(56)}.onion`,
    }, pending, signature), false);
  });
}

test("allocation is idempotent, bounded, and does not reuse indices", () => {
  const store = new Store(":memory:");
  try {
    const derive = (index: number): string => `address-${index}`;
    for (let i = 0; i < 5; i++) store.register(i, derive(i));
    const options = { enforceLookahead: false };
    const id = "request_0000000001";
    assert.deepEqual(
      store.allocate(id, 1000, derive, options),
      store.allocate(id, 1000, derive, options),
    );
    assert.throws(() => store.allocate(id, 2000, derive, options));

    for (let i = 1; i < 5; i++) {
      assert.equal(
        store.allocate(`request_000000000${i + 1}`, 0, derive, options).idx,
        i,
      );
    }
    assert.throws(() =>
      store.allocate("request_0000000006", 0, derive, options));
  } finally {
    store.close();
  }
});
