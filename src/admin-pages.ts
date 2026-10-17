import { z } from "zod";
import {
  Approval, Config, ISSUANCE_LIMIT, Pairing, Pending, Profile,
  RECEIVER_LOOKAHEAD, publicPaymentsEnabled, type NetworkName,
} from "./config.js";
import {
  createWallet, deriveAddress, identityStatement, receiver,
} from "./bitcoin.js";
import { requireApproval } from "./approval.js";
import {
  bitcoinUri, escape, formatTime, page, qrSvg,
} from "./html.js";
import type { MonitorState } from "./monitor.js";
import { NOTIFICATION_SATS } from "./bitcoin.js";
import {
  FEE_CHOICE, FeeChoice, MAX_FUNDING_SATS, MIN_FEE_RATE, REAPPROVAL_NOTICE,
  TEST_REQUEST_ID, broadcastRecorded, chosenRate, feePresets,
  notificationConfirmed,
  fundingRequired, usableFunding,
} from "./setup.js";
import { paynymStatus } from "./paynym.js";
import { Store } from "./store.js";

export type Step =
  | "merchant" | "dojo" | "fund" | "broadcast" | "confirm"
  | "test" | "test-wait" | "sign" | "live";

export function currentStep(store: Store, monitor: MonitorState): Step {
  const config = store.get("config", Config);
  if (!config) return "merchant";
  if (!store.get("pairing", Pairing)) return "dojo";
  if (!store.get("notification", Pending)) return "fund";
  if (!notificationConfirmed(store)) {
    const confirmations = monitor.notificationConfirmations;
    if (!broadcastRecorded(store) && confirmations === undefined) {
      return "broadcast";
    }
    if (!confirmations) return "confirm";
  }
  if (!store.findAllocation(TEST_REQUEST_ID)) return "test";
  if (store.lastConfirmedPayment() < 0) return "test-wait";
  if (!store.get("approval", Approval)) return "sign";
  return "live";
}

const PROGRESS: [string, Step[]][] = [
  ["Connect your merchant wallet", ["merchant"]],
  ["Connect your Dojo", ["dojo"]],
  ["Fund the dispenser", ["fund"]],
  ["Notify your wallet", ["broadcast", "confirm"]],
  ["Test a payment", ["test", "test-wait"]],
  ["Approve", ["sign"]],
];

export interface View {
  readonly store: Store;
  readonly network: NetworkName;
  readonly monitor: MonitorState;
  readonly detectedOnion: string | undefined;
  readonly error?: string;
  // Fields from a form that failed, shown again; never secrets.
  readonly draft?: Record<string, string>;
}

const units = (sats: number): string =>
  `${sats.toLocaleString("en-US")} sats`;

function checkButton(label = "Check now"): string {
  return `<form method="post" action="/check" class="inline">
<button class="secondary" type="submit">${escape(label)}</button></form>`;
}

function syncLine(monitor: MonitorState): string {
  if (monitor.lastError) {
    return `<p class="hint">Last Dojo check failed: ${
      escape(monitor.lastError)}<br>${monitor.lastSuccess
        ? `Last successful check: ${escape(formatTime(monitor.lastSuccess))}.`
        : "No check has succeeded since Tekiya started."}</p>`;
  }
  return monitor.lastSuccess
    ? `<p class="hint">Last checked ${escape(formatTime(monitor.lastSuccess))}.
Checks run every minute.</p>`
    : '<p class="hint">Checking the Dojo…</p>';
}

function merchantStep(view: View): string {
  const onion = view.detectedOnion
    ? `<input type="hidden" name="onion" value="${escape(view.detectedOnion)}">
<p class="hint">Your page's onion address was detected:
<span class="mono">${escape(view.detectedOnion)}</span></p>`
    : `<div><label for="onion">Your Tekiya onion address</label>
<input type="text" id="onion" name="onion" autocomplete="off"
  placeholder="abc…xyz.onion" required>
<p class="hint">The hidden service for this page. On a host install, find it
with <code>sudo cat /var/lib/tor/nymdispenser/hostname</code>.</p></div>`;
  return `<h2>Connect your merchant wallet</h2>
<p>Tekiya hands out addresses that belong to your own wallet. It never sees
your wallet's keys; it only needs your public payment code.</p>
<form method="post" action="/setup/init" class="stack">
<div><label for="merchantCode">Your payment code</label>
<textarea id="merchantCode" name="merchantCode" required rows="3"
  placeholder="PM8T…"></textarea>
<p class="hint">Copy it from your wallet's PayNym screen. It starts with
PM8T.</p></div>
${onion}
<button type="submit">Create dispenser wallet</button>
</form>`;
}

