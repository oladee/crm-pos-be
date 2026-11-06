# Payment provider audit trail

All production Moniepoint, Squad and historical Bachs HTTP requests and webhook
deliveries are recorded in MongoDB `pos_psp_audit`. This is enabled without a flag
or new credentials. It records new activity after deployment; it cannot recreate
historical HTTP messages that were never saved.

## Evidence retained

- Provider ID, account profile key, configured business/owner/terminal identifiers.
- Trusted location, originating till/cashier, checkout ID, payment-attempt ID,
  merchant reference and available provider transaction/request/delivery IDs.
- UTC recording time, exchange UUID, direction, operation, stage, HTTP method,
  endpoint without query parameters, status, elapsed milliseconds and structured
  transport error class. Application principal amounts are integer `amount_kobo`.
- Sanitized financial request/response/event payloads: amounts, currency, fees,
  references, status/success codes and payment method. Provider payload amounts
  retain the provider contract's original units (Moniepoint kobo; Squad request
  kobo and response amounts generally naira; Bachs amounts naira).
- SHA-256 and byte count of the original body, plus a checksum of the stored
  record before MongoDB adds `_id`. Hashes identify messages without retaining
  the original sensitive body. They are not proof of authenticity by themselves.
- Webhook verification result and handler outcome. `accepted` means the handler
  durably accepted the event; payment settlement/review remains determined by
  the payment inbox and checkout, not this audit label.

Payloads use a bounded financial-field allowlist. Authorization headers, API keys,
signature values, customer names/contact details, card/PAN/CVV/PIN data and arbitrary
free-form error text are excluded or redacted. Receiving account numbers retain
only the last four digits. Arbitrary headers and raw bodies are never stored.
Non-JSON and oversized sanitized payloads retain their hash/size and a format
marker instead of body content. Review this allowlist when provider contracts
change; newly introduced fields are omitted by default.

## Durability and recovery

Each outbound exchange appends `request_intent` with majority write concern before
HTTP. If that write fails, no request is sent. `http_response` or `transport_error`
is appended under the same exchange ID. Intent records prove intent, not delivery:
a process crash can leave an intent without a result. If response auditing fails,
the payment remains uncertain and its terminal lock remains held for reconciliation.
A subsequent status lookup has its own exchange ID and the same payment references.

Every webhook retry is retained separately, including rejected signatures and
ignored event types. Normal deliveries record `webhook_received` then
`webhook_result`. JSON parser failures and body-size rejections are recorded before
the error response; oversized transport bodies are not buffered and have no body
hash. Audit storage failure prevents successful acknowledgement, allowing provider
retries. A crash/storage outage between stages can leave an incomplete exchange.
Requests rejected by infrastructure before reaching this service require the
infrastructure's own access logs.

Audit inserts use the native collection independently of sale transactions, so
rolling back a sale does not erase its payment evidence. The application exposes
no update/delete operations, and the Mongoose model rejects ordinary mutations.
This is application-level append-only storage, not database-admin-proof or WORM
storage. Database operators must protect collection access, backups and restore
procedures; checksums do not replace those controls.

## Reading and retention

Authenticated assigned managers can read `GET /pos/payment-audit` for their active
location only. Optional `provider`, exact `reference` (merchant/provider/exchange)
and `before` cursor filters return up to 50 records plus `nextCursor`. Cashiers
cannot read the audit API. This does not grant payment-management permissions.

Webhook location attribution uses verified evidence and stored attempts/transfers
or configured terminals. Invalid and otherwise unscoped deliveries remain available
to authorized database operations staff; they are not exposed based on an
untrusted claimed location. The related payment inbox remains the manager review
queue for unexpected money.

There is **no TTL or automatic deletion**, as no retention period has been specified.
Monitor collection growth, restrict database privileges and include it in tested
backups. Agree a retention/export policy before introducing any purge job. This
audit trail supplies technical evidence; it does not certify regulatory compliance.
