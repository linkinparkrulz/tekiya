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

## Commands

Run commands using npm run cli -- COMMAND.

- init MERCHANT_CODE ONION_ORIGIN
- info
- token
- directory
- pair PRIVATE_PAIRING_FILE
- prepare FUNDING_TXID VOUT FEE_SATS
- broadcast PREPARED_NOTIFICATION_TXID
- test-address
- statement
- approve SIGNATURE_FILE
- serve

## Limitations

Only five addresses may be allocated. The local compatibility test reserves
one of those addresses. This bounds testing but does not configure the
receiving wallet's lookahead.

No public donation frontend, Auth47 login, PayNym profile caching,
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