function dojoForm(action: string, label: string): string {
  return `<form method="post" action="${action}" class="stack">
<div><label for="pairing">Dojo pairing</label>
<textarea id="pairing" name="pairing" required
  placeholder='{"pairing": {"apikey": "…", "url": "http://….onion/…"}}'></textarea>
<p class="hint">In your Dojo's maintenance tool, open <em>Pairing</em> and
copy the pairing text. Connecting over Tor can take up to a minute.</p></div>
<button type="submit">${escape(label)}</button>
</form>`;
}

function dojoStep(view: View): string {
  return `<h2>Connect your Dojo</h2>
<p>Use <strong>the same Dojo your merchant wallet is connected to</strong>.
Tekiya registers each address there before handing it out, so your wallet
always finds the payments.</p>
${dojoForm("/setup/pair", "Connect Dojo")}
<p class="hint">Network: ${escape(view.network)}. The pairing must be for the
same network.</p>`;
}

function feeDial(
  config: Config,
  fees: Record<string, number>,
  choice: FeeChoice | undefined,
  // When set, rates the funding cannot pay for are disabled.
  available?: number,
): string {
  const presets = feePresets(fees);
  const affordable = (rate: number) =>
    available === undefined || available >= fundingRequired(config, rate);
  const selectedRate = chosenRate(choice, fees);
  let selected = choice?.preset ?? "standard";
  if (!affordable(selectedRate)) {
    selected = [...presets].reverse().find(p => affordable(p.rate))?.id
      ?? "custom";
  }
  const option = (id: string, label: string, detail: string, ok: boolean) =>
    `<label class="preset${ok ? "" : " disabled"}">
<input type="radio" name="preset" value="${id}"${id === selected ? " checked" : ""}${
  ok ? "" : " disabled"}>
<span><strong>${escape(label)}</strong> <span class="muted">${
  escape(detail)}</span></span></label>`;
  const custom = choice?.preset === "custom" && choice.customRate
    ? choice.customRate : presets[1]?.rate ?? MIN_FEE_RATE;
  return `<fieldset class="dial"><legend>Miner fee</legend>
${presets.map(p => option(
    p.id, p.label,
    `${p.rate} sat/vB · ${p.hint} · ${units(fundingRequired(config, p.rate))} total`,
    affordable(p.rate),
  )).join("")}
<label class="preset"><input type="radio" name="preset" value="custom"${
  selected === "custom" ? " checked" : ""}>
<span><strong>Custom</strong>
<input type="number" name="customRate" min="${MIN_FEE_RATE}" max="1000"
  value="${custom}" aria-label="Custom fee rate"> sat/vB</span></label>
<p class="hint">Never below ${MIN_FEE_RATE} sat/vB; higher when your Dojo
estimates more.</p></fieldset>`;
}

