# Payment reservations rollout

## Deploy and activate

1. Deploy the CRM backend inventory guards before activating new transfer payments. All inventory/sales HTTP mutations now run in MongoDB transactions. MongoDB must be a replica set or sharded cluster. Standalone MongoDB is unsupported; there is no fallback.
2. Deploy POS backend and frontend with `POS_PAYMENT_RESERVATIONS_ENABLED=false`. Existing records keep their Bachs provider. Manual receipt confirmation defaults off at every location.
3. Build POS backend (`pnpm build`). Run `node dist/scripts/payment-reservations.js` against the intended environment for a preflight/dry-run. It reports unresolved records and MongoDB topology without printing credentials.
4. Set `CRM_RESERVATION_GUARDS_DEPLOYED=true` only after both stock-writing services are upgraded. Run `node dist/scripts/payment-reservations.js --apply` during a checkout maintenance window. The idempotent backfill reserves available stock for old unresolved transfers. Insufficient stock or changed prices are flagged; no stock is invented. Resolve or cancel flagged transfers and rerun until `ready:true`.
5. Enable `POS_PAYMENT_RESERVATIONS_ENABLED=true`. Provider discovery and new transfer creation require both this flag and the database readiness marker. Deploy all tills before reopening checkout: old cached/offline clients cannot promise shared availability. New cash/credit sales require server acknowledgement too.
6. Configure Bachs with its existing `BACHS_API_KEY` and `BACHS_WEBHOOK_SECRET`. Configure Squad using `SQUAD_SECRET_KEY`, `SQUAD_DVA_APPROVED=true`, and `SQUAD_CONTRACT_VERIFIED=true` only after Squad has profiled the merchant, provided a virtual-account pool, and confirmed the current contract and charges. Sandbox keys use `sandbox-api-d.squadco.com`; live keys use `api-d.squadco.com`. Do not enable live mode until UAT passes.
7. Configure Squad's callback to `POST /pos/webhooks/squad`. Existing Bachs callback stays `POST /pos/webhooks/bachs`. Enable manual confirmation per location in CRM POS → Tills (company administrators only).

## Contracts

- `GET /pos/payments/options`: available `{id,name}` providers and location manual-confirmation setting.
- `POST /pos/payments/transfers`: existing cart payload plus `provider: 'bachs'|'squad'`. The response includes provider-confirmed `cartTotalKobo`, `feeKobo`, `payableKobo`, reservation state and allowed actions. No account instructions are shown by the till until the cashier accepts the total.
- `POST /pos/payments/transfers/:clientSaleId/confirm-received`: no client-supplied amount or actor. Checks setting, originating cashier/location manager, unresolved state and held stock. Records confirmation source, actor, amount and time. Automatic confirmations share the same atomic completion path.
- `PATCH /hub/:id/pos-payment-settings` (CRM): `{manualConfirmationEnabled:boolean}`, restricted to `company_admin` with `manage_hubs` permission.
- Transfer listing includes expired/review/initializing payments. Managers see all location records and cancelled records with late-payment evidence; cashiers see their own. Stock is held until explicit cancellation or successful completion, not released on provider expiry.

## Stock and failure behavior

Reservations store batch quantities in the inventory's existing stock units. Product counters expose on-hand, reserved and available separately. The product write fence serializes reservations with POS and CRM mutations. Historical batch edits/deletes are blocked while the affected product has holds; use compensating inventory entries instead. Administrative bulk stock/log imports acquire fences and fail while any product has unresolved holds. Other batches and unreserved quantities remain sellable through normal operations.

Definite provider rejections release the hold. Timeout/unknown results remain visible in review; do not retry with a new sale reference. Cancel only after checking provider receipts. Late payment after cancellation never recreates a sale automatically; it is retained for manager reconciliation/refund. Manual confirmation asserts receipt of the full expected payment, not a claim that the provider independently verified it.

Squad DVA documentation available during implementation: https://squadinc.gitbook.io/virtual-accounts/reference/dynamic-virtual-account-v2 (deprecated; current docs returned 403). The implementation uses v2 initiation, pass-charge, expected-amount and signed-webhook contracts, and is deliberately gated for current merchant UAT. Poll responses without amount/currency cannot alone complete a payment. V2 signs selected reference/amount fields; webhook success is additionally checked against the provider query.

## Verification and monitoring

`pnpm build`, `node --test test/payment-reservations.cjs`, and `pnpm test --runInBand squad.client.spec.ts` exercises a real local replica set and an HTTP provider simulation. First run downloads MongoDB; set `MONGOMS_DOWNLOAD_DIR` to a writable cache. No live merchant credentials are used. Postman CLI was unavailable; the HTTP simulation exercises the real Squad fetch/serialization/timeout boundary directly.

In sandbox UAT, verify passed charges/expected amount, approved DVA pool access, callback signatures, duplicate callbacks, payment after cancellation, missing email fallback, and expired/mismatched payments (Squad may refund them). Confirm that insufficient payments never complete a sale. Keep flags disabled until these checks pass.

Monitor `pos_transfers` for `status` initializing/review/expired, `reservation_state:needs_review`, old holds, and `reconciliation_events`. Paid rows include `confirmation_source`, `confirmed_by`, `confirmed_at`, and `confirmed_amount_kobo`. Never release holds by deleting records or directly changing counters. Rollback can disable new providers, but must retain guards and confirmation/cancellation support until all outstanding holds are resolved.
