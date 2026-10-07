# COD store contract — version 1

**Unapplied proposal, not a live shop.** Catalog-only inspection on October 7, 2026 confirmed that Supabase project `juxiaorwaiazfjlmkcvm` has no product/order/inventory tables. [store-database.sql](store-database.sql) creates the entire contract in one transaction, without seed products, prices, stock, user roles, payment accounts, or charges. It uses the existing stored-profile administrator helper; signup metadata never confers authority. Apply only after review and controlled verification against that exact project. Name collisions abort the transaction.

This contract is for medical supplies with **cash on delivery**. It does not sell appointments, dispense medication, issue prescriptions, charge online, capture funds, or assert that money has been paid. `completed` records administrative completion of an order, not a payment receipt. There is no shipping-price or delivery-promise model. `total_minor` is the sum of product lines; do not invent fees or guaranteed dates in the UI. No products should be fabricated to make an empty catalog look active.

## Currency and availability

Libyan dinars have **three decimal places**. `price_minor`, `unit_price_minor`, `line_total_minor`, and `total_minor` represent **1/1000 LYD**, not cents. Thus `12500` means `12.500 LYD`. Format display values by dividing by `1000`, with three decimal places. Server amounts use integer arithmetic; the maximal 20-line order is `198000000000` minor units, within JavaScript's safe-integer range. Clients must reject noninteger/non-LYD/malformed payloads instead of guessing conversions.

`rpc('nurse_store_contract_version') -> 1` is a read-only, anonymous/authenticated marker installed atomically with the full schema. Missing, failed, or other versions keep catalog writes, checkout, and order administration unavailable. It grants no authority and reads no rows. Authenticated sessions and their own stored profile role remain necessary for customer/admin operations.

## Product table

`store_products` projection:

| Field | Contract |
| --- | --- |
| `id` | UUID primary key, default generated; admin may supply a client UUID on INSERT for ambiguous-response recovery |
| `title` | Required trimmed length 2–160 |
| `description`, `category` | Nullable, maximum 2000 / 80 characters |
| `image_url` | Nullable, maximum 2000; HTTPS host URL without authority credentials or whitespace/HTML delimiters; no uploads/remote server fetching |
| `price_minor` | Required integer 1–100000000; LYD millidirham |
| `currency` | Server default/fixed `LYD`; read-only to clients |
| `stock_quantity` | Available, nonnegative integer ≤100000; reservations already deducted |
| `is_active` | Server default false; ordinary public reads see only true rows |
| `created_at`, `updated_at` | Server timestamps; read-only to clients |

Anonymous and authenticated clients can SELECT active products. Administrators additionally SELECT drafts and INSERT/UPDATE only the editable fields. No client DELETE is granted. INSERT grants `id,title,description,category,image_url,price_minor,stock_quantity,is_active`; UPDATE grants the same except `id`. Update with `id` plus the captured exact `updated_at` to prevent overwriting a newer edit, and require one returned row. The trigger stamps `updated_at` automatically, including checkout/restoration stock changes. After an ambiguous create, resolve the original UUID before submitting another.

The inventory trigger counts pending/confirmed reservations as part of the 100000-unit capacity. An administrator cannot set available stock to 100000 while outstanding reservations would cause a later cancellation to exceed that capacity. This constraint protects stock restoration; it does not substitute for a physical inventory process.

## Atomic checkout

Authenticated API:

```js
supabase.rpc('checkout_store_order', {
  p_order_id: frozenUuid,
  p_items: [
    { product_id: productUuid, quantity: 2, expected_unit_price_minor: 12500 }
  ],
  p_customer_name: fullName,
  p_phone: libyanPhone,
  p_city: city,
  p_address: deliveryAddress,
  p_notes: null
})
// data: [{ id, status, total_minor, currency, created_at }]
```

The UUID and intent must remain frozen until the attempt is resolved. The customer is always the current authenticated UID; no owner/status/currency/payment fields are accepted. There must be 1–20 unique product UUIDs, each quantity an integer 1–99. Numeric `expected_unit_price_minor` is mandatory and serves only as a comparison with the current server price. A changed price rejects the whole order for the customer to refresh and review. Other client price/title fields do not set stored prices or snapshots.

