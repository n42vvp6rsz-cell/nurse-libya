# Validation — October 7, 2026

Scope: the static GitHub frontend and the inspected database contract for `juxiaorwaiazfjlmkcvm`. This report does not certify the separate original Lovable application.

## Reproducible checks

Run from the repository root:

```sh
npm run check
node --test --test-isolation=none --test-reporter=spec tests/*.test.cjs
node tests/browser-smoke.cjs
```

The Chromium script requires Node 24 (native `WebSocket`) and `/usr/bin/chromium`, or `CHROMIUM_BIN`. It uses a temporary local HTTP server and disposable Chromium profile. Supabase SDK/config requests are replaced before navigation; all other external requests are blocked. It does not read the real frontend config file, access live database rows, sign up a user, send an email, or perform a backend write. The browser scenarios are mocks and must be described as such.

Node's default isolated test runner in this managed environment reports file-level counts. `--test-isolation=none` exposes the individual test cases; both must fail on an assertion failure. The baseline, before October 7 edits, has nine passing individual tests.

## Current result

The integrated frontend passes syntax checks and **11 Chromium browser scenarios** with no uncaught JavaScript exceptions. Viewports were 390 × 844 and 1440 × 844. Public and private screens have no page-level horizontal overflow, including a 260-character unbroken public title. The navigation header remains visible after returning home.

The browser checks cover guest/protected routes, SDK failure, public verification/review filters, empty/error/retry states, text-only rendering of attempted markup, native form validation, a single booking insert with a client UUID under rapid double submission, owner-scoped profile edits, suppression of a late private response after an account switch, stored-role administration checks despite forged metadata, keyboard access, and labels on all generated form fields. Font requests are intentionally blocked, so screenshots show the site's fallback font.

The final individual unit count is **89 passed, zero failed**: nine baseline, 14 core accounts/bookings, 15 catalog, 12 publication, 11 care-profile authoring, and 28 workspace/administration cases. `npm test` now runs the same explicit test-isolation command.

Professional profile forms for doctor, nurse, hospital, laboratory, and pharmacy roles were initialized in Chromium without property errors. A mock of `nurse_app_contract_version() = 1` enables their safe field/owner writes; a missing contract disables the form and rejects a programmatic submission. Contract-dependent administrator actions are covered by the workspace unit suite, including rechecking activation before a mutation. This is a frontend gate and does not prove that the corresponding database migration has been deployed.

The browser run found and helped resolve three integration defects that the DOM mocks did not expose: assigning the read-only textarea `type` property stopped two feature modules; duplicate registration of core contact/privacy routes threw an exception; and native fragment scrolling hid the header after routing. The final browser run includes regression coverage for module initialization and header position.

Repository viewport previews are [`preview-mobile.png`](preview-mobile.png) and [`preview-desktop.png`](preview-desktop.png). They show a mocked home-nursing service and contain no live records. `browser-smoke.cjs` regenerates temporary captures at `/tmp/nurse-libya-qa-390.png` and `/tmp/nurse-libya-qa-1440.png`. Both were visually inspected for readable RTL layout and unclipped controls.

No unresolved frontend blocker was found in the implemented flows. Authoring/review workflows that depend on the prepared database repairs remain unavailable until their database contract is activated. A shop, payment processing, messaging, and community posting were not implemented or certified by this work.

## Checks requiring a live authorized environment

The frontend mocks cannot establish email/SMTP delivery, Auth Site URL/redirect configuration, deployment caching, provider/admin role activation, transactional database behavior, or database migration success. No real identities or patient data were used to test these operations. See `current-database-contract.md` for the read-only policy/trigger findings and required backend repairs; a prepared SQL file is not evidence that a migration has run.

The prepared repair was parsed offline as 24 SQL statements plus four PL/pgSQL bodies using `pglast`. Parsing establishes syntax, not permissions, RLS behavior, execution privileges, concurrency guarantees, migration compatibility, or a successful live deployment.
