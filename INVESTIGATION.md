# Tekiya: BIP47 Payment Discovery Investigation

Closed: 2026-09-26. The payment-discovery issue was resolved by identifying Ashigaru Resync Paynym's `new=` registration behavior from the wallet log. This report records the setup, diagnosis, and product implications.

## Executive Summary

NymDispenser derives BIP47 payment addresses controlled by a merchant wallet. Its separate wallet sends the initial notification, but customer payments go directly to merchant-controlled addresses.

The initial testnet4 notification and payment at index 0 worked according to the operator, including receipt and spending. A subsequent gap test left indices 1, 2, and 3 unpaid and paid index 4. Ashigaru did not display that payment, even after explicit PayNym resync. A later payment at index 1 appeared immediately, while still unconfirmed.

Ashigaru's own PayNym calculator subsequently produced the same index-1 and index-4 receiving addresses as NymDispenser. This substantially narrows the investigation away from destination derivation and toward discovery, synchronization, and backend history.

The investigation initially appeared to show a discrepancy in the merchant wallet's Dojo API:

- A transaction lookup returns the confirmed index-4 transaction and its correct output.
- A wallet lookup for that exact address returns zero balance, zero transaction history, and no unspent outputs.
- An independent explorer outspend check reports the output unspent at the time checked.

The wallet log later identified the cause: **Resync Paynym sent the BIP47 addresses using Dojo's `new=` parameter**, which explicitly tells Dojo to skip historical import. Addresses with pre-existing payments were consequently registered empty. Later `active=` requests did not restore their history because the addresses were already known. Dojo followed its documented behavior; this was a wallet-side resync bug.

The operator reports the issue has been fixed. General unattended dispensing still requires its separate issuance/lookahead and backend-registration safeguards; resolving this incident does not establish production readiness.

## Sharing and Evidence Boundaries

This report intentionally excludes API keys, access and refresh tokens, account xpubs, seeds, private keys, device identifiers, and the full wallet dump. Some credentials were posted during troubleshooting; they are not reproduced here.

The report omits payment codes, account public keys, credentials, device identifiers, and wallet dumps. Public test addresses and transaction identifiers are minimized because they link activity to this test wallet.

Evidence is distinguished as follows:

- **Operator report:** observations from the merchant wallet or commands executed by the operator.
- **Local inspection:** source inspection, read-only allocation/pairing queries, and local tests performed in the workspace.
- **API evidence:** transaction/address responses supplied by the operator or public explorer checks performed during investigation.
- **Source-based inference:** behavior inferred from inspected source, not a trace of the running wallet or backend.

Live observations are snapshots, not guarantees of current balances, confirmation counts, or service availability. No new live checks were performed solely to write this report.

## Intended Application

The project is a standalone TypeScript service intended for local Tor deployment, a VPS, or installation beside a Dojo. It aims to provide a small donation/address-allocation service without uploading the merchant's ordinary account xpub or requiring every visitor to send a BIP47 notification.

The intended flow is:

1. Create a separate dispenser wallet with BIP84 funding and a BIP47 identity.
2. Claim the dispenser's PayNym and follow the merchant in the directory.
3. Fund and locally sign one notification transaction to the merchant.
4. Let visitors request fresh merchant-controlled addresses from the established connection.
5. Have the merchant wallet discover and spend payments made directly to those addresses.

Directory claiming/following and the on-chain notification serve different purposes. Following publishes a social relationship; it does not by itself establish on-chain payment discovery.

Mainnet and testnet4 have separate application state. This investigation concerns **testnet4 only**. The configured backend determines the actual test chain; address prefixes alone do not distinguish testnet4 from older test networks.

## Implementation at Investigation Time

The application is version `0.3.0-dev`, located in the nested `nymdispenser/` application directory. It has:

- BIP47 derivation, BIP84 funding, notification construction/signing, and explicit broadcast commands.
- A SQLite allocator with idempotency keys and a five-address staging cap.
- A local compatibility-test command reserving index 0.
- A standalone gap-test diagnostic reserving indices 1 through 4.
- A standalone PayNym claim/follow utility.
- Merchant-signed approval and an authenticated allocation API.
- Tor transport and host/container deployment templates.

