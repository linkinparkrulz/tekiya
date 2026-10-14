# Tekiya integration API

For shop backends and other services that need a fresh payment address per
order. Tekiya hands out addresses that belong to the merchant's wallet and
reports what each one has received. Everything else (catalogue, prices,
exchange rates, carts, buyer details, fulfilment) belongs to the calling
application. Tekiya only ever stores a request id, an amount and an
address.

## Access

- **Base URL:** the payment service, port 8088 (`NYM_PORT`). Call it from
  the same host or private network, or through Tekiya's onion service over
  Tor. Never from browser JavaScript.
- **Authentication:** `Authorization: Bearer <token>` on every request. The
  token is in the dashboard under *Integration API* (or `npm run cli --
  token`). Keep it on the server.
- **Format:** JSON in and out. Amounts are integer atomic units (satoshis or piconero).

## Create a payment request

```http
POST /v1/payment-requests
Authorization: Bearer <token>
Idempotency-Key: order_1234567890abcdef
Content-Type: application/json

{ "amountSats": 5000 }
```

- `Idempotency-Key` (required): 16–128 characters of `A-Z a-z 0-9 _ -`.
  Use your order id. Repeating the call with the same key and amount
  returns the same request and address; the same key with a different
  amount is refused (`400 invalid_request`).
- `amountSats`: 0–100,000,000. `0` means any amount; it is still put in
  the `bitcoin:` URI only when non-zero.

For Monero (when enabled in the dashboard), send
`{ "asset": "XMR", "amountAtomic": 50000000000 }` (piconero; 1 XMR =
10¹² piconero). The response has the same shape with `asset: "XMR"`, a
`monero:` URI, `network` `mainnet` or `stagenet`, and
`confirmationsRequired: 10`. `asset` defaults to `BTC`.

Returns `200` with a [payment request](#payment-request).

## Read a payment request

```http
GET /v1/payment-requests/order_1234567890abcdef
Authorization: Bearer <token>
```

Returns `200` with a [payment request](#payment-request), or
`404 not_found`. A payment-page request can have both a Bitcoin and a
Monero address; add `?asset=XMR` or `?asset=BTC` to choose.

## Check whether new requests can be created

```http
GET /v1/status
Authorization: Bearer <token>
```

```json
{ "network": "testnet4", "ready": true, "issuing": false,
  "reason": "Issuance paused: the next address would be beyond the receiving wallet's lookahead until a payment confirms" }
```

It also has `assets.BTC` and `assets.XMR` (`enabled`, `issuing`,
`reason`) for each coin. Call it before showing a checkout, so buyers see "temporarily unavailable"
instead of an error at the last step. `ready` means setup and the
merchant's approval are complete; `issuing` means the next POST should
succeed according to local admission checks, not a guarantee of backend
availability. These checks are independent of `NYM_PUBLIC_PAYMENTS`, which
defaults to `false` and only controls anonymous web creation.

## Payment request

```json
{
  "id": "order_1234567890abcdef",
  "address": "tb1q…",
  "amountSats": 5000,
  "bitcoinUri": "bitcoin:tb1q…?amount=0.00005000",
  "network": "testnet4",
  "createdAt": "2026-10-11T12:00:00.000Z",
  "asset": "BTC",
  "amountAtomic": 5000,
  "uri": "bitcoin:tb1q…?amount=0.00005000",
  "received": { "confirmedSats": 5000, "unconfirmedSats": 0,
                "confirmedAtomic": 5000, "unconfirmedAtomic": 0 },
  "status": "paid",
  "firstConfirmedBlock": 154100,
  "checkedAt": "2026-10-11T12:21:04.000Z"
}
```

| `status` | Meaning |
| --- | --- |
| `pending` | Nothing received yet. |
| `seen` | Confirmed plus unconfirmed reaches the amount; not final. |
| `paid` | Confirmed amount reaches the amount (any confirmed payment when the amount is 0). For BTC this can mean only one confirmation, not final settlement. |
| `underpaid` | Something confirmed, but less than the amount. |

`received` totals everything sent to the address, including payments after
the first. `checkedAt` is when Tekiya last read the address from its Dojo
(`null` before the first check). Amounts and confirmations come from the
paired Dojo; treat them as that backend's view, not an SPV proof.
`checkedAt` is a freshness timestamp, not the time of payment or a guarantee
that the backend is current. Backend failures can leave it stale indefinitely.
Do not fulfil an order based on stale or missing checks.

## Polling

Tekiya attempts Dojo checks once a minute; successful checks usually lag by
about a minute, but outages can make status arbitrarily stale. Poll requests
every 30–60 seconds and check `checkedAt`. Continue monitoring after `paid`:
a reorganisation can reduce confirmed totals and move status back to
`seen`, `underpaid`, or `pending`. One BTC confirmation is not final.
Choose a risk-appropriate settlement and reorganisation policy in your
application; `paid` alone does not enforce a higher BTC confirmation target.
There are no webhooks.

## Errors

Errors return `{ "error": "<message>", "code": "<code>" }`.

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Malformed body or headers, idempotency conflict. |
| 401 | `unauthorized` | Missing or wrong bearer token. |
| 404 | `not_found` | Unknown request id or endpoint. |
| 503 | `unavailable` | Issuance is blocked: not set up or approved, halted, paused by lookahead, at the address limit, or a Monero wallet reservation needs reconciliation. `error` says which. |

A failed response, timeout, or lost connection does **not** prove that nothing
was allocated. In particular, a Monero RPC mutation may have created a
subaddress before its response or wallet save failed. Keep the original
idempotency key, asset, and amount; read that request and retry with the same
values, never a new key to bypass the failure. An ambiguous mutation leaves a
durable reservation that may require operator reconciliation before retries
can succeed. See the README recovery guidance; do not manually clear it.

## Limits to design around

- **Addresses are never reused.** An abandoned order still consumes its
  address. Expire orders in your application; Tekiya keeps the address.
- **Lookahead pause.** The merchant's wallet only watches a few addresses
  past the last one that received a confirmed payment (Ashigaru: 3). Tekiya
  stops issuing beyond that until a payment confirms, so several unpaid
  orders in a row pause new requests (`503 unavailable`).
- **Staging cap.** This development build issues at most 5 addresses per
  installation.
- **Amounts in atomic units.** Sats for Bitcoin, piconero for Monero.
  Convert fiat prices in your application and lock the quote for as long
  as you keep the order open.
- **Monero** confirms after 10 blocks (about 20 minutes) and pauses after
  150 unused subaddresses in a row.
