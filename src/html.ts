import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import qrcode from "qrcode-generator";

// Pages contain no scripts and work with JavaScript disabled, as in Tor
// Browser's Safest mode. The stylesheet is inline and allowed by hash.
const CSS = `
:root {
  --bg: #f6f5f1; --surface: #ffffff; --text: #1d1d1b; --muted: #64625c;
  --line: #dedbd2; --accent: #8a4b14; --accent-text: #ffffff;
  --ok: #2f6b3a; --warn: #8a5a00; --bad: #9b2c2c; --code: #f0eee8;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161614; --surface: #201f1c; --text: #ecebe6; --muted: #a29f97;
    --line: #36342f; --accent: #e09a52; --accent-text: #1a1206;
    --ok: #7cc489; --warn: #e3b55b; --bad: #ef8a8a; --code: #2a2925;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
}
main { max-width: 34rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
main.wide { max-width: 64rem; }
header { display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; margin-bottom: 1.5rem; }
h1 { font-size: 1.35rem; margin: 0; letter-spacing: -0.01em; }
h2 { font-size: 1rem; margin: 0 0 0.75rem; }
p { margin: 0 0 1rem; }
a { color: var(--accent); }
.card { background: var(--surface); border: 1px solid var(--line);
  border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
.muted { color: var(--muted); font-size: 0.9rem; }
.lead { color: var(--muted); margin: -0.75rem 0 1.25rem; }
.badge { display: inline-block; font-size: 0.75rem; font-weight: 600;
  padding: 0.15rem 0.55rem; border-radius: 999px; border: 1px solid;
  text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
.badge.ok { color: var(--ok); } .badge.warn { color: var(--warn); }
.badge.bad { color: var(--bad); }
.notice { border-left: 3px solid var(--warn); padding: 0.6rem 0.9rem;
  background: var(--surface); border-radius: 0 8px 8px 0; margin-bottom: 1rem; }
.notice.bad { border-color: var(--bad); }
label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
input[type=text], input[type=number], textarea { width: 100%; font: inherit;
  padding: 0.6rem 0.75rem; border: 1px solid var(--line); border-radius: 8px;
  background: var(--bg); color: var(--text); }
textarea { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 0.85rem; min-height: 7rem; resize: vertical; }
textarea[readonly] { background: var(--code); }
.hint { color: var(--muted); font-size: 0.85rem; margin-top: 0.35rem; }
.actions { display: flex; flex-wrap: wrap; gap: 0.6rem; align-items: center; }
button.secondary, .button.secondary { background: transparent;
  color: var(--accent); border: 1px solid var(--line); }
form.inline { display: inline; }
ol.steps li.current { font-weight: 600; }
ol.steps li.current::before { border-color: var(--accent);
  box-shadow: inset 0 0 0 2px var(--surface), inset 0 0 0 8px var(--accent); }
.layout { display: grid; gap: 1rem; grid-template-columns: 1fr; }
@media (min-width: 52rem) {
  .layout { grid-template-columns: 15rem 1fr; align-items: start; }
}
button, .button { display: inline-block; font: inherit; font-weight: 600;
  padding: 0.65rem 1.1rem; border-radius: 8px; border: 0; cursor: pointer;
  background: var(--accent); color: var(--accent-text); text-decoration: none; }
.stack > * + * { margin-top: 1rem; }
.mono, code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  font-size: 0.9rem; }
.address { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace;
  background: var(--code); border-radius: 8px; padding: 0.75rem;
  word-break: break-all; font-size: 1rem; user-select: all; }
.qr { display: flex; justify-content: center; border-radius: 10px;
  cursor: pointer; }
.qr svg { width: 100%; max-width: 15rem; height: auto; border-radius: 8px;
  transition: transform 0.12s ease, box-shadow 0.12s ease; }
.qr:hover svg { transform: scale(1.02);
  box-shadow: 0 0 0 3px var(--accent); }
.qr:focus-visible { outline: none; }
.qr:focus-visible svg { box-shadow: 0 0 0 3px var(--accent); }
.center { text-align: center; }
@media (prefers-reduced-motion: reduce) { .qr svg { transition: none; } }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.4rem 1rem;
  margin: 0; }
dt { color: var(--muted); } dd { margin: 0; word-break: break-all; }
details summary { cursor: pointer; color: var(--muted); }
.grid { display: grid; gap: 1rem;
  grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; padding: 0.45rem 0.6rem;
  border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
.nowrap { white-space: nowrap; }
ol.steps { list-style: none; padding: 0; margin: 0; }
ol.steps li { display: flex; gap: 0.6rem; padding: 0.3rem 0; }
ol.steps li::before { content: ""; flex: none; width: 0.7rem; height: 0.7rem;
  margin-top: 0.42rem; border-radius: 50%; border: 2px solid var(--line); }
ol.steps li.done::before { background: var(--ok); border-color: var(--ok); }
`;

const STYLE_HASH = createHash("sha256").update(CSS).digest("base64");

export const CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");

export function escape(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function page(
  title: string,
  body: string,
  options: { wide?: boolean; refreshSeconds?: number } = {},
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${options.refreshSeconds
    ? `<meta http-equiv="refresh" content="${options.refreshSeconds}">`
    : ""}
<title>${escape(title)}</title>
<style>${CSS}</style>
</head>
<body>
<main${options.wide ? ' class="wide"' : ""}>
${body}
</main>
</body>
</html>`;
}

export function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
): void {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", CSP);
  res.writeHead(status);
  res.end(html);
}

// Built from the module matrix so no library markup reaches the page.
export function qrSvg(text: string, label: string): string {
  const code = qrcode(0, "M");
  code.addData(text);
  code.make();
  const count = code.getModuleCount();
  const margin = 4;
  const size = count + margin * 2;
  let path = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (code.isDark(row, col)) {
        path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" ` +
    `role="img" aria-label="${escape(label)}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/>` +
    `<path d="${path}" fill="#000"/></svg>`;
}

export function formatTime(iso: string): string {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

export function bitcoinUri(address: string, amountSats: number): string {
  return `bitcoin:${address}` +
    (amountSats ? `?amount=${(amountSats / 100000000).toFixed(8)}` : "");
}
