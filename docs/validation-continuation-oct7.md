# Continuation validation — October 7, 2026

Scope: the static GitHub frontend, including the private messaging and cash-on-delivery store modules. This report does not certify the original, separate Lovable application or a production deployment.

## Publication and activation status

The working public site is [n42vvp6rsz-cell.github.io/nurse-libya](https://n42vvp6rsz-cell.github.io/nurse-libya/). It still serves the October 5 `main` version, commit `1e07c0b`. The latest changes in [pull request #2](https://github.com/n42vvp6rsz-cell/nurse-libya/pull/2) remain unpublished.

An attempt to apply the core production database migration was rejected by automatic approval review. The reviewer requires explicit user approval for permanent production DDL and changes to policies, privileges, and functions; successful local tests do not authorize deployment. **No SQL was applied.** The core, messaging, and store migration files remain unapplied proposals. The new interfaces keep contract-dependent writes disabled until their corresponding version markers are activated.

## Reproducible checks

```sh
npm run check
npm test
npm run test:browser
npm run test:db
```

The browser harness requires Node 24 and Chromium (`/usr/bin/chromium`, or `CHROMIUM_BIN`), and permission to bind a loopback HTTP server. It serves repository assets from that temporary local server and uses a disposable browser profile. Before navigation, it intercepts the Supabase SDK and frontend configuration and substitutes local fixtures. A single known image URL is fulfilled locally with a synthetic 4000-pixel-wide SVG; every other external request is blocked. The real `config.js` is not read. No live database rows, real identities, emails, messages, orders, charges, or external image downloads are used.

Browser fixtures deliberately contain unsafe-looking markup, UUIDs reserved for local tests, account changes during pending requests, inactive backend contracts, and lost-response failures. These checks exercise client behavior; they do not establish production database permissions or backend activation.

## Result

Syntax checks pass for all frontend scripts and the frontend configuration. **130 individual unit tests pass**, with zero failures: the prior 89 cases, 14 messaging cases, and 27 store cases. **21 Chromium scenarios pass**, with zero failures and no uncaught JavaScript exceptions.

The offline SQL suites pass **85 scenarios on PostgreSQL 17.5** through pinned PGlite 0.3.16: 44 core repairs, 20 messaging, and 21 store cases. They execute the prepared SQL, RLS, privileges, triggers, and transactions against synthetic local fixtures. They neither connect to Supabase nor establish production activation.

Both 390 × 844 and 1440 × 844 viewports were exercised. No page-level horizontal overflow occurs in the new store, orders, store administration, or messaging pages. A locally generated 4000-pixel-wide product image is constrained correctly. New form controls have associated labels, and an actual keyboard Tab moves from the message textarea to its send button. Remote fonts are blocked, so the captures use the fallback font.

The browser scenarios extend the prior account, booking, directory, authoring, and stored-role checks with these new boundaries:

| Area | Observed behavior with synthetic fixtures |
| --- | --- |
| Messaging reads | Only the captured participant's pair is rendered; a checked public-provider deep link opens its thread; attempted HTML remains plain text. |
| Messaging writes | Missing version marker disables send/read marking and also rejects programmatic submission. Rapid duplicate sends share one request. A lost-response retry preserves UUID, recipient, and text; a validated recipient read action changes only its read state. |
| Messaging account changes | A late prior-account inbox response cannot display private text or restore a draft. |
| Store catalog | Empty catalogs show no fabricated products. Search/category filters use available values, and attempted markup remains plain text. LYD prices retain three decimal places, including whole amounts: 1005 minor units represent 1.005 dinars. |
| Store checkout | Missing contract prevents programmatic checkout. Cash on delivery exposes no card fields or online-paid claim. Duplicate submission produces one atomic request. Lost-response recovery checks the original owner UUID and stored snapshots even after catalog price/stock changes. |
| Stock review | Refreshed unavailable stock prevents a new checkout and displays a review warning before any checkout RPC. |
| Shop administration/privacy | Forged metadata cannot open administration or mutate products. The stored administrator can load the panel. Late previous-account orders are suppressed, delivery inputs are cleared, and no private cart/order state is written to local/session storage. |

Labeled mock previews are [`preview-mobile.png`](preview-mobile.png), [`preview-desktop.png`](preview-desktop.png), [`preview-messages-mobile.png`](preview-messages-mobile.png), [`preview-messages-desktop.png`](preview-messages-desktop.png), [`preview-store-mobile.png`](preview-store-mobile.png), and [`preview-store-desktop.png`](preview-store-desktop.png). The browser script regenerates them from fixtures and adds an Arabic mock-data label. The captures were visually inspected for readable RTL text, separated message previews, bounded product imagery, and unclipped controls. Mock product names, prices, and quantities are test data and are never seeded into the application database.

## Production limits

Prepared migrations are not evidence of successful deployment. Production SMTP/redirect configuration, live RLS, role grants, actual payment collection, stock concurrency, and data-retention operations must be established in an authorized deployment environment. The new store accepts cash on delivery only; no card fields or claims of online payment success belong in this release.

SQL runtime verification uses separate synthetic local PostgreSQL fixtures in `database-runtime.cjs`, `messages-database-runtime.cjs`, and `store-database-runtime.cjs`. Their behavior and limits are documented in [`database-runtime-results.md`](database-runtime-results.md), [`messages-contract.md`](messages-contract.md), and [`store-contract.md`](store-contract.md). The frontend browser harness cannot substitute for those database permission, idempotency, and transaction checks.

The PostgreSQL fixtures use one session and match the production major version, rather than its exact PostgreSQL 17.6 patch level. They do not verify simultaneous independent connections, PostgREST/JWT behavior, GoTrue/SMTP, live delivery, or payment collection. Existing provider verification flags are preserved rather than independently revalidated, and unlinked service requests retain their prior participant permissions.

The existing Supabase security advisor reports that leaked-password protection is disabled. See [password strength and leaked-password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection) for remediation; this setting was not changed.

The original October 7 baseline report is preserved in [`validation-oct7.md`](validation-oct7.md). Its 89/11 counts and statement that messaging/shop were absent describe the earlier pull-request state. This continuation report describes the added modules.
