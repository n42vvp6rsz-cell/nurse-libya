# Database repair runtime verification

Verified on October 7, 2026 by running `node tests/database-runtime.cjs`.
**44 scenarios passed** in an isolated, in-memory PostgreSQL database. This is
execution of the complete SQL transaction, RLS policies, trigger functions, and
RPCs, rather than a parser or JavaScript mock of their behavior. The prepared
repair in `docs/proposed-database-fixes.sql` now includes the narrow linked-request
authority guard described below. It has not been applied to Supabase.

## Engine and fixture

Pinned engine: `@electric-sql/pglite@0.3.16`. `SELECT version()` returned:

```text
PostgreSQL 17.5 on aarch64-unknown-linux-gnu, compiled by emcc
(Emscripten gcc/clang-like replacement + linker emulating GNU ld)
3.1.74 (1092ec30a3fb1d46b1782ff1b4db5094d3d06ae5), 32-bit
```

The target Supabase project is `juxiaorwaiazfjlmkcvm`, reported as PostgreSQL
17.6.1.166. The test matches PostgreSQL's major version; it does not establish
equivalence with that Supabase patch level or its extensions. The initially
installed PGlite 0.5.8 uses PostgreSQL 18.3 and was replaced before these results.

The fixture was generated from **read-only catalog metadata** of the current
project: 12 relevant tables, their complete columns/defaults/nullability, 41
constraints, 43 policies including the restrictive application INSERT policy,
existing RLS enablement, broad table grants, the exact profile-role and booking
link triggers, and their function definitions. The existing recursion-safe
private administrator helper and original provider approval function are copied
from `pg_get_functiondef`. The snapshot is embedded in the runtime test so future
test execution requires no production connection.

All records are synthetic. UUIDs are deterministic fixture values and display
names begin with “Synthetic”. Roles `anon` and `authenticated` are ordinary local
roles, so their queries are subject to RLS. Local `auth.uid()` adapts a synthetic
`request.jwt.claim.sub` setting. The fixture contains a minimal `auth.users(id)`
table. Pre-existing provider/admin roles are seeded only in the local fixture
with the role trigger temporarily disabled and then restored. This is not an
administrator activation procedure for a real account.

No production user/patient rows, real signups, emails, messages, bookings,
enrollments, role changes, or migrations were read or executed. The test contains
no network requests, API keys, environment secrets, or Supabase clients.

## Results

| Area | Observed result |
| --- | --- |
| Baseline defects | Original approval marks an application approved while the other user's profile remains patient; an active draft course is public; a provider owner can claim `verified=true`; a requester can change a linked request status independently of its booking. All four reproduce before the repair. |
| Whole transaction | Complete SQL applies successfully; authenticated callers receive contract version 1; anonymous access to the marker rejects. Reapplication creates no duplicate provider trigger or admin-read policy. |
| Failed migration | Removing an expected fixture policy makes the migration fail. Transaction rollback removes all earlier added policies/triggers and leaves the version marker absent. |
| Stored roles | Ordinary profile INSERT forces patient and ordinary UPDATE cannot promote to admin. |
| Application review | Only an admin may review. Pending approval saves the intended profile role and reviewer metadata. Replays reject; government approval rejects atomically; government rejection succeeds; existing administrators are not demoted. Restrictive INSERT rejects self-approved/forged reviewer data. An artificial promotion-suppression trigger causes the decision to roll back. |
| Provider verification | All five provider table families force ordinary INSERT verification false, suppress self-verification, allow admin verification, and withdraw verification on owner content changes. Unverified records are hidden publicly. Patients cannot create doctor content; another user cannot update a doctor's record. |
| Course publication | Active legacy drafts/rejected courses are hidden publicly. Ordinary INSERT cannot approve/activate. Admin review publishes. Owner content edits restore pending/closed and clear publication/review metadata. Owners may withdraw an approved course but cannot reactivate it. |
| Enrollment | Free requests stay pending/free; active or paid claims reject. Paid requests stay pending/unpaid; false free claims and enrollment into a rejected course reject. Other users cannot read an owner's enrollment. No payment or acceptance is asserted. |
| Booking creation/privacy | Existing booking trigger creates its linked request atomically. Another user cannot read the booking. Admin may read it after the repair. Nonpending INSERT and direct client booking UPDATE are denied. |
| Booking review | Admin confirmation maps pending to confirmed/accepted, then completion updates both records. Arabic pending cancellation also updates both records. Nonadmin, anonymous, invalid/stale/terminal reviews reject. Missing links, mismatched requester/provider, and terminal request states reject without changing either row. |
| Atomic failure | An artificial booking UPDATE trigger fails after the request UPDATE; the request UPDATE is rolled back with the booking statement. |
| Linked participant writes | Requester UPDATE cannot change linked identity, assignment, status, or creation time. An assigned provider cannot bypass link detection even though bookings RLS hides the booking. Nonauthority notes/address edits remain available. Stored-admin atomic review and trusted no-JWT maintenance remain available. A no-JWT client rejects even with artificial permissive policies exposing the row. |
| Unlinked legacy requests | The existing unlinked participant status/assignment behavior remains available. This is compatibility evidence, not a security guarantee for a future unrestricted request editor. |

## Linked-request authority repair and remaining scope

The existing `service requests requester cancel` policy is a general participant
UPDATE policy. It allows the requester, assigned provider, or administrator to
UPDATE a request, and its `WITH CHECK` repeats that participant condition. It
does not limit editable columns or legal transitions. The runtime fixture first
reproduces a direct requester `status='completed'` write causing divergence from
the linked booking. The prepared repair now adds a narrow BEFORE UPDATE trigger
for requests linked to a booking. It blocks non-admin changes to `id`,
`requester_id`, `service_id`, `assigned_provider_id`, `status`, and `created_at`.
Unlinked requests and nonauthority fields remain under their existing policies.

The trigger is private SECURITY DEFINER solely to detect a booking link even when
the assigned provider cannot read the booking through RLS. It uses an empty
search path, explicit caller checks, and has EXECUTE revoked from PUBLIC, anon,
and authenticated. It grants no new table UPDATE policy. Current stored admins
retain authority. With no JWT UID, only existing trusted outer roles postgres,
supabase_admin, or service_role may perform maintenance. `current_setting('role')`
retains the outer role inside SECURITY DEFINER; the function does not mistake its
postgres owner for an authenticated client's identity. Runtime tests exercise
this distinction with an artificial permissive policy and confirm rollback of
both the forbidden authority change and an attempted accompanying note edit.

The existing requester INSERT policy still checks ownership rather than a
pending-only state/provider contract, and unlinked requests retain broad
participant UPDATE behavior. A separate reviewed workflow should require pending
and validated assignment on direct creation and define provider/requester
transitions before offering an unrestricted request editor. Merely adding another
permissive policy would not narrow those permissions. The narrow linked guard
also means any legacy client that directly changes a booking-linked request
status must adopt the authorized review API; unlinked legacy workflows are
preserved. This behavior must be included in deployment review.

## Limits

PGlite uses a single session. These checks verify transaction rollback, RLS, and
row-lock code execution but do not simulate independent concurrent database
connections, deadlocks, PostgREST's HTTP behavior, JWT verification, SMTP,
GoTrue signup/recovery, payment, or browser permission propagation. The profile
wallet AFTER INSERT trigger is deliberately omitted because its unrelated wallet
side effects are outside this repair; the role-protection trigger is retained.
The snapshot covers the migration's table dependencies rather than every public
table, extension, view, or legacy application workflow. Actual deployment still
requires a fresh schema-contract check and controlled staging verification.