It does not yet have the requested public frontend or persistent automatic setup worker. The intended 1,000-sat total setup expenditure ceiling is not enforced by the core transaction builder; the actual notification below was prepared with a separate bounded helper.

Local baseline verification during the workspace handoff:

```text
npm run typecheck: passed
npm test: 8 passed, 0 failed
Node: v26.8.1
```

The tests cover sender/receiver derivation using the same BIP47 library, notification recovery, identity signatures, allocation bounds/idempotency, and URL validation. They do not prove live receiving-wallet scanning or Dojo historical import correctness.

## Setup History

Personal wallet addresses, payment codes, exact transaction identifiers, and onion hostnames are redacted from this public report. They are not necessary to understand or reproduce the `new=` versus `active=` behavior with fresh test data.

### Initial Build and Fixes

The first source was delivered as a generator and evolved into the TypeScript project. Two concrete setup bugs were corrected before this investigation:

- TypeScript declaration generation failed for the inferred `bitcoinjs-message` factory result. An explicit `ReturnType<typeof bitcoinMessageFactory>` annotation fixed compilation.
- The onion URL validator rejected backend query strings such as `?rawHex=1`. Backend requests were allowed to opt into query parameters while stored configuration URLs remained restricted. Regression tests were added.

The operator used host-level Tor on Manjaro. Initial onion setup succeeded after correcting an empty shell variable used for the onion hostname. Initialization created separate testnet4 state; no reinitialization was needed for those fixes.

### Funding and Notification

The merchant and dispenser payment codes are omitted from this shareable report.

| Item | Recorded value |
| --- | --- |
| Funding address | Testnet4 P2WPKH address (redacted) |
| Funding path | `m/84'/1'/0'/0/0` |
| Funding transaction | Confirmed testnet4 transaction (ID redacted) |
| Funding output | `vout 0`, 20,000 sats |
| Confirmation observations | Initially 0; subsequently reported as 156 |
| Notification transaction | Confirmed testnet4 transaction (ID redacted) |
| Merchant notification address | Testnet4 notification output (address redacted) |
| Notification output | 546 sats |
| Miner fee | 236 sats |
| Finalized notification size | 236 vB |
| Fee rate | 1 sat/vB |
| Total setup expenditure | 782 sats |
| Dispenser change | 19,218 sats |

The operator clarified that the budget was **1,000 sats for notification output plus miner fee**, not a 1,000-sat miner fee. The helper enforced that ceiling before saving the notification. The explicit broadcast returned `broadcastAcknowledged: true`; confirmation and connection recognition were subsequently reported.

The dispenser was claimed in the PayNym directory and followed the merchant. These directory actions did not replace or require another notification transaction.

### Index-0 Compatibility Test

The operator generated the persistent `setup_compatibility_test` allocation and later reported that everything worked as designed in response to instructions to verify automatic receipt and spending.

This is operator-reported success for index 0. The investigation does not contain a recorded index-0 spend transaction ID. A later wallet dump still listed index 0 in incoming-unspent metadata; without a fresh transaction trace, that metadata should not be used to reconstruct the earlier spend test.

## Allocation History

The following records were selected read-only from the local SQLite allocation table. No counter was reset or advanced by that inspection.

| Index | Request ID | Address | Test role |
| --- | --- | --- | --- |
| 0 | Compatibility test | Derived testnet4 address (redacted) | Initial successful compatibility test |
| 1 | Gap test | Derived testnet4 address (redacted) | Initially unpaid; later paid for diagnosis |
| 2 | Gap test | Derived testnet4 address (redacted) | Deliberately left unpaid |
| 3 | Gap test | Derived testnet4 address (redacted) | Deliberately left unpaid |
| 4 | Gap test | Derived testnet4 address (redacted) | Paid beyond the initial unpaid gap |

All five staging slots are reserved. Expired or unpaid allocations must not be recycled. The application limit was not increased during this investigation.

## Investigation Chronology

### 1. Gap Test Failed in the Wallet

