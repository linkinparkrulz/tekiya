# Tekiya

Standalone TypeScript BIP47 address-dispenser development build.

Not audited. Not wallet-interoperability tested. Start with testnet4.

## Quick start

With Docker:

Set `NYM_ADMIN_PASSWORD` in your shell or a local `.env` file to a unique,
random password of at least 12 characters (for example, generate one with
`openssl rand -hex 24`). Do not commit `.env` or share the password.

    docker compose up -d --build

Open http://127.0.0.1:8089 on the same machine (from elsewhere, tunnel it:
`ssh -L 8089:127.0.0.1:8089 your-server`) and follow the setup. The
dashboard asks for that password (any username) and walks through every step:

1. Paste your merchant wallet's payment code (either form; it is stored
   in SegWit form). The onion address is detected automatically. Tekiya
   then claims the dispenser's PayNym with its SegWit payment code and
   follows your PayNym, in the background over Tor.
2. Paste the pairing of the Dojo your merchant wallet uses.
3. Pick a miner fee and send the exact amount shown (about 5,700 sats at
   25 sat/vB). Funding is detected.
4. Create and broadcast the one-time notification transaction.
5. Pay a test address and check that your merchant wallet receives it.
6. Sign the approval text in your merchant wallet and paste the signature.

Without Docker: `npm ci && npm run build`, merge
`deploy/torrc.host.example` into your Tor configuration, then run
`npm start` (or install `deploy/nymdispenser.service`). The dashboard asks
for the onion address, which Tor writes to
`/var/lib/tor/nymdispenser/hostname`.

The authenticated integration API is then available on the onion address.
Anonymous payment creation stays disabled unless you explicitly set
`NYM_PUBLIC_PAYMENTS=true` and recreate the app container. Name the payment
page in the dashboard. Set `NYM_NETWORK=mainnet` only after testing on testnet4.

## PayNym directory

As soon as the dispenser wallet exists, Tekiya creates and claims its
PayNym with the dispenser's SegWit payment code and follows the merchant's
PayNym. The merchant's PayNym may list either form of its code. Failures
are retried every ten minutes and shown in the dashboard, which also has a
Try now button. `npm run cli -- paynym` runs it on demand.

Requests go over Tor to the directory's onion service
(`http://paynym25chftmsywv4v2r67agbrr62lcxagsf4tymbzpeeucucy2ivad.onion/api/v1/`).
Set `NYM_PAYNYM_API` to use another onion URL, or an HTTPS URL reached
through Tor.

Following publishes the dispenser–merchant relationship in a public
directory. It does not affect payment discovery, which relies on the
notification transaction.

## Monero (optional)

Start the view-only wallet service with
`docker compose --profile monero up -d --build`, then open **Monero** in
the dashboard and enter the wallet's primary address, private view key and
a node (a `.onion` node, reached through Tor, or one on your own machine or
network). On testnet4 installations Monero uses stagenet, where clearnet
nodes are also accepted, always reached through Tor, because public
stagenet nodes are mostly clearnet (for example
`stagenet.community.rino.io:38081`). Mainnet never accepts clearnet nodes.

To test, run Feather with `feather --stagenet`, create a wallet, copy its
primary address (starts with `5`) and private view key (Wallet → Keys),
and get stagenet coins from a faucet such as `stagenet-faucet.xmr-tw.org`
(third-party).

Tekiya creates a view-only `monero-wallet-rpc` wallet from those keys; the
view key is passed to the wallet once and never stored by Tekiya. The
wallet cannot spend. Each payment gets a fresh subaddress in a dedicated
account (default 1), so Tekiya never hands out an address the merchant's
wallet shows elsewhere; Monero wallets find payments to it on their own.
In Feather, payments to Tekiya appear under that account in the account
list, not in account 0.
Payments count as paid after 10 confirmations, and issuing pauses after 150
unused subaddresses in a row.

A view key reveals every payment the wallet receives to this server: use a
dedicated wallet, or at least a dedicated account.

On the payment page, payers choose Bitcoin or Monero; only the chosen
coin's address is created. One QR cannot serve both, since each wallet
only understands its own `bitcoin:` or `monero:` link.

The wallet image verifies the release: `hashes.txt` must carry a valid
signature from binaryFate's release key (fingerprint pinned in
`deploy/Monero.Dockerfile`), and the archive must match its SHA-256.