function fundStep(view: View, store: Store, config: Config): string {
  const address = createWallet(config.seedHex, config.network).fundingAddress;
  const funding = view.monitor.funding;
  const fees = funding?.fees ?? {};
  const choice = store.get(FEE_CHOICE, FeeChoice);
  const rate = chosenRate(choice, fees);
  const amount = fundingRequired(config, rate);
  const usable = funding && usableFunding(funding.utxos);
  const unconfirmed = funding?.utxos.filter(utxo => utxo.confirmations === 0);
  const tooLarge = funding?.utxos.filter(utxo => utxo.value > MAX_FUNDING_SATS);

  if (usable) {
    return `<h2>Fund the dispenser</h2>
<div class="notice">Received ${units(usable.value)} (confirmed).</div>
<p>Choose the miner fee for the notification transaction. It sends
${NOTIFICATION_SATS} sats to your wallet's notification address.</p>
<form method="post" action="/setup/notification" class="stack">
<input type="hidden" name="txid" value="${escape(usable.txid)}">
<input type="hidden" name="vout" value="${escape(usable.vout)}">
${feeDial(config, fees, choice, usable.value)}
<button type="submit">Create notification transaction</button>
</form>`;
  }

  let status: string;
  if (unconfirmed?.length) {
    status = `<div class="notice">Payment seen (${units(
      unconfirmed[0]?.value ?? 0)}). Waiting for one confirmation…</div>`;
  } else if (tooLarge?.length) {
    status = `<div class="notice bad">This build only uses funding outputs up
to ${units(MAX_FUNDING_SATS)}. Send a smaller amount to the same address.</div>`;
  } else {
    status = '<div class="notice">Waiting for a payment to this address…</div>';
  }

  const uri = bitcoinUri(address, amount);
  return `<h2>Fund the dispenser</h2>
<p>Tekiya made a small wallet of its own to send one setup transaction to
your wallet. Send exactly <strong class="copyable">${units(amount)}</strong>:
${NOTIFICATION_SATS} sats for your wallet plus ${
  units(amount - NOTIFICATION_SATS)} miner fee at ${rate} sat/vB. Anything
extra stays in the dispenser's wallet as change.</p>
<a class="qr" href="${escape(uri)}">${qrSvg(uri, "Funding QR code")}</a>
<div class="address">${escape(address)}</div>
${status}
<form method="post" action="/setup/fee" class="stack">
${feeDial(config, fees, choice)}
<button class="secondary" type="submit">Update amount</button>
</form>
<div class="actions">${checkButton()}</div>
${syncLine(view.monitor)}`;
}

function notificationDetails(pending: Pending): string {
  return `<dl>
<dt>Transaction</dt><dd class="mono">${escape(pending.txid)}</dd>
<dt>To your wallet</dt><dd>546 sats</dd>
<dt>Miner fee</dt><dd>${units(pending.feeSats)}
(${escape(pending.feeRate.toFixed(1))} sat/vB)</dd>
<dt>Change kept</dt><dd>${units(pending.changeSats)}</dd>
</dl>`;
}

function broadcastStep(pending: Pending): string {
  return `<h2>Notify your wallet</h2>
<p>This one-time transaction tells your merchant wallet that addresses from
this dispenser belong to it. It is signed and ready.</p>
${notificationDetails(pending)}
<form method="post" action="/setup/broadcast">
<button type="submit">Broadcast</button></form>`;
}

function confirmStep(view: View, pending: Pending): string {
  return `<h2>Notify your wallet</h2>
<div class="notice">Broadcast. Waiting for one confirmation…</div>
${notificationDetails(pending)}
<div class="actions">${checkButton()}
<form method="post" action="/setup/broadcast" class="inline">
<button class="secondary" type="submit">Broadcast again</button></form>
</div>
${syncLine(view.monitor)}`;
}

function testStep(): string {
  return `<h2>Test a payment</h2>
<p>Before going live, prove the connection works: send a small payment to a
test address and check that your merchant wallet receives it.</p>
<form method="post" action="/setup/test-address">
<button type="submit">Get test address</button></form>`;
}

function testWaitStep(view: View, store: Store): string {
  const allocation = store.findAllocation(TEST_REQUEST_ID);
  const address = allocation?.address ?? "";
  return `<h2>Test a payment</h2>
<p>Send about <strong>2,000 sats</strong> from any wallet to this address.
Then open your merchant wallet: the payment should appear under the
dispenser's PayNym. <strong>Spend it</strong> (send it anywhere, even to
yourself) to prove your wallet controls it.</p>
<a class="qr" href="${escape(bitcoinUri(address, 2000))}">${
  qrSvg(bitcoinUri(address, 2000), "Test address QR code")}</a>
<div class="address">${escape(address)}</div>
<div class="notice">Waiting for the payment to confirm…</div>
<div class="actions">${checkButton()}</div>
${syncLine(view.monitor)}`;
}