After index 0 worked, the diagnostic deliberately reserved indices 1, 2, and 3 without payments and instructed paying only index 4.

The operator reported that index 4 was paid but absent from Ashigaru. The payment was independently checked against the saved allocation:

| Field | Value |
| --- | --- |
| Transaction | Confirmed testnet4 transaction (ID redacted) |
| Output | `0` |
| Address | Index-4 derived P2WPKH address (redacted) |
| Amount | 10,000,000,000 sats = **100 testnet4 BTC** |
| Block | `153823` |

The actual payment was much larger than the suggested 2,000-sat test amount. No mainnet value is implied.

The address matched the local index-4 allocation, and the transaction was confirmed. This ruled out the simplest explanations of an unconfirmed payment or a different destination from the recorded allocation.

### 2. Normal Lookahead and Explicit Resync Were Distinguished

The operator initially identified Ashigaru as v1.1.0. Official v1.1.0 source was inspected over Tor.

Relevant findings:

- `BIP47Meta.java` defines `INCOMING_LOOKAHEAD = 3`.
- `getIncomingLookAhead()` derives indices starting at the saved incoming index, up to but excluding that index plus three.
- `BIP47Util.getBip47Addresses()` also includes other known/unspent entries. The three-index range is the normal lookahead contribution, not a claim that the wallet never queries any other addresses.
- `PayNymUtil.kt` implements `synPayNym()`, starting incoming scanning at index 0 in batches of 20 and stopping when a batch reports no history.
- `PayNymDetailsActivity.kt` connects the menu item **Resync Paynym** to that broader scan.
- `APIFactory.syncBIP47Incoming()` processes the wallet response and can advance the incoming index when transaction history is returned.

The operator tried explicit PayNym resync; index 4 still did not appear. This meant normal lookahead alone was not a complete explanation: the inspected resync algorithm should include index 4 in its first batch.

### 3. Wallet Dump Added Context, Not a Diagnosis

The dump showed:

- The merchant payment code matched the configured receiving identity.
- The notification transaction ID was present in `incoming_notif_hashes`.
- Two dispenser entries existed, one named `+regularproduct95` and one unnamed.
- Both entries initially had `_in_idx: 0`, `out_idx: 0`, `out_status: -1`, and `in_utxo: [0]`.

The two dispenser codes ended in `B9jH4Dh` and `B7BgLP9`. Local decoding of these public codes established:

```json
{
  "samePublicKey": true,
  "sameChainCode": true,
  "differingPayloadBytes": [
    { "offset": 79, "first": 1, "second": 0 }
  ]
}
```

They encode the same derivation keys and differ only in the library's SegWit feature marker. That marker alone does not change the BIP47 payment public key. Whether separate metadata records under the two full strings affect resync or attribution remains untested.

`out_status: -1` refers to the merchant's outgoing notification state; the absence of an outgoing merchant-to-dispenser notification is not itself a receiving failure. Likewise, `wallet_scan_complete: true` is not proof that this connection was successfully scanned through index 4.

### 4. Index 1 Was Paid and Detected Immediately

Rather than allocate index 5, the operator paid the already-reserved index 1. This intentionally changed the initial gap experiment; indices 2 and 3 remained unpaid.

| Field | Value |
| --- | --- |
| Transaction | Testnet4 transaction (ID redacted) |
| Output | `1` |
| Address | Index-1 derived P2WPKH address (redacted) |
| Amount | 5,000 sats |
| Status at initial explorer check | Unconfirmed |
| Wallet behavior | Operator reported immediate pending-payment display |

Index 4 remained absent after an ordinary refresh.

A prior suggestion that recognition of index 1 might bring index 4 into ordinary lookahead was corrected. In the inspected `getIncomingLookAhead()` implementation, a saved incoming index of 1 contributes indices **1, 2, 3**, not 2, 3, 4.

### 5. Resync Still Did Not Advance the Incoming Index

The operator checked the dispenser's indexes, performed another explicit resync, checked again, and refreshed the balance.

Reported result:

```text
Incoming index before: 1
Outgoing index: 0
Incoming index after: 1
Index-4 payment visible: no
```