## Integration API

Shops and other backends request a fresh address per order and follow its
payment status over a small token-protected API; see
[docs/API.md](docs/API.md). A storefront is meant to be its own
application on top of it, keeping catalogue, prices and buyer details out
of Tekiya.

## Dashboard access

The dashboard never appears on the onion service. `NYM_ADMIN_AUTH` sets
who may reach it:

- `loopback` (default): `127.0.0.1` only, no password.
- `password`: HTTP basic auth with `NYM_ADMIN_PASSWORD` (12+ characters),
  for a private network. Set `NYM_ADMIN_HOST=0.0.0.0`.
- `proxy`: behind an authenticating reverse proxy, such as Umbrel's app
  proxy. Set `NYM_ADMIN_HOST=0.0.0.0`.
- `none`: no auth beyond the network; only behind a loopback-only
  forwarder with no untrusted peers able to reach the listener. Not used by
  the bundled Compose file.

Compose uses `password` mode and a host-loopback-only forwarder on a
dedicated internal dashboard network. Tor and Monero do not join that
network, but can still reach the app's admin listener on its shared private
network; password authentication protects that path. Basic auth is not
encrypted: keep the forwarder on localhost and use SSH tunnelling for
remote access, not a public port or unencrypted LAN connection.

In `loopback` and `none` modes the Host header must be
`127.0.0.1:PORT` or `localhost:PORT`; add others with `NYM_ADMIN_HOSTS`.
Forms only accept same-origin submissions.

On Umbrel, the app would run with `NYM_ADMIN_AUTH=proxy`, its app proxy
on the internal network pointing at port 8089, and its own Tor container
for the public onion, as in `compose.yaml`.

## Build

Requires Node 24+, npm, curl, and Tor.

- npm install
- npm run typecheck
- npm test

Keep package-lock.json. Subsequent installs should use npm ci.

## Network

NYM_NETWORK accepts mainnet or testnet4. Default: testnet4.

NYM_DATA is a parent directory. State is isolated under its network
subdirectory. A network change never converts the existing wallet.

Dojo pairing network labels are operator assertions, not chain proofs.

## Dojo address registration

The paired Dojo is assumed to be the one the merchant wallet uses.

Before an address can be issued, registration is requested from that Dojo through
a first `active=` lookup of its P2WPKH address. Dojo then tracks it,
and a later `new=` declaration by the receiving wallet (as Ashigaru's
Resync Paynym sends) cannot suppress its history. Pairing registers the
first addresses immediately. `serve` keeps three addresses registered
ahead of the next allocation and rechecks every minute.

The normal pairing API does not report import success: an echoed address
is not proof of tracking. Verify tracking in Dojo's administrative tools
and test merchant-wallet receipt before using real funds. Incomplete
transaction-history responses are rejected instead of replacing totals.

Payment-page requests are capped at 1,000 persisted records per installation.
Existing requests remain readable at the cap; records are not silently recycled.

Monero wallet mutations are saved before allocations are exposed. An ambiguous
RPC failure or crash leaves a durable `monero-reservation` and blocks further
issuance. To recover, stop every issuer, reconcile the wallet's account and
subaddresses against SQLite allocations, save the wallet, and only then remove
that settings record using SQLite tooling. Do not clear it merely to retry.

The same lookups record confirmed payments. An address is issued only
while it is within three indices of the last confirmed payment, matching
the receiving wallet's lookahead. Past that, the API returns 503 until a
payment confirms. Unpaid addresses are never recycled.

History on an address that was never issued indicates a cloned
installation or a stale backup. Issuance then halts until the cause is
investigated and `resume-issuance --recovery-reviewed` is run.

Pairing again (dashboard: Change Dojo) replaces the pairing and re-registers every address
with the new Dojo. Re-pair Tekiya first, and move the merchant wallet only
after a successful sync, so the new Dojo imports existing payments before
the wallet can declare those addresses new.

Registration links address issuance to the paired Dojo's operator.

## Commands

The dashboard covers setup. The same steps exist as commands, run with
npm run cli -- COMMAND.