function signStep(store: Store, config: Config, pending: Pending): string {
  const statement = identityStatement(config, pending);
  const signer = receiver(config.merchantCode, config.network)
    .getNotificationAddress();
  const reapproval = store.get(REAPPROVAL_NOTICE, z.object({ reason: z.string() }));
  return `<h2>Approve</h2>
${reapproval ? `<div class="notice">${escape(reapproval.reason)}</div>` : ""}
<div class="notice">Test payment confirmed. Make sure your merchant wallet
shows it and that you have spent it before approving.</div>
<p>In your merchant wallet, sign this exact text with your PayNym (its
notification address), then paste the result below. Either the signature
alone or the whole signed-message block works.</p>
<label for="statement">Text to sign</label>
<textarea id="statement" readonly rows="14">${escape(statement)}</textarea>
<p class="hint">Signing address: <span class="mono">${escape(signer)}</span></p>
<form method="post" action="/setup/approve" class="stack">
<div><label for="signature">Signature or signed message</label>
<textarea id="signature" name="signature" required rows="6"
  placeholder="-----BEGIN BITCOIN SIGNED MESSAGE-----"></textarea></div>
<button type="submit">Approve and go live</button>
</form>`;
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
  confirmed_sats: z.number().int().nullable(),
  unconfirmed_sats: z.number().int().nullable(),
});

// Leading and trailing characters, as wallets display addresses; the full
// address is one click away.
function shortAddress(address: string): string {
  const short = address.length > 20
    ? `${address.slice(0, 10)}…${address.slice(-6)}`
    : address;
  return `<details class="addr"><summary class="mono" title="${
    escape(address)}">${escape(short)}</summary>
<span class="mono copyable">${escape(address)}</span></details>`;
}

function receivedCell(confirmed: number | null, pending: number | null): string {
  if (confirmed === null) return '<span class="muted">checking…</span>';
  const total = confirmed + (pending ?? 0);
  if (total === 0) return '<span class="muted">nothing yet</span>';
  return `<span class="copyable nowrap">${units(confirmed)}</span>${pending
    ? `<br><span class="muted nowrap">+${units(pending)} pending</span>`
    : ""}`;
}

function requestLabel(id: string): string {
  // Web nonces grant access to the customer's page; show only their kind.
  if (id.startsWith("web_")) return "web page";
  if (id === TEST_REQUEST_ID) return "setup test";
  return id.length > 24 ? `${id.slice(0, 21)}…` : id;
}

function badge(ok: boolean, yes: string, no: string, bad = false): string {
  return `<span class="badge ${ok ? "ok" : bad ? "bad" : "warn"}">${
    escape(ok ? yes : no)}</span>`;
}

function publicPaymentsForm(store: Store): string {
  const enabled = publicPaymentsEnabled(store);
  return `<form method="post" action="/settings/public-payments" class="stack">
<input type="hidden" name="enabled" value="${enabled ? "false" : "true"}">
${enabled ? `<p>Disabling stops new anonymous requests and new currency allocations.
Existing payment pages remain accessible. The authenticated API is unaffected.</p>`
    : `<div class="notice">Anyone with your public page can request addresses
without paying. Allocations are irreversible and can exhaust issuance limits
or the wallet's lookahead window, preventing further payments.</div>
<label><input type="checkbox" name="reviewed" value="yes" required>
I understand the risks of anonymous, irreversible address allocation.</label>`}
<button type="submit">${enabled ? "Disable" : "Enable"} public payments</button>
</form>`;
}

