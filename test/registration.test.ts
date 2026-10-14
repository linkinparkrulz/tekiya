import test from "node:test";
import assert from "node:assert/strict";
import { Unavailable, type Config } from "../src/config.js";
import { createWallet, deriveAddress } from "../src/bitcoin.js";
import { pairingGeneration, syncDojo, type DojoApi } from "../src/registrar.js";
import { Store } from "../src/store.js";

const config: Config = {
  network: "testnet4",
  seedHex: "11".repeat(64),
  merchantCode: createWallet("22".repeat(64), "testnet4").sender.toBase58(),
  onion: `http://${"a".repeat(56)}.onion`,
  apiToken: "33".repeat(32),
};

const derive = (index: number): string => deriveAddress(config, index);
const id = (n: number): string => `request_${String(n).padStart(10, "0")}`;

interface FakeTx { index: number; height?: number; value?: number }

// Answers /wallet like Dojo for the requested addresses.
function fakeDojo(
  history: FakeTx[] = [],
  omit: number[] = [],
): { api: DojoApi; requests: string[][] } {
  const requests: string[][] = [];
  const api: DojoApi = async (path, form) => {
    assert.equal(path, "wallet");
    const active = form?.active?.split("|") ?? [];
    requests.push(active);
    const indices = [0, 1, 2, 3, 4].filter(index =>
      active.includes(derive(index)) && !omit.includes(index));
    const txs = history.filter(tx => indices.includes(tx.index));
    return {
      addresses: indices.map(index => ({
        address: derive(index),
        n_tx: txs.filter(tx => tx.index === index).length,
      })),
      txs: txs.map(tx => ({
        hash: String(history.indexOf(tx)).padStart(64, "0"),
        ...(tx.height === undefined ? {} : { block_height: tx.height }),
        out: [{ addr: derive(tx.index), value: tx.value ?? 1000 }],
      })),
    };
  };
  return { api, requests };
}

test("unregistered addresses are never issued", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(() => store.allocate(id(1), 0, derive), Unavailable);
    assert.equal(store.nextIndex(), 0);
  } finally {
    store.close();
  }
});

test("issuance pauses beyond the receiving wallet's lookahead", () => {
  const store = new Store(":memory:");
  try {
    for (let i = 0; i < 5; i++) store.register(i, derive(i));
    for (let i = 0; i < 3; i++) {
      assert.equal(store.allocate(id(i), 0, derive).idx, i);
    }
    assert.throws(() => store.allocate(id(3), 0, derive), Unavailable);

    store.recordPayment(0, "00".repeat(32), 100);
    assert.equal(store.allocate(id(3), 0, derive).idx, 3);
    assert.throws(() => store.allocate(id(4), 0, derive), Unavailable);

    // Repeating an existing request is still answered while paused.
    assert.equal(store.allocate(id(3), 0, derive).idx, 3);
  } finally {
    store.close();
  }
});

test("a halt stops issuance until explicitly cleared", () => {
  const store = new Store(":memory:");
  try {
    store.register(0, derive(0));
    store.halt("test");
    assert.throws(() => store.allocate(id(0), 0, derive), /halted: test/);
    assert.equal(store.clearHalt(), true);
    assert.equal(store.allocate(id(0), 0, derive).idx, 0);
  } finally {
    store.close();
  }
});

test("sync registers a pool ahead of the next index", async () => {
  const store = new Store(":memory:");
  try {
    const { api, requests } = fakeDojo();
    const result = await syncDojo(store, config, api);
    assert.deepEqual(result.registered, [0, 1, 2]);
    // Only P2WPKH addresses are registered, never pubkeys.
    assert.deepEqual(requests, [[0, 1, 2].map(derive)]);
    assert.ok(requests[0]?.every(address => address.startsWith("tb1q")));
    assert.equal(store.allocate(id(0), 0, derive).idx, 0);

    // The pool moves forward with allocation, re-querying issued indices.
    await syncDojo(store, config, api);
    assert.equal(requests[1]?.length, 4);
  } finally {
    store.close();
  }
});

