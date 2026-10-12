import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Config, Profile, Unavailable, requireCondition, type NetworkName,
} from "./config.js";
import { createWallet, deriveAddress } from "./bitcoin.js";
import {
  bitcoinUri, escape, formatTime, page, qrSvg, sendHtml,
} from "./html.js";
import { requireApproval } from "./approval.js";
import {
  XMR_CONFIRMATIONS, allocateMonero, formatXmr, moneroSettings, moneroUri,
  parseXmrAmount, xmrBlocker,
} from "./monero.js";
import {
  Store, type PaymentState, type PaymentStatus, type XmrPaymentStatus,
} from "./store.js";

// Web requests are keyed by an unguessable nonce from the form, so a
// resubmitted form returns the same address and only its holder can view it.
const NONCE = /^[0-9a-f]{32}$/;
const webId = (nonce: string): string => `web_${nonce}`;

const DEFAULT_NAME = "Pay with Bitcoin";

interface Site {
  readonly network: NetworkName;
  // Undefined until the operator has started setup.
  readonly config: Config | undefined;
  readonly profile: Profile | undefined;
}

function siteTitle(site: Site, title?: string): string {
  const name = site.profile?.name ?? DEFAULT_NAME;
  return title ? `${title} · ${name}` : name;
}

function header(site: Site, intro = false): string {
  const { network, profile } = site;
  const testnet = network !== "mainnet";
  const description = intro && profile?.description
    ? `<p class="lead">${escape(profile.description)}</p>`
    : "";
  return `<header><h1>${escape(profile?.name ?? DEFAULT_NAME)}</h1>
<span class="badge ${testnet ? "warn" : "ok"}">${escape(network)}</span>
</header>${description}${testnet
    ? '<div class="notice">Test network. These coins have no value.</div>'
    : ""}`;
}

function message(site: Site, title: string, text: string): string {
  return page(siteTitle(site, title), `${header(site)}
<div class="card"><h2>${escape(title)}</h2><p>${escape(text)}</p>
<a class="button" href="/">Back</a></div>`);
}

function form(site: Site, monero: boolean): string {
  return page(siteTitle(site), `${header(site, true)}
<form class="card stack" method="post" action="/pay">
  <p>Get a fresh address for one payment. It is used for you alone and
  never handed out again.</p>
  <div>
    <label for="amount">Amount${monero ? "" : " in BTC"}
      <span class="muted">(optional)</span></label>
    <div class="amount-row">
    <input type="text" id="amount" name="amount" inputmode="decimal"
      autocomplete="off" placeholder="0.0001">
    ${monero ? `<select name="currency" aria-label="Currency">
      <option value="BTC">BTC</option><option value="XMR">XMR</option>
    </select>` : ""}
    </div>
  </div>
  <button type="submit">${monero ? "Continue" : "Get payment address"}</button>
  <input type="hidden" name="nonce" value="${randomBytes(16).toString("hex")}">
</form>
<p class="muted">Your browser needs no JavaScript for this page.</p>`);
}

function identity(config: Config): string {
  const dispenser = createWallet(config.seedHex, config.network)
    .sender.toBase58();
  return `<details class="card">
  <summary>Merchant identity</summary>
  <p class="muted">Bitcoin addresses are derived from the merchant's BIP47
  payment code. The merchant signed an approval of this service; that binds
  its identity but does not independently prove each address.</p>
  <dl>
    <dt>Merchant</dt><dd class="mono">${escape(config.merchantCode)}</dd>
    <dt>Dispenser</dt><dd class="mono">${escape(dispenser)}</dd>
  </dl>
  <p><a href="/identity">Signed identity statement</a></p>
</details>`;
}

const STATE_TEXT: Record<PaymentState, string> = {
  pending: "Waiting for your payment.",
  seen: "Payment seen; waiting for confirmation.",
  paid: "Payment confirmed. Thank you!",
  underpaid: "Part of the amount has arrived.",
};