function liveView(view: View, config: Config): string {
  const { store, monitor } = view;
  const derive = (index: number): string => deriveAddress(config, index);
  let approved = false;
  try {
    requireApproval(store, config);
    approved = true;
  } catch {}
  const halt = store.halted();
  const blocker = store.issuanceBlocker(derive);
  const btcReady = approved && !blocker;
  const publicEnabled = publicPaymentsEnabled(store);
  const next = store.nextIndex();
  const lastPaid = store.lastConfirmedPayment();
  const profile = store.get("profile", Profile);
  const pairing = store.get("pairing", Pairing);
  const dojo = pairing ? new URL(pairing.baseUrl) : undefined;
  const pending = store.get("notification", Pending);
  const wallet = createWallet(config.seedHex, config.network);

  const rows = z.array(Row).parse(store.db.prepare(`
    SELECT a.idx, a.request_id, a.address, a.amount_sats, a.created_at,
      r.idx IS NOT NULL AS registered, p.txid, p.block_height,
      v.confirmed_sats, v.unconfirmed_sats
    FROM allocations a
    LEFT JOIN registrations r ON r.idx = a.idx
    LEFT JOIN payments p ON p.idx = a.idx
    LEFT JOIN received v ON v.idx = a.idx
    ORDER BY a.idx DESC
  `).all());

  const table = `<div class="table-wrap"><table>
<thead><tr><th>#</th><th>Address</th><th>Received</th><th>Requested</th>
<th>Request</th><th>Issued</th><th>Dojo</th></tr></thead><tbody>
${rows.map(row => `<tr>
<td>${row.idx}</td>
<td>${shortAddress(row.address)}</td>
<td>${receivedCell(row.confirmed_sats, row.unconfirmed_sats)}${row.txid
    ? `<br><span class="muted nowrap">first in block ${
      escape(row.block_height)}</span>` : ""}</td>
<td class="nowrap">${row.amount_sats ? units(row.amount_sats) : "—"}</td>
<td>${escape(requestLabel(row.request_id))}</td>
<td class="nowrap">${escape(formatTime(row.created_at))}</td>
<td>${badge(Boolean(row.registered), "registered", "pending")}</td>
</tr>`).join("")}
</tbody></table></div>`;

  return `${halt ? `<div class="notice bad"><strong>Issuance halted.</strong>
${escape(halt.reason)}
<form method="post" action="/settings/resume" class="stack">
<label><input type="checkbox" name="reviewed" value="yes" required>
I have stopped every other copy and reviewed recovery.</label>
<button type="submit">Resume issuance</button></form></div>` : ""}
${!halt && blocker ? `<div class="notice">${escape(blocker)}</div>` : ""}
<section class="card"><h2>Your payment page</h2>
<p>Anonymous payments: ${badge(publicEnabled, "opted in", "disabled")}</p>
${publicPaymentsForm(store)}
<p>Public page: ${badge(publicEnabled && btcReady, "accepting requests", "not issuing")}</p>
<p>API readiness: ${badge(btcReady, "ready", "not ready")}</p>
<p>API readiness is independent of anonymous opt-in and does not guarantee backend availability.</p>
<p>${publicEnabled ? "Payment page address" : "Anonymous creation is disabled; the authenticated API remains available"}. Opens in Tor Browser:</p>
<div class="address">${escape(config.onion)}/</div>
<div class="actions">${checkButton("Check Dojo now")}</div>
${syncLine(monitor)}
</section>
<div class="grid">
<section class="card"><h2>Issuance</h2><dl>
<dt>Next address</dt><dd>${next < ISSUANCE_LIMIT
    ? `#${escape(next)}` : "none (limit reached)"}</dd>
<dt>Limit</dt><dd>${ISSUANCE_LIMIT} addresses (staging)</dd>
<dt>Last confirmed</dt><dd>${lastPaid < 0 ? "none" : `#${lastPaid}`}</dd>
<dt>Issuable through</dt><dd>#${Math.min(
    lastPaid + RECEIVER_LOOKAHEAD, ISSUANCE_LIMIT - 1)}</dd>
</dl></section>
<section class="card"><h2>Page details</h2>
<form method="post" action="/settings/profile" class="stack">
<div><label for="name">Name</label>
<input type="text" id="name" name="name" maxlength="80"
  value="${escape(profile?.name ?? "")}" placeholder="Pay with Bitcoin"></div>
<div><label for="description">Description
<span class="muted">(optional)</span></label>
<input type="text" id="description" name="description" maxlength="280"
  value="${escape(profile?.description ?? "")}"></div>
<button type="submit">Save</button>
<p class="hint">Leave the name empty for the default title.</p>
</form></section>
</div>
<section class="card"><h2>Addresses</h2>${table}</section>
<details class="card"><summary>Change Dojo</summary>
<p>Connect Tekiya to the new Dojo <strong>before</strong> moving your
merchant wallet to it, so existing payments are imported first.</p>
<p class="hint">Current: <span class="mono">${dojo
    ? escape(`${dojo.hostname.slice(0, 16)}….onion${dojo.pathname}`)
    : "none"}</span></p>
