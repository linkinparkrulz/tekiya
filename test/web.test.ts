import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { CSP, escape, page, qrSvg } from "../src/html.js";
import { parseBtcAmount } from "../src/web.js";

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