This does not prove every resync request succeeded. It establishes that the UI operation did not incorporate index 4 into the observed saved incoming index.

### 6. Ashigaru Independently Matched Both Destinations

`PayNymCalcActivity.java` was inspected. It calculates receive and send addresses locally for a selected payment code and index.

The operator used the merchant wallet's calculator with the dispenser identity and compared the **Receive Addresses**, native SegWit variants, for indices 1 and 4. The operator reported that they all matched the dispenser addresses listed above.

This is stronger interoperability evidence than the local tests that use the same BIP47 library on both sides. It establishes operator-observed destination agreement at the affected index, while keeping merchant keys inside the wallet.

No private-key export was requested or needed. Agreement means the wallet has the derivation material for the destination; actual recovery/spending of index 4 has not yet been demonstrated.

### 7. Merchant and Dispenser Endpoints Differed

A read-only query selected the dispenser's saved pairing record and compared its URL to the merchant pairing supplied by the operator. Credentials were not printed.

```json
{
  "network": "testnet4",
  "sameOrigin": false,
  "sameApiPath": true,
  "credentialsPrinted": false
}
```

The merchant endpoint used for diagnostics was:

```text
An HTTP v3 onion URL under `/test/v2/` (hostname redacted).
```

The merchant pairing advertised version `1.4.5`; this was not independently verified as the exact running source revision.

Different endpoints are not inherently wrong: the merchant and dispenser can use different Dojos. Different onion origins also do not prove different underlying infrastructure. The practical consequence is that a successful dispenser-backend query cannot substitute for testing the merchant's backend.

### 8. Merchant Dojo Returned Inconsistent Views

The operator has public pairing/API access through Dojo Bay, not administrative access to the node. The operator authenticated directly with curl over Tor, then executed two diagnostic requests against the merchant endpoint.

#### Transaction lookup

```http
GET /test/v2/tx/<redacted-txid>?rawHex=1
Authorization: Bearer <REDACTED>
```

Relevant returned fields:

```json
{
  "txid": "<redacted-txid>",
  "confirmations": 181,
  "block": {
    "height": 153823,
    "hash": "0000000000c25b830ee649e9feb2cc458e8a7fef669e1a227c816416125a46ba",
    "time": 1790257864
  },
  "outputs": [
    {
      "n": 0,
      "value": 10000000000,
      "scriptpubkey": "0014789b8660a8b2c34e4a6bd7efead82990afbcfeca",
      "type": "witness_v0_keyhash",
      "address": "<redacted-index-4-address>"
    }
  ]
}
```

This excerpt omits unrelated fields and the other output. The full operator response included transaction hex.

#### Address-history lookup

```http
POST /test/v2/wallet
Authorization: Bearer <REDACTED>
Content-Type: application/x-www-form-urlencoded

active=<redacted-index-4-address>
```

The relevant response was:

```json
{
  "wallet": { "final_balance": 0 },
  "addresses": [
    {
      "address": "<redacted-index-4-address>",
      "final_balance": 0,
      "n_tx": 0
    }
  ],
  "txs": [],
  "unspent_outputs": []
}
```

The response's `info.latest_block.height` was `154003`. This was not simply a backend reporting a chain tip before the payment's block.

#### Independent outspend check

The public explorer endpoint below returned `{"spent":false}` during the investigation:

```text
https://mempool.space/testnet4/api/tx/<redacted-txid>/outspend/0
```

That is explorer evidence, not an independently validated chain proof. Even if the output were later spent, complete address history should not describe this address as having no transactions.

## Lookup Side Effects and Source Limitations

### Follow-up: Merchant Dojo Bitcoin RPC Confirms the UTXO

The operator subsequently executed the documented request:

```http
GET /test/v2/txout/<redacted-txid>/0
Authorization: Bearer <REDACTED>
```

The merchant Dojo returned:

