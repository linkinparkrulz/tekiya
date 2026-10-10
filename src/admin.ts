import { createServer } from "node:http";
import { z } from "zod";
import {
  ISSUANCE_LIMIT, Pairing, Pending, Profile, RECEIVER_LOOKAHEAD,
  requireCondition,
  type Config,
} from "./config.js";
import { createWallet, deriveAddress } from "./bitcoin.js";
import { requireApproval } from "./approval.js";
import { escape, formatTime, page, sendHtml } from "./html.js";
import type { SyncResult } from "./registrar.js";
import { Store } from "./store.js";

export interface SyncState {
  lastAttempt?: string;
  lastSuccess?: string;
  lastError?: string;
  lastResult?: SyncResult;
}

const Row = z.object({
  idx: z.number().int(),
  request_id: z.string(),
  address: z.string(),
  amount_sats: z.number().int(),
  created_at: z.string(),
  registered: z.number().int(),
  txid: z.string().nullable(),
  block_height: z.number().int().nullable(),
});

function requestLabel(id: string): string {
  // Web nonces grant access to the customer's page; show only their kind.
  if (id.startsWith("web_")) return "web page";
  return id.length > 24 ? `${id.slice(0, 21)}…` : id;
}

function badge(ok: boolean, yes: string, no: string, bad = false): string {
  return `<span class="badge ${ok ? "ok" : bad ? "bad" : "warn"}">${
    escape(ok ? yes : no)}</span>`;
}