The server trims customer name/city/address/notes, validates name length 2–100, phone input ≤25, city 1–80, address 5–500, notes ≤1000, and rejects controls in names/cities. It normalizes Arabic/Persian digits and phone punctuation, accepting local `0` or international `+218`/`00218` plus nine national digits, storing `+218` format. It never records health details by default. The browser uses the existing 13 Libyan city options; the server accepts valid bounded city text rather than falsely declaring a delivery coverage guarantee.

The private implementation checks authentication, canonicalizes/sorts the intent, serializes the UUID, and checks an existing header before inspecting current catalog state. The same owner and canonical frozen intent returns the saved row, including a cancelled/completed row, without decrementing inventory again. A different owner or edited payload with that UUID fails. A retry can recover an already-saved order even after a product's price, availability, or stock changes. Never replace an unresolved UUID automatically or announce a new success merely because an existing terminal order was returned.

New orders lock products in UUID order, require active products, compare displayed prices, check stock, calculate authoritative integer totals, snapshot titles/prices/currency, and decrement available stock in one transaction. Any invalid line or late write failure rolls back the header, every item, and all stock changes. These exact private checked functions need privileged atomic writes because clients have no direct order/item or customer inventory-write grants; public wrappers remain `SECURITY INVOKER`, and anonymous execute is revoked.

## Orders, recovery, and privacy

`store_orders` customer/admin SELECT grants these fields only:

```
id,user_id,customer_name,phone,city,address,notes,status,total_minor,currency,
payment_method,created_at,updated_at,cancelled_at
```

RLS permits the captured owner or stored administrator. The internal canonical `request_payload` is not granted; `select('*')` is intentionally denied. Recover by the frozen `id` and captured `user_id`, with an explicit safe column list, then read matching `store_order_items`. Item projection is `order_id,product_id,title,quantity,unit_price_minor,currency,line_total_minor`; `line_total_minor` is generated integer multiplication. Item RLS checks the parent owner/admin, and `(order_id,product_id)` is unique. Customers cannot insert/edit/delete headers or lines through direct API calls. Administrators likewise cannot directly modify ownership, prices, snapshots, totals, or status.

Recovery must compare customer/contact/address and the item UUID/quantity/snapshot price against the frozen submission. It should display the saved status and clear an attempt only after a validated result. The browser must discard cart/attempt/order results on user changes; contact/address/order details must never cross account sessions. A lost response is an unresolved attempt until a matching owner row is found or retry returns a validated result.

## Administration and stock return

```js
supabase.rpc('transition_store_order', {
  p_order_id: orderUuid,
  p_expected_status: capturedStatus,
  p_new_status: 'confirmed' // or completed/cancelled
})
// data: [{ id, status, total_minor, currency, updated_at }]
```

Only the stored administrator can execute a transition successfully. The server locks the order and checks the exact expected status. Allowed transitions are `pending → confirmed/cancelled` and `confirmed → completed/cancelled`; `completed` and `cancelled` are terminal. A stale/replayed decision fails. Cancellation changes status and restores each product quantity under product locks in the same transaction, including deactivated products. It returns stock exactly once; if any restoration fails, the status and all stock changes roll back. There is no automatic payment collection or customer status-edit endpoint.

## Verification and remaining limits

`node tests/store-database-runtime.cjs` executes the unchanged proposal against PostgreSQL 17.5 through pinned PGlite with synthetic local auth/profile fixtures. It verifies grants/RLS, active-public/admin-draft visibility, admin CAS updates, URL/integer validation, 3-decimal authoritative prices, owner privacy, immutable UUID recovery, changed-price/stock rejection, invalid/duplicate carts, late transaction rollback, role checks, state transitions, one-time cancellation, late cancellation rollback, and restock capacity. It neither contacts Supabase nor reads production configuration/rows.

This single-session engine proves function/trigger execution and transactional rollback; it does not claim a simultaneous multi-connection checkout load test, SMTP activation, live merchant/product accuracy, payment processing, delivery operations, or live browser-to-PostgREST testing. PostgreSQL advisory and deterministic row locks provide the intended serialization; a production-like multi-session check remains a worthwhile deployment check. No proposed SQL has been applied by this backend task.