```json
{
  "bestblock": "0000000000ba3a6b8b6c2dabcefb15c0e6ddd9d08da0fc5ccbeab33afdc86e96",
  "confirmations": 234,
  "value": 100,
  "scriptPubKey": {
    "hex": "0014789b8660a8b2c34e4a6bd7efead82990afbcfeca",
    "address": "<redacted-index-4-address>",
    "type": "witness_v0_keyhash"
  },
  "coinbase": false
}
```

This endpoint is documented as querying Bitcoin RPC. Its `value` is in BTC: 100 testnet4 BTC equals the 10,000,000,000 sats in the original transaction. The discrepancy no longer depends only on a different explorer reporting the output unspent: the merchant Dojo's own RPC-backed endpoint reports it too. The earlier empty `/wallet` response and this response were captured at different times; a fresh wallet lookup remains useful.

The index-4 payment public key was then derived locally, without signing or broadcasting. Its P2WPKH address was checked against both the saved allocation and the paid address:

```text
<redacted-index-4-payment-public-key>
```

Only the derived public key and address were printed. The application database was opened read-only. The subsequent diagnostic used `POST /wallet` with `active` set to this public key, rather than to the address. Do not use `pubkey=<key>` as a rescan flag: the documented `pubkey` parameter declares a new entity and can skip historical import.

Documentation consulted:

