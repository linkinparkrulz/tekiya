import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, lstatSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { adminSettings, serveAdmin } from "../src/admin.js";
import { ADMIN_PASSWORD, AdminPassword, bootstrapPassword, verifyPassword } from "../src/admin-auth.js";
import type { Monitor } from "../src/monitor.js";
import { Store } from "../src/store.js";
import { PublicPayments } from "../src/config.js";

const basic = (password: string, user = "admin") =>
  `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

test("admin settings default to setup and preserve explicit deployment modes", () => {
  assert.equal(adminSettings({}).auth, "setup");
  assert.throws(() => adminSettings({ NYM_ADMIN_HOST: "0.0.0.0" }), /loopback/);
  for (const auth of ["loopback", "none", "proxy", "password"]) {
    assert.equal(adminSettings({ NYM_ADMIN_AUTH: auth, NYM_ADMIN_PASSWORD: "long-password" }).auth, auth);
  }
  assert.equal(adminSettings({ NYM_ADMIN_HOST: "0.0.0.0", NYM_ADMIN_SOCKET: "/run/admin.sock" }).auth, "setup");
});

test("bootstrap validates passwords and concurrent inserts cannot replace the winner", async () => {
  const store = new Store(":memory:");
  try {
    await assert.rejects(bootstrapPassword(store, "short", "short"), /12/);
    await assert.rejects(bootstrapPassword(store, "long-password", "different"), /match/);
    const results = await Promise.allSettled([
      bootstrapPassword(store, "first-password", "first-password"),
      bootstrapPassword(store, "other-password", "other-password"),
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    const record = store.get(ADMIN_PASSWORD, AdminPassword)!;
    const winner = results[0]!.status === "fulfilled" ? "first-password" : "other-password";
    assert.equal(await verifyPassword(record, basic(winner)), true);
    assert.equal(await verifyPassword(record, basic(winner, "other")), false);
    assert.equal(await verifyPassword(record, basic("wrong-password")), false);
    assert.equal(await verifyPassword(record, basic("x".repeat(1025))), false);
    await assert.rejects(bootstrapPassword(store, "replacement-pass", "replacement-pass"), /already/);
    assert.deepEqual(store.get(ADMIN_PASSWORD, AdminPassword), record);
    assert.ok(!JSON.stringify(record).includes(winner));
    const bounded = await Promise.allSettled(Array.from({ length: 3 }, () => verifyPassword(record, basic(winner))));
    assert.equal(bounded.filter(result => result.status === "rejected").length, 1);
  } finally { store.db.close(); }
});

test("Unix HTTP bootstrap is isolated, origin/nonce guarded, and persists across restarts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "tekiya-admin-"));
  const socket = join(directory, "admin.sock");
  const previous = { ...process.env };
  process.env.NYM_ADMIN_AUTH = "setup";
  process.env.NYM_ADMIN_SOCKET = socket;
  process.env.NYM_ADMIN_HOSTS = "localhost:8089";
  const store = new Store(":memory:");
  const monitor = { state: {}, run: async () => { throw new Error("must not run"); } } as unknown as Monitor;
  let server: ReturnType<typeof serveAdmin>;
  const call = (path = "/", body?: URLSearchParams, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({ socketPath: socket, path, agent: false, method: body ? "POST" : "GET",
        headers: { Host: "localhost:8089", ...headers } }, res => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", chunk => { text += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: text }));
      });
      req.on("error", reject);
      req.end(body?.toString());
    });
  try {
    writeFileSync(socket, "do not delete");
    assert.throws(() => serveAdmin(store, "testnet4", monitor), /non-socket/);
    rmSync(socket);
    server = serveAdmin(store, "testnet4", monitor)!;
    await once(server, "listening");
    assert.equal(server.address(), socket);
    assert.equal(lstatSync(socket).mode & 0o777, 0o600);
    const initial = await call();
    assert.equal(initial.status, 200);
    assert.match(initial.body, /Set admin password/);
    assert.doesNotMatch(initial.body, /merchantCode|seedHex|viewKey/);
    const nonce = /name="nonce" value="([a-f0-9]+)"/.exec(initial.body)![1]!;
    const form = new URLSearchParams({ nonce, password: "long-password", confirmation: "long-password" });
    assert.equal((await call("/", undefined, { Host: "evil.example" })).status, 421);
    assert.equal((await call("/check", form)).status, 404);
    assert.equal((await call("/setup/password", form)).status, 403);
    const origin = { Origin: "http://localhost:8089" };
    form.set("nonce", "wrong");
    assert.equal((await call("/setup/password", form, origin)).status, 403);
    form.set("nonce", nonce);
    form.set("confirmation", "mismatch");
    const invalid = await call("/setup/password", form, origin);
    assert.equal(invalid.status, 400);
    assert.ok(!invalid.body.includes("long-password"));
    form.set("confirmation", "long-password");
    assert.equal((await call("/setup/password", form, origin)).status, 303);
    assert.equal((await call()).status, 401);
    assert.equal((await call("/setup/password", form, origin)).status, 401);
    assert.equal((await call("/", undefined, { Authorization: basic("long-password", "wrong") })).status, 401);
    assert.equal((await call("/", undefined, { Authorization: basic("long-password") })).status, 200);
    const toggle = new URLSearchParams({ enabled: "true" });
    const authorized = { ...origin, Authorization: basic("long-password") };
    assert.equal((await call("/settings/public-payments", toggle, origin)).status, 401);
    assert.equal((await call("/settings/public-payments", toggle,
      { ...origin, Authorization: basic("wrong-password") })).status, 401);
    assert.equal((await call("/settings/public-payments", toggle,
      { Authorization: basic("long-password") })).status, 403);
    assert.equal((await call("/settings/public-payments", toggle, authorized)).status, 400);
    assert.equal(store.get("public-payments", PublicPayments), undefined);
    toggle.set("reviewed", "yes");
    assert.equal((await call("/settings/public-payments", toggle, authorized)).status, 303);
    assert.deepEqual(store.get("public-payments", PublicPayments), { enabled: true });
    toggle.set("enabled", "false");
    toggle.delete("reviewed");
    assert.equal((await call("/settings/public-payments", toggle, authorized)).status, 303);
    assert.deepEqual(store.get("public-payments", PublicPayments), { enabled: false });
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = serveAdmin(store, "testnet4", monitor)!;
    await once(server, "listening");
    assert.equal((await call()).status, 401);
    assert.equal((await call("/", undefined, { Authorization: basic("long-password") })).status, 200);
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
