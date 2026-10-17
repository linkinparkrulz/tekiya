import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  Config, Profile, Unavailable, publicPaymentsEnabled, requireCondition, type NetworkName,
} from "./config.js";
import { createWallet, deriveAddress } from "./bitcoin.js";
import {
  bitcoinUri, escape, formatTime, page, qrSvg, sendHtml,
} from "./html.js";
import { requireApproval } from "./approval.js";
import { Store, type PaymentState, type PaymentStatus } from "./store.js";

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

function message(site: Site, title: string, text: string, back = "/"): string {
  return page(siteTitle(site, title), `${header(site)}
<div class="card"><h2>${escape(title)}</h2><p>${escape(text)}</p>
<a class="button" href="${escape(back)}">Back</a></div>`);
}

function form(site: Site): string {
  return page(siteTitle(site), `${header(site, true)}
<form class="card stack" method="post" action="/pay">
  <p>Get a fresh address for one payment. It is used for you alone and
  never handed out again.</p>
  <div>
    <label for="amount">Amount in BTC
      <span class="muted">(optional)</span></label>
    <input type="text" id="amount" name="amount" inputmode="decimal"
      autocomplete="off" placeholder="0.0001">
  </div>
  <button type="submit">Get payment address</button>
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

function btcPanel(status: PaymentStatus): string {
  const { allocation } = status;
  const uri = bitcoinUri(allocation.address, allocation.amount_sats);
  const amount = allocation.amount_sats
    ? `${(allocation.amount_sats / 100000000).toFixed(8)} BTC` : "";
  return `<h2>Send your payment to this address</h2>
  <a class="qr" href="${escape(uri)}" title="Open in your Bitcoin wallet">${
  qrSvg(uri, "Payment QR code. Select to open your Bitcoin wallet.")}</a>
  <p class="muted center">Tap or click the code to open your Bitcoin
  wallet, or scan it from another device.</p>
  <div class="address">${escape(allocation.address)}</div>
  <dl>${amount ? `<dt>Amount</dt><dd>${escape(amount)}</dd>` : ""}
  <dt>Status</dt><dd>${escape(STATE_TEXT[status.state])}</dd>
  <dt>Issued</dt><dd>${escape(formatTime(allocation.created_at))}</dd></dl>
  <a class="button" href="${escape(uri)}">Open in wallet</a>
  <p class="muted">Bitcoin payments confirm in about 10 minutes. Use this
  address for one payment. Bookmark this page to see it again.</p>`;
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
  const sats = Number(match[1]) * 100000000 +
    Number((match[2] ?? "").padEnd(8, "0"));
  requireCondition(sats <= 100000000, "At most 1 BTC");
  return sats;
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
    if (!publicPaymentsEnabled(store)) {
      sendHtml(res, 503, message(site, "Public payments disabled",
        "This service is not accepting anonymous payment requests."));
      return true;
    }
    try {
      requireCondition(config, "Not set up");
      requireApproval(store, config);
    } catch {
      sendHtml(res, 503, message(site, "Not accepting payments yet",
        "This payment service has not been approved by the merchant."));
      return true;
    }
    if (store.issuanceBlocker(index => deriveAddress(config, index))) {
      sendHtml(res, 503, message(site, "Temporarily unavailable",
        "No payment address can be issued right now. Please try later."));
      return true;
    }
    sendHtml(res, 200, form(site));
    return true;
  }

  if (req.method === "POST" && path === "/pay") {
    try {
      const body = await readForm(req);
      const nonce = body.get("nonce") ?? "";
      if (!NONCE.test(nonce)) throw new Error("Form expired; reload the page");
      const id = webId(nonce);
      // First submission wins: a resubmitted form keeps its address.
      if (!store.findAllocation(id)) {
        if (!publicPaymentsEnabled(store)) throw new Unavailable("Public payments disabled");
        if (!config) throw new Unavailable("Not set up");
        requireApproval(store, config);
        const sats = parseBtcAmount(body.get("amount") ?? "");
        const derive = (index: number) => deriveAddress(config, index);
        const blocker = store.issuanceBlocker(derive);
        if (blocker) throw new Unavailable(blocker);
        store.allocate(id, sats, derive);
      }
      res.setHeader("Location", `/pay/${nonce}`);
      res.writeHead(303);
      res.end();
    } catch (error) {
      if (error instanceof Unavailable) {
        sendHtml(res, 503, message(site, "Temporarily unavailable",
          error.message));
      } else {
        sendHtml(res, 400, message(site, "Request not accepted",
          error instanceof Error ? error.message : "Request failed"));
      }
    }
    return true;
  }

  const view = /^\/pay\/([0-9a-f]{32})$/.exec(path);
  if (req.method === "GET" && view?.[1]) {
    const id = webId(view[1]);
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