- [Get txout](https://dojo-osp.org/api/get_txout/)
- [Get Wallet](https://dojo-osp.org/api/get_wallet/)
- [Add HD Account](https://dojo-osp.org/api/post_xpub/)
- [Delete HD Account](https://dojo-osp.org/api/delete_xpub/)

The documented XPUB `force` parameter overrides a locked derivation scheme during restore; it is not a documented generic loose-address history rebuild flag. No account deletion or XPUB restore was performed.

### Follow-up: Public-Key Lookup Also Omits the Payment

The operator executed:

```http
POST /test/v2/wallet
Authorization: Bearer <REDACTED>
Content-Type: application/x-www-form-urlencoded

active=<redacted-index-4-payment-public-key>
```

At reported chain height `154057`, the response contained:

```json
{
  "wallet": { "final_balance": 0 },
  "addresses": [
    {
      "address": "<redacted-legacy-variant>",
      "final_balance": 0,
      "n_tx": 0,
      "pubkey": "<redacted-index-4-payment-public-key>"
    },
    {
      "address": "<redacted-index-4-address>",
      "final_balance": 0,
      "n_tx": 0,
      "pubkey": "<redacted-index-4-payment-public-key>"
    },
    {
      "address": "<redacted-nested-segwit-variant>",
      "final_balance": 0,
      "n_tx": 0,
      "pubkey": "<redacted-index-4-payment-public-key>"
    }
  ],
  "txs": [],
  "unspent_outputs": []
}
```

Dojo accepted the public key and returned its three address variants, including the exact paid P2WPKH destination, but still reported no history. The discrepancy is therefore not resolved by switching from an address query to a public-key query. This reproduces the relevant BIP47 lookup form with one key, not the complete batched request or response handling of the running wallet.

### Import Behavior

Public Dojo `develop` source was inspected to understand `/wallet`; it was **not established to be the exact code deployed at the merchant endpoint**.

In the inspected implementation:

- `POST /wallet` accepts form-encoded `active` addresses and access-token authentication.
- A missing address can trigger a historical import attempt and database writes.
- An already-known address is not necessarily force-rescanned by repeating this request.
- Historical retrieval depends on the configured source/indexer. The inspected bitcoind path uses `scantxoutset`, which is not a full historical transaction scan.
- Import errors and backend configuration can affect completeness. A successful HTTP response is not proof of complete history.

Therefore the executed address lookup was **not guaranteed read-only with respect to the remote Dojo**. It may have registered/imported tracking state. Its response did not report the missing payment; whether it changed any remote records or led to later asynchronous work was not observed.

Both authenticated address-form and single-public-key-form lookups returned empty history. The subsequent wallet-log analysis supplied the missing request detail: resync sent BIP47 addresses using `new=`.

## Root Cause: Resync Registered Paid Addresses as New

Analysis of the operator's wallet debug log identified that Ashigaru's **Resync Paynym** submitted BIP47 receive addresses, reported as indices 0 through 39, in the `new=` parameter.

Dojo distinguishes:

- `active=<address>`: look up/register an address and import its existing history when it is first encountered.
- `new=<address>`: declare the address brand new and skip historical import.

Once an address has been registered without history, a later `active=` lookup treats it as already known; it does not necessarily trigger the missed historical import. Therefore, a payment made before the first registration can remain invisible. Normal sync's lookahead used `active=`, which explains why indices 0 and 1 were watched and detected, while the already-paid index 4 was missed when resync first registered it using `new=`.

The operator-supplied log timeline was reported as follows (local times; log timestamps UTC):

| Local time | Event |
| --- | --- |
| 12:57-13:03 | Wallet restored from seed and paired to a Dojo; log does not establish which endpoint |
| 13:08:45 | Resync Paynym |
| 13:12:40 | Sync all payment codes |
| 13:13:08 | Resync Paynym again |
| 13:20:53 | Index-4 `active=` curl lookup; address had already been registered empty by resync |
| 13:34 | A control address's first `active=` lookup imported its history correctly |

The earlier Dojo's resyncs, performed after index 4 was paid, used the same behavior. This explains the observations on both Dojos without requiring a Dojo defect. The log analysis also suggested the index-1 payment may have become invisible after resync; that side effect was not separately confirmed in the captured investigation.

### Build and Security Notes

- The wallet log identifies a staging build, package `com.ashigaru.wallet.staging`, build 202, reporting version name `1.2.0`. The earlier v1.1.0 source inspection was a working assumption and may not exactly represent that build.
- The merchant Dojo reportedly identified itself as version 1.29.1 in response headers.
- The staging build reportedly logs Dojo API keys, access/refresh tokens, and account tpubs in plaintext. Keep the log private and report the issue to Ashigaru; do not share raw logs publicly.
- The log also records a separate pairing-screen crash at 13:02: `StringIndexOutOfBoundsException` in `DojoUtil.setDojoParamsOfflineMode`. This is outside the payment-discovery root cause.

## Findings and Open Hypotheses

### Established by the Available Evidence

1. Index 4 was paid at the address recorded in the dispenser database.
2. The merchant Dojo's transaction endpoint knows the confirmed payment and correct output.
3. Its address-history endpoint returned no history or UTXOs for that address in the captured response.
4. Ashigaru independently calculated the same receiving addresses at indices 1 and 4, according to the operator.
5. Index 1 was discovered immediately in the mempool; index 4 was not displayed after the reported refresh/resync attempts.
6. The observed incoming index remained 1 after resync.
7. Merchant and dispenser configuration point to different onion origins.
8. The merchant Dojo's RPC-backed `/txout` endpoint returned the unspent index-4 output with 234 confirmations.
9. A single-payment-public-key `/wallet` lookup returned the correct address variants but no payment history at chain height 154057.
10. The wallet log shows Resync Paynym registering BIP47 receive addresses through `new=`, suppressing historical import for addresses that may already have payments.
11. This mechanism explains the empty history observations without a Dojo defect: normal sync used `active=` before payments, whereas resync used `new=` after the index-4 payment.

### Resolved

- The apparent Dojo history failure followed from Ashigaru Resync Paynym using `new=` for BIP47 addresses that could already have payment history.
- Indices 0 and 1 were discovered because ordinary lookahead registered them with `active=` before payment; index 4 was registered with `new=` after it was paid.
- Later `active=` lookups did not recover history for addresses already registered empty.

### Not Established

- Whether the two onion endpoints share infrastructure.
- Successful index-4 recovery or spending after the reported fix.
- Whether the index-1 payment became invisible after resync, as suggested by the log analysis.
- Unattended safe issuance across larger unpaid gaps.
- Mainnet readiness or general Ashigaru compatibility across releases/backends.

## Corrections Made During Troubleshooting

- The 1,000-sat setup budget includes notification value and miner fee, not miner fee alone.
- Index-0 success does not prove arbitrary unpaid-gap discovery.
- Normal refresh and explicit PayNym resync are different code paths.
- Advancing the saved incoming index to 1 does not, in the inspected normal-lookahead loop, include index 4.
- Feature-code variants share key material; their presence alone is not proof of a derivation bug.
- The merchant and dispenser were not configured with the same onion endpoint.
- The direct address lookup may mutate remote tracking state and does not reproduce every aspect of Ashigaru's public-key scan.
- A successful raw-transaction lookup does not establish complete address history in the wallet API.
- The index-4 `active=` curl request was not the first registration: Resync Paynym had already registered that address using `new=`.
- Dojo behaved according to its documented `new=`/`active=` semantics; the log identified the wallet-side misuse.
- The running wallet was a staging build, not verified v1.1.0; source-version assumptions were not proof of its runtime implementation.
- The staging log contains plaintext secrets and must remain private.

## Recommended Next Actions

### Wallet Fix and Recovery

The operator reports the issue has been fixed. Report the `new=` resync behavior to Ashigaru with a sanitized log excerpt. Do not include the raw staging log: it reportedly contains Dojo API keys, access/refresh tokens, and account tpubs.

The reported recovery paths for addresses already registered empty are:

- On a Dojo the operator administers, use its supported maintenance/rescan procedure to rebuild the affected address history.
- On a fresh Dojo, pre-register the known BIP47 receive addresses with `active=` before pairing/restoring the wallet. Then pair, restore, and run Resync Paynym.

This report does not independently verify post-fix recovery of indices 1 and 4. Repeating `active=` on a hosted Dojo should not be assumed to repair addresses already registered empty.

### Optional Reproduction

A proposed testnet-only reproduction uses the dispenser notification's change output, which is not a merchant payment address:

| Field | Value |
| --- | --- |
| Notification transaction | Testnet4 transaction (ID redacted) |
| Change output | `vout 2`, 19,218 sats |
| Change address | Dispenser change address (redacted) |

The reproduction registers this address with `new=` and then queries it using `active=`; both are expected to show no history. A genuine first `active=` lookup of an unused-before address that has history is expected to import it. This changes tracking state on the merchant Dojo and links the dispenser change address to those queries; it was proposed as a testnet diagnostic, not performed as part of this investigation.

### Remaining Validation

1. Record post-fix visibility and spendability for the existing index-1 and index-4 payments.
2. Preserve the five-address staging cap until receiver discovery across the intended issuance range is demonstrated.
3. Keep mainnet and unattended issuance gated on recovery, gap, and backend-registration tests.

Do not reset allocation history, recycle unpaid addresses, delete either PayNym entry, or resend the notification as an attempted fix.

## Product Implications

The current evidence does not justify changing BIP47 destination derivation. It does show that cryptographic correctness alone is insufficient for a reliable public address dispenser.

- Receiver scan coverage must be explicit and tested; a server-side allocation counter does not advance the receiving wallet's counter.
- Reliable historical discovery must be tested separately from mempool detection of already-tracked addresses.
- Registering addresses with a Dojo does not automatically make a wallet include them in its requested address set or display them.
- A fixed issuance cap can bound risk but does not solve abandoned-request exhaustion.
- A larger resync batch still has a stopping rule; it is not unlimited recovery coverage.
- Backend response completeness and importer health need diagnostics before automation is considered production-ready.
- Future workflow status should distinguish unconfirmed payments, unavailable backend checks, incomplete address history, and merchant verification.
- At allocation time, the dispenser should register each derived BIP47 address with the merchant's Dojo via `active=` before returning it, so the backend is watching before a payment arrives. This requires a merchant-Dojo pairing credential on the dispenser; it grants tracking access, not spending authority, and must be protected.
- This registration links dispenser address-allocation activity to the merchant's Dojo, a privacy and credential tradeoff to disclose during setup.

Keep the five-address staging cap and existing allocation history intact until a receiver-compatible policy is established. Mainnet deployment and unattended public issuance remain gated on additional verification.

## Sources and Reproduction References

### Local Application Files

- `src/bitcoin.ts`: wallet creation, BIP47 derivation, notification construction, signed identity statement.
- `src/store.ts`: transactional allocation and five-address bound.
- `src/gap-test.ts`: reserved diagnostic sequence and retry checks.
- `src/cli.ts`: saved pairing retrieval and setup commands.
- `src/tor.ts`: Tor transport, Dojo login, authenticated requests.
- `src/claim-paynym.ts`: claim/follow utility.
- `test/core.test.ts` and `test/onion-url.test.ts`: baseline automated tests.

The code was not modified to fix this discovery issue during the investigation. Normal test/build commands regenerated compiled artifacts. Local allocation and pairing inspections used read-only database access; authenticated merchant-backend diagnostics were executed by the operator.

### Ashigaru v1.1.0 Source (Tor Required)

- [BIP47Meta.java](http://ashicodepbnpvslzsl2bz7l2pwrjvajgumgac423pp3y2deprbnzz7id.onion/Ashigaru/Ashigaru-Mobile/src/tag/v1.1.0/app/src/main/java/com/samourai/wallet/bip47/BIP47Meta.java)
- [BIP47Util.java](http://ashicodepbnpvslzsl2bz7l2pwrjvajgumgac423pp3y2deprbnzz7id.onion/Ashigaru/Ashigaru-Mobile/src/tag/v1.1.0/app/src/main/java/com/samourai/wallet/bip47/BIP47Util.java)
- [PayNymUtil.kt](http://ashicodepbnpvslzsl2bz7l2pwrjvajgumgac423pp3y2deprbnzz7id.onion/Ashigaru/Ashigaru-Mobile/src/tag/v1.1.0/app/src/main/java/com/samourai/wallet/util/func/PayNymUtil.kt)
- [APIFactory.java](http://ashicodepbnpvslzsl2bz7l2pwrjvajgumgac423pp3y2deprbnzz7id.onion/Ashigaru/Ashigaru-Mobile/src/tag/v1.1.0/app/src/main/java/com/samourai/wallet/api/APIFactory.java)
- [PayNymDetailsActivity.kt](http://ashicodepbnpvslzsl2bz7l2pwrjvajgumgac423pp3y2deprbnzz7id.onion/Ashigaru/Ashigaru-Mobile/src/tag/v1.1.0/app/src/main/java/com/samourai/wallet/paynym/paynymDetails/PayNymDetailsActivity.kt)
- [PayNymCalcActivity.java](http://ashicodepbnpvslzsl2bz7l2pwrjvajgumgac423pp3y2deprbnzz7id.onion/Ashigaru/Ashigaru-Mobile/src/tag/v1.1.0/app/src/main/java/com/samourai/wallet/PayNymCalcActivity.java)

These references support source-based reasoning under the stated version assumption, not proof of runtime behavior.

### Dojo Reference Source

- [Wallet endpoint documentation](https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/develop/doc/GET_wallet.md)
- [Wallet REST API](https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/develop/accounts/wallet-rest-api.js)
- [Wallet address handling](https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/develop/lib/wallet/wallet-info.js)
- [Remote importer](https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/develop/lib/remote-importer/remote-importer.js)
- [Bitcoind import wrapper](https://github.com/Dojo-Open-Source-Project/samourai-dojo/blob/develop/lib/remote-importer/bitcoind-wrapper.js)

These are moving `develop` references, not pinned evidence of the merchant node's deployed implementation. The [Dojo API documentation](https://dojo-osp.org/api/get_wallet/) describes the `new=` versus `active=` distinction used in the root-cause analysis.

### Public Transactions

- Funding, notification, and payment transactions were testnet4 transactions; identifiers are redacted from this public report.

## Status at Handoff

**Investigation closed:** the operator reports the issue is fixed. The supplied wallet log identified Resync Paynym registering already-used BIP47 addresses with Dojo's `new=` parameter, which skips historical import. No Dojo defect was established.

**Still to validate:** recovery and spending of indices 1 and 4 after the fix, plus receiver scan coverage, address pre-registration, and unattended issuance behavior before any production expansion.

**Scope:** this root-cause conclusion is based on the operator-supplied log analysis and testnet4 observations. The running app was a staging build; raw logs contain secrets and must remain private.
