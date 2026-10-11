# Tekiya

Standalone TypeScript BIP47 address-dispenser development build.

Not audited. Not wallet-interoperability tested. Start with testnet4.

## Quick start

With Docker:

    docker compose up -d --build

Open http://127.0.0.1:8089 on the same machine (from elsewhere, tunnel it:
`ssh -L 8089:127.0.0.1:8089 your-server`) and follow the setup. The
dashboard walks through every step:

1. Paste your merchant wallet's payment code (either form; it is stored
   in SegWit form). The onion address is detected automatically. Tekiya
   then claims the dispenser's PayNym with its SegWit payment code and
   follows your PayNym, in the background over Tor.
2. Paste the pairing of the Dojo your merchant wallet uses.
3. Send about 20,000 sats to the address shown. Funding is detected.
4. Create and broadcast the one-time notification transaction.
5. Pay a test address and check that your merchant wallet receives it.
6. Sign the approval text in your merchant wallet and paste the signature.

Without Docker: `npm ci && npm run build`, merge
`deploy/torrc.host.example` into your Tor configuration, then run
`npm start` (or install `deploy/nymdispenser.service`). The dashboard asks
for the onion address, which Tor writes to
`/var/lib/tor/nymdispenser/hostname`.

Your payment page is then live on the onion address. Name it in the
dashboard. Set `NYM_NETWORK=mainnet` only after testing on testnet4.

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

## Dashboard access

The dashboard never appears on the onion service. `NYM_ADMIN_AUTH` sets
who may reach it:

- `loopback` (default): `127.0.0.1` only, no password.
- `password`: HTTP basic auth with `NYM_ADMIN_PASSWORD` (12+ characters),
  for a private network. Set `NYM_ADMIN_HOST=0.0.0.0`.
- `proxy`: behind an authenticating reverse proxy, such as Umbrel's app
  proxy. Set `NYM_ADMIN_HOST=0.0.0.0`.
- `none`: no auth beyond the network; only behind a loopback-only
  forwarder, as in the bundled Compose file.

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

Before an address can be issued, it is registered with that Dojo through
a first `active=` lookup of its payment public key. Dojo then tracks it,
and a later `new=` declaration by the receiving wallet (as Ashigaru's
Resync Paynym sends) cannot suppress its history. Pairing registers the
first addresses immediately. `serve` keeps three addresses registered
ahead of the next allocation and rechecks every minute.

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

`serve` publishes a payment page at `/` on the onion service. Visitors
request a fresh address, optionally with an amount, and get the address,
a QR code and a `bitcoin:` link at a private `/pay/...` URL. Pages use no
JavaScript or external resources and work in Tor Browser's Safest mode.
Resubmitting the form returns the same address.

Set the page's name and optional description in the dashboard or with
`profile "Corner Café" "Support the community garden."` (name up to 80
characters, description up to 280, plain text). Changes apply on the next
page load; `profile --clear` restores the default "Pay with Bitcoin".

The page is unauthenticated: anyone can use up the staging addresses or
trigger the lookahead pause. No abuse protection is included yet.

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

Funding uses one confirmed output of at most 1,000,000 sats. The fee is
suggested from the Dojo's estimate and can be changed.

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
