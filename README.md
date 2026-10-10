# Tekiya

Standalone TypeScript BIP47 address-dispenser development build.

Not audited. Not wallet-interoperability tested. Start with testnet4.

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
Resync Paynym sends) cannot suppress its history. `pair` registers the
first addresses immediately. `serve` keeps three addresses registered
ahead of the next allocation and rechecks every minute.

The same lookups record confirmed payments. An address is issued only
while it is within three indices of the last confirmed payment, matching
the receiving wallet's lookahead. Past that, the API returns 503 until a
payment confirms. Unpaid addresses are never recycled.

History on an address that was never issued indicates a cloned
installation or a stale backup. Issuance then halts until the cause is
investigated and `resume-issuance --recovery-reviewed` is run.

Running `pair` again replaces the pairing and re-registers every address
with the new Dojo. Re-pair Tekiya first, and move the merchant wallet only
after a successful sync, so the new Dojo imports existing payments before
the wallet can declare those addresses new.

Registration links address issuance to the paired Dojo's operator.

## Commands

Run commands using npm run cli -- COMMAND.

- init MERCHANT_CODE ONION_ORIGIN
- info
- token
- directory
- pair PRIVATE_PAIRING_FILE
- sync
- status
- resume-issuance --recovery-reviewed
- prepare FUNDING_TXID VOUT FEE_SATS
- broadcast PREPARED_NOTIFICATION_TXID
- test-address
- statement
- approve SIGNATURE_FILE
- serve

## Web pages

`serve` publishes a payment page at `/` on the onion service. Visitors
request a fresh address, optionally with an amount, and get the address,
a QR code and a `bitcoin:` link at a private `/pay/...` URL. Pages use no
JavaScript or external resources and work in Tor Browser's Safest mode.
Resubmitting the form returns the same address.

The page is unauthenticated: anyone can use up the staging addresses or
trigger the lookahead pause. No abuse protection is included yet.

A read-only operator dashboard listens on `127.0.0.1:8089` (set
`NYM_ADMIN_PORT`; `0` disables it). It shows setup progress, issuance
status, Dojo sync results, issued addresses and confirmed payments. It is
never published on the onion service. In the container deployment it is
reachable only inside the app container; use `status` there instead.

## Limitations

Only five addresses may be allocated. The local compatibility test reserves
one of those addresses. This bounds testing but does not configure the
receiving wallet's lookahead.

No Auth47 login, PayNym profile caching,
automatic directory selection, customer-payment monitoring, funding-wallet
sweep command, or fee-bump command is included.

Funding uses one explicitly identified output. Fees are entered manually.

Do not use the merchant payment code or dispenser code as a Bitcoin
payment address. Customer payments go to the derived destination address.

## State and backups

The database contains the plaintext dispenser seed, backend credentials,
API token, identity approval, and address-allocation history.

Stop all application processes before copying the full data directory.
Back up the onion identity separately. Store backups securely.

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
