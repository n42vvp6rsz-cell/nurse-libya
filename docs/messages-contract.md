# Private messages — October 7, 2026

## Verified existing backend

Read-only PostgreSQL catalog inspection of project `juxiaorwaiazfjlmkcvm` found `public.messages`, with no `conversations` or participant table and no existing messaging RPC. Its columns are generated UUID primary key `id`, required profile UUID foreign keys `sender_id` and `receiver_id` (cascade on profile deletion), required `body` (database length check 1–5000 characters), required `is_read` default false and required `created_at` default now.

RLS is enabled. The existing authenticated SELECT policy restricts rows to the sender or receiver. INSERT requires the current sender and a different receiver, but accepts any target profile. The existing receiver UPDATE policy checks only receiver ownership; its whole-table UPDATE grant permits changing the sender, body, ID and timestamp. No guard trigger was present. Both client roles held whole-table grants. The old write contract must therefore never be used by the new interface.

No message/profile/contact rows were read to perform this audit. No actual users were created or messaged, and no production change was performed by the messaging module work.

## Interface and authorization

`messages.js` registers authenticated route `#messages`. It builds its interface inside the `#messages` section and uses the existing `window.NurseApp` session, route and notification contract. It never queries a private profiles directory or accepts arbitrary profile IDs from an input field.

The inbox derives conversation pairs from the latest 200 messages returned for the current authenticated participant. Opening a thread reads its latest 200 messages and displays them chronologically. Both queries explicitly filter the current participant and returned rows are checked again before rendering. The interface states that older messages may exist; the visible unread count describes the displayed rows. Replies refresh manually rather than implying a realtime connection.

New conversation choices come only from verified public doctor, nurse and hospital directory records with a valid linked profile UUID. The fields fetched are the public name, city, linked profile UUID and verification marker; patient profile/contact details are never requested. A `#messages?provider=<UUID>` link is checked against that fetched directory. Existing conversations can be opened from the participant's inbox. Every text value uses DOM `textContent`.

The server, rather than that selector, decides whether a new send is authorized. It permits:

- An authenticated sender contacting a verified public doctor, nurse or hospital whose stored profile role matches its directory type.
- The exact user/provider pair already linked by an immutable `bookings.user_id` and `bookings.provider_profile_id` record.
- A verified public provider replying to an inbound message from its recipient that was written through the new guarded server contract.

An old arbitrary patient-to-patient message does not grant permission to continue sending. The old receiver-wide UPDATE also made legacy inbound identity untrustworthy, so old message rows cannot authorize provider replies by themselves. A new server-written `sent_via_private_contract` flag defaults false on all legacy rows and is true only on newly guarded sends. Clients cannot forge that flag. Legacy histories remain readable; an old legitimate provider conversation can resume once the patient sends through the guarded contract or an exact booking pair exists. Mutable `service_requests` fields, client-supplied booking IDs and user metadata do not confer conversation access. The RPC accepts no sender ID; it captures `auth.uid()` itself. A patient cannot discover or start contact with another patient through this interface.

## Proposed server contract

`docs/messages-database-fixes.sql` is a separate transaction which requires the base `nurse_app_contract_version() = 1` repair to be installed first. It preserves all existing rows, revokes PUBLIC/anon table privileges and authenticated raw write privileges, grants participant SELECT only, and replaces the unsafe INSERT/UPDATE policies. Authenticated clients cannot mutate existing message content or identities through the Data API.

The public entry points are SECURITY INVOKER wrappers around bounded, explicitly authorized functions in the non-exposed `private` schema. Those internal write functions require a current authenticated UID, use an empty search path and fully qualified relations, and have no PUBLIC/anon execution grant. The private provider lookup exposes no contact or private profile data. Authenticated clients cannot call that lookup directly. Only the guarded operations write message rows; privileged service administration and profile-deletion cascades retain their existing backend semantics.

| RPC | Parameters | Result |
| --- | --- | --- |
| `nurse_messages_contract_version` | None | Integer `1` after the full messaging transaction commits |
| `send_private_message` | `p_message_id uuid`, `p_receiver_id uuid`, `p_body text` | Exactly one complete message row |
| `mark_private_message_read` | `p_message_id uuid` | Exactly one complete message row with `is_read=true` |

The send operation validates its text (nonblank, up to 5000 characters, no disallowed control or bidirectional override characters), checks the permitted relationship and inserts with server-captured sender and unread state. A repeated UUID with the exact original sender, receiver and body returns the original row. Changed content, another participant's UUID or an unauthorized new target fails without confirming or duplicating a message. The database-generated timestamp is retained.

Read marking can only set `is_read=true` on the current receiver's row. It cannot alter content, identity, timestamp or reverse an existing read state. The interface labels only sent/read states present in those returned columns; it does not claim delivery notifications or read timestamps that do not exist.

## Recovery and privacy behavior

The interface keeps one in-flight send per account/conversation. A new attempt captures a generated UUID, target and normalized text before calling the server. Until the returned row matches all those values, the original attempt remains frozen and its verification/retry button reuses the same UUID and text. A lost response can therefore be checked without a duplicate insert. Empty or mismatched responses cannot show success. This recovery state lives only in the current page; private text is not saved to local storage. Reloading reads the server's history rather than retaining a private draft locally.

Every load, capability check, send and read response is bound to the captured account/version. Account changes clear private rows, text, selected recipient, pending attempts, capability state and locks; late responses cannot render another account's conversation or success notification. Thread and inbox versions also prevent an old response from replacing a newer conversation or refresh.

When the messaging version marker is absent or differs from `1`, the existing participant inbox/thread remains readable but sending and read marking stay disabled, including programmatic submissions. The interface explains the missing activation and never falls back to the unsafe raw writes. Directory/read failures expose retry or refresh controls and no fabricated messages or recipients.

## Validation scope

The module has isolated mock tests for private routing, missing contract denial, approved directory selection, unknown contact denial, deep link checking, text bounds, markup rendering, exact response confirmation, duplicate-flight suppression, frozen UUID retries after a lost response, receiver-only read calls and account/thread/refresh races. These exercise UI boundaries and synthetic rows only.

`node tests/messages-database-runtime.cjs` passed **20 scenarios** on pinned `@electric-sql/pglite@0.3.16` / PostgreSQL **17.5**, using the current metadata-derived base database fixture and its repaired base contract. It reproduces the old arbitrary-target INSERT and forged-sender UPDATE, then verifies actual RLS, raw write revocation, approved recipient and guarded reply authorization, rejection of forged legacy reply authority, exact booking pair access, server UID binding, UUID idempotency and mismatches, bounded body validation, receiver-only content-immutable read marking, migration reapplication and prerequisite transaction rollback. Its offline database uses synthetic records and does not contact the production project.

This matches the production PostgreSQL major version, not Supabase's exact 17.6.1.166 patch/extension environment. PGlite provides one database session; these checks do not simulate concurrent connections, PostgREST/JWT handling or actual Supabase authentication. Production activation and its metadata read-back belong to the main project handoff; passing offline tests alone does not establish successful live authentication or message delivery.
