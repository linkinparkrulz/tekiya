import test from "node:test";
import assert from "node:assert/strict";
import { onionUrl } from "../src/config.js";

const origin = `http://${"a".repeat(56)}.onion`;

test("backend requests may explicitly allow query parameters", () => {
  const url = onionUrl(`${origin}/tx/example?rawHex=1`, false, true);
  assert.equal(url.searchParams.get("rawHex"), "1");
});

test("configuration URLs continue to reject query parameters", () => {
  assert.throws(() => onionUrl(`${origin}/v2/?rawHex=1`));
});

test("backend requests still reject clearnet, credentials, and fragments", () => {
  assert.throws(() =>
    onionUrl("http://example.com/tx/example?rawHex=1", false, true));
  assert.throws(() =>
    onionUrl(origin.replace("http://", "http://user:pass@/"), false, true));
  assert.throws(() =>
    onionUrl(`${origin}/tx/example?rawHex=1#fragment`, false, true));
});