test("sync records only confirmed payments to issued addresses", async () => {
  const store = new Store(":memory:");
  try {
    await syncDojo(store, config, fakeDojo().api);
    store.allocate(id(0), 0, derive);
    store.allocate(id(1), 0, derive);

    const result = await syncDojo(store, config, fakeDojo([
      { index: 0, height: 120 },
      { index: 1 },
    ]).api);
    assert.deepEqual(result.confirmedPayments, [0]);
    assert.equal(store.lastConfirmedPayment(), 0);

    // Amounts are kept current, confirmed and pending separately.
    await syncDojo(store, config, fakeDojo([
      { index: 0, height: 120, value: 2500 },
      { index: 0, value: 700 },
      { index: 1, value: 300 },
    ]).api);
    assert.deepEqual(
      store.db.prepare(
        "SELECT idx, confirmed_sats, unconfirmed_sats FROM received ORDER BY idx",
      ).all().map(row => ({ ...row })),
      [
        { idx: 0, confirmed_sats: 2500, unconfirmed_sats: 700 },
        { idx: 1, confirmed_sats: 0, unconfirmed_sats: 300 },
      ],
    );
  } finally {
    store.close();
  }
});

test("history on an unissued address halts issuance", async () => {
  const store = new Store(":memory:");
  try {
    const result = await syncDojo(
      store, config, fakeDojo([{ index: 1, height: 50 }]).api,
    );
    assert.match(result.halted ?? "", /unissued index 1/);
    assert.ok(store.halted());
    assert.throws(() => store.allocate(id(0), 0, derive), Unavailable);
  } finally {
    store.close();
  }
});

test("an address issued during a sync is not mistaken for a clone", async () => {
  const store = new Store(":memory:");
  try {
    await syncDojo(store, config, fakeDojo().api);
    const { api } = fakeDojo([{ index: 0 }]);
    const result = await syncDojo(store, config, async (path, form) => {
      store.allocate(id(0), 0, derive);
      return api(path, form);
    });
    assert.equal(result.halted, undefined);
    assert.equal(store.halted(), undefined);
  } finally {
    store.close();
  }
});

test("an address missing from the response is not registered", async () => {
  const store = new Store(":memory:");
  try {
    await assert.rejects(
      syncDojo(store, config, fakeDojo([], [1]).api),
      /index-1 address/,
    );
    assert.equal(store.registeredAddress(1), undefined);
  } finally {
    store.close();
  }
});

test("re-pairing clears registrations and re-registers paid indices", async () => {
  const store = new Store(":memory:");
  try {
    await syncDojo(store, config, fakeDojo().api);
    store.allocate(id(0), 0, derive);
    await syncDojo(store, config, fakeDojo([{ index: 0, height: 9 }]).api);

    store.replacePairing({ replaced: true });
    assert.equal(store.registeredAddress(0), undefined);
    assert.throws(() => store.allocate(id(1), 0, derive), Unavailable);

    const { api, requests } = fakeDojo([{ index: 0, height: 9 }]);
    const result = await syncDojo(store, config, api);
    assert.ok(requests[0]?.includes(derive(0)));
    assert.deepEqual(result.registered, [0, 1, 2, 3]);
    assert.equal(store.allocate(id(1), 0, derive).idx, 1);
  } finally {
    store.close();
  }
});

test("sync rejects changed pairing snapshots and identical re-pair generations", async () => {
  for (const change of ["pairing", "pairing-generation"]) {
    const store = new Store(":memory:");
    try {
      store.replace("pairing", { key: "original" });
      store.replace("pairing-generation", 1);
      const { api } = fakeDojo([{ index: 1, height: 10 }]);
      await assert.rejects(syncDojo(store, config, async (path, form) => {
        store.replace(change, change === "pairing" ? { key: "replacement" } : 2);
        return api(path, form);
      }), /stale results rejected/);
      assert.equal(store.registeredAddress(0), undefined);
      assert.equal(store.halted(), undefined);
      assert.equal(store.lastConfirmedPayment(), -1);
    } finally { store.close(); }
  }
});

test("sync reconciles disappeared, unconfirmed and reconfirmed payments", async () => {
  const store = new Store(":memory:");
  try {
    await syncDojo(store, config, fakeDojo().api);
    store.allocate(id(0), 0, derive);
    await syncDojo(store, config, fakeDojo([{ index: 0, height: 10 }]).api);
    assert.equal(store.paymentStatus(id(0))?.firstConfirmedBlock, 10);
    await syncDojo(store, config, fakeDojo([{ index: 0 }]).api);
    assert.equal(store.lastConfirmedPayment(), -1);
    assert.equal(store.paymentStatus(id(0))?.state, "seen");
    await syncDojo(store, config, fakeDojo([{ index: 0, height: 20 }]).api);
    assert.equal(store.paymentStatus(id(0))?.firstConfirmedBlock, 20);
    await syncDojo(store, config, fakeDojo().api);
    assert.equal(store.paymentStatus(id(0))?.state, "pending");
    assert.equal(store.paymentStatus(id(0))?.firstConfirmedBlock, null);
  } finally { store.close(); }
});