function payPanel(input: {
  coin: string;
  uri: string;
  address: string;
  amount?: string;
  issued: string;
  state: PaymentState;
  note: string;
}): string {
  return `<h2>Send your payment to this address</h2>
  <a class="qr" href="${escape(input.uri)}"
    title="Open in your ${input.coin} wallet">${
  qrSvg(input.uri, `Payment QR code. Select to open your ${input.coin} wallet.`)}</a>
  <p class="muted center">Tap or click the code to open your ${input.coin}
  wallet, or scan it from another device.</p>
  <div class="address">${escape(input.address)}</div>
  <dl>${input.amount ? `<dt>Amount</dt><dd>${escape(input.amount)}</dd>` : ""}
  <dt>Status</dt><dd>${escape(STATE_TEXT[input.state])}</dd>
  <dt>Issued</dt><dd>${escape(formatTime(input.issued))}</dd></dl>
  <a class="button" href="${escape(input.uri)}">Open in wallet</a>
  <p class="muted">${escape(input.note)} Use this address for one payment.
  Bookmark this page to see it again.</p>`;
}

function btcPanel(status: PaymentStatus): string {
  const { allocation } = status;
  return payPanel({
    coin: "Bitcoin",
    uri: bitcoinUri(allocation.address, allocation.amount_sats),
    address: allocation.address,
    ...(allocation.amount_sats ? {
      amount: `${(allocation.amount_sats / 100000000).toFixed(8)} BTC`,
    } : {}),
    issued: allocation.created_at,
    state: status.state,
    note: "Bitcoin payments confirm in about 10 minutes.",
  });
}

function xmrPanel(status: XmrPaymentStatus): string {
  const { allocation } = status;
  return payPanel({
    coin: "Monero",
    uri: moneroUri(allocation.address, allocation.amount_atomic),
    address: allocation.address,
    ...(allocation.amount_atomic ? {
      amount: `${formatXmr(allocation.amount_atomic)} XMR`,
    } : {}),
    issued: allocation.created_at,
    state: status.state,
    note: `Monero payments are final after ${XMR_CONFIRMATIONS} ` +
      "confirmations, about 20 minutes.",
  });
}

type Coin = "btc" | "xmr";

// Bitcoin / Monero switch above one QR: a coin's tab is a link once its
// address exists, otherwise a button that creates it. No JavaScript.
function choosePage(
  site: Site,
  config: Config,
  nonce: string,
  store: Store,
  selected: Coin | undefined,
): string {
  const id = webId(nonce);
  const btc = store.paymentStatus(id);
  const xmr = store.xmrPaymentStatus(id);
  const tab = (coin: Coin, label: string, exists: boolean) => {
    const current = coin === selected ? ' aria-current="page"' : "";
    return exists
      ? `<a class="tab${coin === selected ? " active" : ""}"${current}
          href="/pay/${nonce}?coin=${coin}">${label}</a>`
      : `<button class="tab" type="submit" name="coin" value="${coin}">${
        label}</button>`;
  };
  let panel: string;
  if (selected === "btc" && btc) panel = btcPanel(btc);
  else if (selected === "xmr" && xmr) panel = xmrPanel(xmr);
  else {
    panel = `<h2>How would you like to pay?</h2>
<p>Choose Bitcoin or Monero above. Each gives you a fresh address for this
payment only.</p>`;
  }
  return page(siteTitle(site, "Your payment"), `${header(site)}
<div class="card stack">
<form method="post" action="/pay/${nonce}/coin" class="tabs" role="tablist">
${tab("btc", "Bitcoin", Boolean(btc))}${tab("xmr", "Monero", Boolean(xmr))}
</form>
${panel}
</div>
${identity(config)}`);
}

function result(site: Site, config: Config, status: PaymentStatus): string {
  return page(siteTitle(site, "Your payment address"), `${header(site)}
<div class="card stack">${btcPanel(status)}</div>
${identity(config)}`);
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > 4096) throw new Error("Request body exceeds 4096 bytes");
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

export function parseBtcAmount(value: string): number {
  const text = value.trim();
  if (text === "") return 0;
  const match = /^(\d{1,8})(?:\.(\d{1,8}))?$/.exec(text);
  if (!match) throw new Error("Enter the amount as BTC, like 0.0001");
  return Number(match[1]) * 100000000 +
    Number((match[2] ?? "").padEnd(8, "0"));
}