function dashboard(store: Store, config: Config, sync: SyncState): string {
  const derive = (index: number): string => deriveAddress(config, index);
  const wallet = createWallet(config.seedHex, config.network);
  const pairing = store.get("pairing", Pairing);
  const pending = store.get("notification", Pending);
  let approved = false;
  try {
    requireApproval(store, config);
    approved = true;
  } catch {}

  const halt = store.halted();
  const blocker = store.issuanceBlocker(derive);
  const next = store.nextIndex();
  const lastPaid = store.lastConfirmedPayment();
  const issuing = approved && !blocker;

  const steps: [boolean, string][] = [
    [true, "Installation initialized"],
    [Boolean(pairing), "Dojo paired"],
    [Boolean(pending), "Notification prepared"],
    [Boolean(store.findAllocation("setup_compatibility_test")),
      "Compatibility test address issued"],
    [approved, "Merchant approval verified"],
    [store.registeredAddress(next) !== undefined,
      "Next address registered with the Dojo"],
    [issuing, "Issuing addresses"],
  ];

  const rows = z.array(Row).parse(store.db.prepare(`
    SELECT a.idx, a.request_id, a.address, a.amount_sats, a.created_at,
      r.idx IS NOT NULL AS registered, p.txid, p.block_height
    FROM allocations a
    LEFT JOIN registrations r ON r.idx = a.idx
    LEFT JOIN payments p ON p.idx = a.idx
    ORDER BY a.idx DESC
  `).all());

  const table = rows.length === 0
    ? '<p class="muted">No addresses issued yet.</p>'
    : `<div class="table-wrap"><table>
<thead><tr><th>#</th><th>Request</th><th>Address</th><th>Amount</th>
<th>Issued</th><th>Dojo</th><th>Payment</th></tr></thead><tbody>
${rows.map(row => `<tr>
<td>${row.idx}</td>
<td>${escape(requestLabel(row.request_id))}</td>
<td class="mono">${escape(row.address)}</td>
<td class="nowrap">${row.amount_sats
    ? `${escape(row.amount_sats)} sats` : "—"}</td>
<td class="nowrap">${escape(formatTime(row.created_at))}</td>
<td>${badge(Boolean(row.registered), "registered", "pending")}</td>
<td>${row.txid
    ? `${badge(true, "confirmed", "")} <span class="muted">block ${
      escape(row.block_height)}</span>`
    : '<span class="muted">none confirmed</span>'}</td>
</tr>`).join("")}
</tbody></table></div>`;

  const dojo = pairing ? new URL(pairing.baseUrl) : undefined;

  return page("Tekiya operator", `
<header><h1>Tekiya operator</h1>
${badge(issuing, "issuing", "not issuing", Boolean(halt))}</header>
${halt ? `<div class="notice bad"><strong>Issuance halted.</strong> ${
    escape(halt.reason)} After recovery analysis, run
<code>resume-issuance --recovery-reviewed</code>.</div>` : ""}
${!halt && blocker ? `<div class="notice">${escape(blocker)}</div>` : ""}
<div class="grid">
<section class="card"><h2>Setup</h2><ol class="steps">
${steps.map(([done, label]) =>
    `<li${done ? ' class="done"' : ""}>${escape(label)}</li>`).join("")}
</ol></section>
<section class="card"><h2>Issuance</h2><dl>
<dt>Next index</dt><dd>${next < ISSUANCE_LIMIT
    ? escape(next) : "none (limit reached)"}</dd>
<dt>Limit</dt><dd>${ISSUANCE_LIMIT} addresses</dd>
<dt>Last confirmed</dt><dd>${lastPaid < 0 ? "none" : `index ${lastPaid}`}</dd>
<dt>Issuable through</dt><dd>index ${Math.min(
    lastPaid + RECEIVER_LOOKAHEAD, ISSUANCE_LIMIT - 1)}</dd>
</dl></section>
<section class="card"><h2>Dojo</h2><dl>
<dt>Pairing</dt><dd class="mono">${dojo
    ? escape(`${dojo.hostname.slice(0, 16)}….onion${dojo.pathname}`)
    : "not paired"}</dd>
<dt>Last sync</dt><dd>${escape(sync.lastSuccess ?? "never")}</dd>
${sync.lastError ? `<dt>Last error</dt><dd>${escape(sync.lastError)}</dd>` : ""}
${sync.lastResult ? `<dt>Registered</dt><dd>${
    escape(sync.lastResult.registered.join(", ") || "none")}</dd>` : ""}
</dl></section>
</div>
<section class="card"><h2>Addresses</h2>${table}</section>
<details class="card"><summary>Identity</summary><dl>
<dt>Page name</dt><dd>${escape(
    store.get("profile", Profile)?.name ?? "default (run profile to set)")}</dd>
<dt>Network</dt><dd>${escape(config.network)}</dd>
<dt>Onion</dt><dd class="mono">${escape(config.onion)}</dd>
<dt>Merchant</dt><dd class="mono">${escape(config.merchantCode)}</dd>
<dt>Dispenser</dt><dd class="mono">${escape(wallet.sender.toBase58())}</dd>
<dt>Funding</dt><dd class="mono">${escape(wallet.fundingAddress)}</dd>
<dt>Notification</dt><dd class="mono">${escape(pending?.txid ?? "none")}</dd>
</dl></details>
<p class="muted">Read-only. Refreshes every 30 seconds.</p>`,
  { wide: true, refreshSeconds: 30 });
}

// Loopback only and never behind the onion service. The Host check stops
// DNS-rebinding pages from reading it through the operator's browser.
export function serveAdmin(
  store: Store,
  config: Config,
  sync: SyncState,
): { close: () => void } | undefined {
  const port = z.coerce.number().int().min(0).max(65535)
    .parse(process.env.NYM_ADMIN_PORT ?? "8089");
  if (port === 0) return undefined;
  requireCondition(
    port !== Number(process.env.NYM_PORT ?? "8088"),
    "NYM_ADMIN_PORT must differ from NYM_PORT",
  );
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) {
        res.writeHead(421);
        res.end();
        return;
      }
      if (req.method !== "GET" || req.url !== "/") {
        sendHtml(res, 404, page("Not found", "<p>Not found.</p>"));
        return;
      }
      sendHtml(res, 200, dashboard(store, config, sync));
    } catch (error) {
      sendHtml(res, 500, page("Error", `<p>${escape(
        error instanceof Error ? error.message : "Dashboard failed",
      )}</p>`));
    }
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`Tekiya operator dashboard: http://127.0.0.1:${port}/`);
  });
  return { close: () => server.close() };
}