- init MERCHANT_CODE ONION_ORIGIN
- info
- token
- directory
- pair PRIVATE_PAIRING_FILE
- paynym
- sync
- status
- profile NAME [DESCRIPTION] (or profile --clear)
- resume-issuance --recovery-reviewed
- prepare FUNDING_TXID VOUT FEE_SATS
- broadcast PREPARED_NOTIFICATION_TXID
- test-address
- statement
- approve SIGNATURE_FILE
- serve (starts the payment page and the dashboard, even before setup)

## Web pages

With `NYM_PUBLIC_PAYMENTS=true`, `serve` publishes a payment form at `/` on
the onion service. Visitors
request a fresh address, optionally with an amount, and get the address,
a QR code and a `bitcoin:` link at a private `/pay/...` URL. Pages use no
JavaScript or external resources and work in Tor Browser's Safest mode.
Resubmitting the form returns the same address.

Set the page's name and optional description in the dashboard or with
`profile "Corner Café" "Support the community garden."` (name up to 80
characters, description up to 280, plain text). Changes apply on the next
page load; `profile --clear` restores the default "Pay with Bitcoin".

`NYM_PUBLIC_PAYMENTS` defaults to `false`; only the exact value `true`
enables anonymous requests and new coin allocations. Disabling it later
leaves existing private `/pay/...` pages readable but prevents creation of
new addresses there. The token-protected integration API is unaffected.

Opting in accepts anonymous exhaustion risk: anyone can use up staging
addresses, trigger the receiving-wallet lookahead pause, exhaust Monero's
unused-subaddress allowance, or fill the durable 1,000 web-request quota.
Abandoned requests and addresses are not recycled. Rate limiting alone
cannot make irreversible anonymous allocation safe, including over Tor.
Use the authenticated API unless you deliberately accept this risk.

The operator dashboard listens on port 8089 (`NYM_ADMIN_PORT`; `0`
disables it). After setup it shows issuance status, Dojo checks, issued
addresses and confirmed payments, and lets you name the page, change
Dojo, resume a halted installation and see the integration API token.

## Limitations

Only five addresses may be allocated. The local compatibility test reserves
one of those addresses. This bounds testing but does not configure the
receiving wallet's lookahead.

No Auth47 login, PayNym profile caching,
automatic directory selection, customer-payment monitoring, funding-wallet
sweep command, or fee-bump command is included.

Funding uses one confirmed output of at most 1,000,000 sats.

## SegWit only

Tekiya uses SegWit forms throughout: the dispenser's payment code carries
the SegWit flag, merchant codes are stored in SegWit form (either form may
be pasted), customer, funding and change addresses are P2WPKH, and only
P2WPKH addresses are registered with the Dojo. An installation that stored
a legacy merchant code switches at startup and asks for the approval once
more, because its text names the code.

The one exception is set by BIP47 itself: the merchant's notification
address is P2PKH. The 546-sat notification output must go there for the
merchant wallet to see the connection, and the wallet signs the approval
with that address's key.

## Fees

The notification transaction has two outputs, 546 sats to the merchant's
notification address and the OP_RETURN payload, and is about 206 vB. The
dashboard asks for exactly enough to pay it at the chosen rate with no
change. Fee presets follow the Dojo's estimates but never go below 25
sat/vB; a custom rate has the same floor. Extra funding returns to the
dispenser's wallet as change; change under the dust limit is added to the
fee.

## Planned: dashboard redesign

- Choose mainnet or testnet4 at the start of setup instead of through
  `NYM_NETWORK`. Each network keeps separate state, so the choice belongs
  before the merchant wallet is connected.

Do not use the merchant payment code or dispenser code as a Bitcoin
payment address. Customer payments go to the derived destination address.

## State and backups

The database contains the plaintext dispenser seed, backend credentials,
API token, identity approval, and address-allocation history.

Stop all application processes before copying the full data directory.
Back up the onion identity separately (Compose: the `tor-data` volume).
Store backups securely.

Never run cloned copies of the same state. Never resume issuance from a
stale backup without recovery analysis: previously displayed unpaid
addresses cannot be reconstructed from chain history alone.

## Security

The merchant seed never enters this application.

A compromised application can substitute future payment destinations.
The merchant identity signature does not independently verify each address.

All implemented backend requests use an explicit Tor SOCKS proxy without
direct fallback. Container deployment also isolates application egress.
Manual host execution does not provide OS-level egress isolation.

Keep API credentials in the integrating application's backend, never in
browser JavaScript.