// Returns false when the request is not for a public page.
export async function handlePublic(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  network: NetworkName,
): Promise<boolean> {
  const path = (req.url ?? "").split("?")[0] ?? "";
  const config = store.get("config", Config);
  const site: Site = {
    network, config, profile: store.get("profile", Profile),
  };

  if (req.method === "GET" && path === "/") {
    try {
      requireCondition(config, "Not set up");
      requireApproval(store, config);
    } catch {
      sendHtml(res, 503, message(site, "Not accepting payments yet",
        "This payment service has not been approved by the merchant."));
      return true;
    }
    const monero = moneroSettings(store) !== undefined;
    const btcBlocked = store.issuanceBlocker(
      index => deriveAddress(config, index),
    );
    if (btcBlocked && (!monero || xmrBlocker(store))) {
      sendHtml(res, 503, message(site, "Temporarily unavailable",
        "No payment address can be issued right now. Please try later."));
      return true;
    }
    sendHtml(res, 200, form(site, monero));
    return true;
  }

  if (req.method === "POST" && path === "/pay") {
    try {
      if (!config) throw new Unavailable("Not set up");
      requireApproval(store, config);
      const body = await readForm(req);
      const nonce = body.get("nonce") ?? "";
      if (!NONCE.test(nonce)) throw new Error("Form expired; reload the page");
      if (moneroSettings(store)) {
        // The payer picks a coin next; nothing is allocated yet.
        const currency = body.get("currency") === "XMR" ? "XMR" : "BTC";
        const amount = body.get("amount") ?? "";
        store.createWebRequest(
          webId(nonce), currency,
          currency === "XMR" ? parseXmrAmount(amount) : parseBtcAmount(amount),
        );
      } else {
        store.allocate(
          webId(nonce),
          parseBtcAmount(body.get("amount") ?? ""),
          index => deriveAddress(config, index),
        );
      }
      res.setHeader("Location", `/pay/${nonce}`);
      res.writeHead(303);
      res.end();
    } catch (error) {
      if (error instanceof Unavailable) {
        sendHtml(res, 503, message(site, "Temporarily unavailable",
          "No payment address can be issued right now. Please try later."));
      } else {
        sendHtml(res, 400, message(site, "Request not accepted",
          error instanceof Error ? error.message : "Request failed"));
      }
    }
    return true;
  }

  const choose = /^\/pay\/([0-9a-f]{32})\/coin$/.exec(path);
  if (req.method === "POST" && choose?.[1]) {
    const nonce = choose[1];
    const id = webId(nonce);
    try {
      const request = store.findWebRequest(id);
      if (!config || !request) throw new Error("This payment link is not valid");
      const coin = (await readForm(req)).get("coin") === "xmr" ? "xmr" : "btc";
      // An amount entered in the other coin is dropped.
      if (coin === "xmr") {
        await allocateMonero(store, id,
          request.currency === "XMR" ? request.amount_atomic : 0);
      } else {
        requireApproval(store, config);
        store.allocate(id, request.currency === "BTC" ? request.amount_atomic : 0,
          index => deriveAddress(config, index));
      }
      res.setHeader("Location", `/pay/${nonce}?coin=${coin}`);
      res.writeHead(303);
      res.end();
    } catch (error) {
      sendHtml(res, error instanceof Unavailable ? 503 : 400, message(site,
        error instanceof Unavailable ? "Temporarily unavailable" : "Request not accepted",
        error instanceof Error ? error.message : "Request failed"));
    }
    return true;
  }

  const view = /^\/pay\/([0-9a-f]{32})$/.exec(path);
  if (req.method === "GET" && view?.[1]) {
    const nonce = view[1];
    const id = webId(nonce);
    if (config && store.findWebRequest(id)) {
      const asked = new URL(req.url ?? "", "http://x").searchParams.get("coin");
      const selected: Coin | undefined = asked === "btc" || asked === "xmr"
        ? asked
        : store.findAllocation(id) ? "btc" : store.findXmr(id) ? "xmr" : undefined;
      sendHtml(res, 200, choosePage(site, config, nonce, store, selected));
      return true;
    }
    const status = store.paymentStatus(id);
    if (!status || !config) {
      sendHtml(res, 404, message(site, "Address not found",
        "This payment link is not valid."));
    } else {
      sendHtml(res, 200, result(site, config, status));
    }
    return true;
  }

  return false;
}