test("incomplete transaction history and malformed later entries write nothing", async () => {
  const store = new Store(":memory:");
  try {
    const { api } = fakeDojo([{ index: 0, height: 10 }]);
    await assert.rejects(syncDojo(store, config, async (path, form) => {
      if (path.startsWith("txs?")) return { n_tx: 0, page: 0, n_tx_page: 100, txs: [] };
      const response = await api(path, form) as { txs: unknown[] };
      return { ...response, txs: [] };
    }), /history is incomplete/);
    assert.equal(store.registeredAddress(0), undefined);
    await assert.rejects(syncDojo(store, config, fakeDojo([], [2]).api), /index-2/);
    assert.equal(store.registeredAddress(0), undefined);
  } finally { store.close(); }
});

test("clients bound before re-pairing are rejected before requesting history", async () => {
  const store = new Store(":memory:");
  try {
    const api = Object.assign(async () => { throw new Error("must not request"); },
      { pairingGeneration: pairingGeneration(store) });
    store.replacePairing({ key: "new" });
    await assert.rejects(syncDojo(store, config, api), /stale results rejected/);
  } finally { store.close(); }
});

test("overlapping observations cannot overwrite a committed sync", async () => {
  const store = new Store(":memory:");
  try {
    const old = fakeDojo([{ index: 1, height: 10 }]).api;
    await assert.rejects(syncDojo(store, config, async (path, form) => {
      await syncDojo(store, config, fakeDojo().api);
      return old(path, form);
    }), /overlapped/);
    assert.equal(store.halted(), undefined);
    assert.equal(store.registeredAddress(0), derive(0));
  } finally { store.close(); }
});

test("capped wallet history uses GET txs pages and rejects repeated pages", async () => {
  for (const duplicate of [false, true]) {
    const store = new Store(":memory:");
    try {
      await syncDojo(store, config, fakeDojo().api);
      store.allocate(id(0), 0, derive);
      const txs = Array.from({ length: 101 }, (_, i) => ({
        hash: i.toString(16).padStart(64, "0"), block_height: 10,
        out: [{ addr: derive(0), value: 1 }],
      }));
      const api: DojoApi = async (path, form) => {
        if (path === "wallet") return {
          addresses: form!.active!.split("|").map(address => ({ address,
            n_tx: address === derive(0) ? 101 : 0 })), txs: txs.slice(0, 1),
        };
        assert.equal(form, undefined);
        const query = new URL(path, "http://test").searchParams;
        assert.equal(query.get("count"), "100");
        assert.equal(query.has("excludeNullXfer"), false);
        const page = Number(query.get("page"));
        const items = page === 0 ? txs.slice(0, 100) : [txs[duplicate ? 0 : 100]];
        return { n_tx: 101, page, n_tx_page: 100, txs: items };
      };
      if (duplicate) await assert.rejects(syncDojo(store, config, api), /duplicate/);
      else {
        await syncDojo(store, config, api);
        assert.equal(store.paymentStatus(id(0))?.confirmedSats, 101);
      }
    } finally { store.close(); }
  }
});

test("spending-only history counts toward completeness but not received value", async () => {
  const store = new Store(":memory:");
  try {
    await syncDojo(store, config, fakeDojo().api);
    store.allocate(id(0), 0, derive);
    const { api } = fakeDojo([{ index: 0, height: 10 }]);
    await syncDojo(store, config, async (path, form) => {
      const response = await api(path, form) as { txs: Record<string, unknown>[] };
      return { ...response, txs: response.txs.map(tx => ({
        ...tx, out: [], inputs: [{ prev_out: { addr: derive(0) } }],
      })) };
    });
    assert.equal(store.lastConfirmedPayment(), -1);
    assert.equal(store.paymentStatus(id(0))?.confirmedSats, 0);
  } finally { store.close(); }
});