${dojoForm("/settings/pair", "Switch Dojo")}
</details>
<details class="card"><summary>Integration API</summary>
<p>For a shop or other backend: create a request with
<code>POST /v1/payment-requests</code>, follow it with
<code>GET /v1/payment-requests/&lt;id&gt;</code>, and check
<code>GET /v1/status</code> before checkout. Send this bearer token; keep it
on your server, never in browser code. Full reference:
<code>docs/API.md</code> in the Tekiya repository.</p>
<div class="address">${escape(config.apiToken)}</div>
</details>
${paynymCard(view)}
<details class="card"><summary>Identity</summary><dl>
<dt>Network</dt><dd>${escape(config.network)}</dd>
<dt>Merchant</dt><dd class="mono">${escape(config.merchantCode)}</dd>
<dt>Dispenser</dt><dd class="mono">${escape(wallet.sender.toBase58())}</dd>
<dt>Funding</dt><dd class="mono">${escape(wallet.fundingAddress)}</dd>
<dt>Notification</dt><dd class="mono">${escape(pending?.txid ?? "none")}</dd>
</dl></details>`;
}

function paynymCard(view: View): string {
  const { store, monitor } = view;
  if (!store.get("config", Config)) return "";
  const { dispenser, follow } = paynymStatus(store);
  const retry = `<form method="post" action="/paynym" class="inline">
<button class="secondary" type="submit">Try now</button></form>`;

  let body: string;
  if (dispenser && follow) {
    body = `<p>${badge(true, "registered", "")} <strong>${
      escape(dispenser.nymName)}</strong></p>
<p class="hint">Claimed with the dispenser's SegWit payment code and
following your PayNym.</p>`;
  } else if (monitor.paynymError) {
    body = `${dispenser ? `<p><strong>${escape(dispenser.nymName)}</strong>
claimed; following your PayNym is pending.</p>` : ""}
<p class="hint">${escape(monitor.paynymError)}</p>
<div class="actions">${retry}</div>`;
  } else {
    body = `<p class="hint">Registering the dispenser with the PayNym
directory over Tor and following your PayNym…</p>`;
  }
  return `<section class="card"><h2>PayNym</h2>${body}</section>`;
}

export function dashboard(view: View): string {
  const { store } = view;
  const step = currentStep(store, view.monitor);
  const config = store.get("config", Config);
  const pending = store.get("notification", Pending);
  const testnet = view.network !== "mainnet";

  const top = `<header><h1>Tekiya</h1>
<span class="badge ${testnet ? "warn" : "ok"}">${escape(view.network)}</span>
</header>
${view.error ? `<div class="notice bad">${escape(view.error)}</div>` : ""}`;

  if (step === "live" && config) {
    return page("Tekiya", `${top}${liveView(view, config)}`, { wide: true });
  }

  let body: string;
  switch (step) {
    case "merchant": body = merchantStep(view); break;
    case "dojo": body = dojoStep(view); break;
    case "fund": body = config ? fundStep(view, store, config) : ""; break;
    case "broadcast": body = pending ? broadcastStep(pending) : ""; break;
    case "confirm": body = pending ? confirmStep(view, pending) : ""; break;
    case "test": body = testStep(); break;
    case "test-wait": body = testWaitStep(view, store); break;
    default: body = config && pending ? signStep(store, config, pending) : "";
  }

  const index = PROGRESS.findIndex(([, steps]) => steps.includes(step));
  const progress = `<ol class="steps">${PROGRESS.map(([label], i) =>
    `<li class="${i < index ? "done" : i === index ? "current" : ""}">${
      escape(label)}</li>`).join("")}</ol>`;

  return page("Set up Tekiya", `${top}
<div class="layout">
<aside class="stack"><section class="card"><h2>Setup</h2>${progress}</section>
${paynymCard(view)}</aside>
<section class="card stack">${body}</section>
</div>
<section class="card"><h2>Public payments</h2>
<p>Anonymous payments: ${badge(publicPaymentsEnabled(store), "opted in", "disabled")}</p>
${publicPaymentsForm(store)}</section>
<p class="muted">Setup ${index + 1} of ${PROGRESS.length}.
Nothing here is shown on your public page.</p>`,
  { wide: true });
}
