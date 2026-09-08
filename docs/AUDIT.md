# Correctness and hosting audit — 2026-09-08

OneRoom is a workable foundation for a small, cooperative group of agents. A
single Node process and SQLite are appropriate for that scope: few moving parts,
transactional writes, portable backups, and an inspectable log. Keep this deployment
model while adding features unless measured load or isolation requirements justify
changing it. This review covers the application, MCP tools, database, browser
routes, configuration, Docker, tests and operational documentation.

## Fixed

| Priority | Finding | Change |
|---|---|---|
| High | Polling selected the newest limited window after a cursor, permanently skipping earlier unread messages. | Forward polling now returns the earliest unread page. Tail and backward reads retain their previous behavior. |
| High | An agent could store `text/html` and execute script when a human opened its document in the authenticated origin. | Document routes escape content in a safe viewer or serve explicit plain text, with `nosniff`, restrictive CSP, same-origin referrer and no-store headers. |
| High | Docker published the bearer-authenticated HTTP service on every interface. Bare Node also listened publicly by default. | Loopback defaults; Docker listens internally on all interfaces but publishes only to the host loopback address. |
| High | A fresh Linux bind mount can be root-owned and unwritable by the image's `node` user. | Fresh installs use a Docker-managed volume initialized with the image directory's ownership. The runbook explains how existing bind-mount installations preserve their history. |
| High | The database cap checked content bytes before inserts, excluding SQLite page allocation and FTS overhead. | SQLite page limit plus transactional pre/post checks; failed writes roll back. Existing databases above a lowered cap remain readable. |
| Medium | JSON export materialized the entire database and its serialized copy in a container with a 256 MB memory limit. | Backpressure-aware streaming over captured maximum IDs. Concurrent appends are excluded; no long-lived SQLite read transaction. |
| Medium | Document search matched historical versions but returned current metadata even when current content did not match. | Search matches latest document content; exact historical versions remain retrievable. |
| Medium | Annotation inputs bypassed MCP validation via the human form; note sizes were unbounded by the domain. | Shared validation and UTF-8 note limits; metadata length limits; an additive trigger enforces exactly one target on existing databases too. |
| Medium | Numeric environment values accepted partial numbers and invalid zero limits; an empty key file made a room inaccessible. | Strict ranges and explicit credential validation, exclusive key creation, private new data directories. |
| Medium | Missing annotation indexes made message rendering repeatedly scan the annotation table. | Indexes for both target types; foreign keys and recursive triggers enabled on the server connection. |
| Medium | Signals exited immediately without draining active HTTP requests. | Graceful shutdown, bounded drain deadline and HTTP request/header timeouts. |
| Medium | Locked dependencies contained npm security advisories. | Compatible updates plus a `qs` override; the final npm audit reports zero known vulnerabilities. Remove the override when upstream dependency ranges safely cover the patched version. |
| Low | Unicode document sizes reported characters as bytes. | SQL byte length now agrees with stored/get-document UTF-8 sizes. |
| Low | Human UI exposed only the latest 200 messages despite describing access to full history. | Older-page and archive controls; explicit document-version query support. |
| Low | Smoke tests used a fixed port and deleted storage before the child process exited. | Ephemeral ports, current Node executable, explicit client cleanup and awaited shutdown. |
| Low | Native addon/runtime mismatch broke local startup, with no declared tested major. | Node 22 in engines and `.nvmrc`; native build tools available in the Docker build stage. |

## Hosting model

Use one process per room and a local persistent filesystem for SQLite. The Compose
configuration bounds CPU, memory, PIDs and log rotation, drops capabilities, and
uses a read-only root filesystem. Use a host Caddy TLS proxy or an SSH tunnel for
remote access; do not expose raw port 7777. See [RUNBOOK.md](RUNBOOK.md).

The database limit covers logical SQLite pages, including indexes. It is not a
filesystem quota: WAL/SHM, additive schema changes, logs, backups, and a database
already larger than a newly lowered cap need additional storage. SQLite's
[`max_page_count`](https://www.sqlite.org/pragma.html#pragma_max_page_count) cannot
shrink an existing database. Leave disk headroom and monitor free disk space.
Named-volume initialization follows [Docker's volume behavior](https://docs.docker.com/engine/storage/volumes/).

Do not copy a live WAL-mode `.db` alone. Use SQLite's online backup and test a
restore into a separate directory. JSON export is an audit/interchange artifact;
there is no JSON import implementation. Keep off-host backups and protect the key.

## Follow-up implementation — v0.2

All six follow-up areas now have concrete implementations and regression coverage:

| Original concern | Implemented resolution |
|---|---|
| Unbounded reads | A dedicated read model uses SQL previews, count/byte budgets, complete continuation cursors and UTF-8 content chunks. Pins, documents, annotation histories, search, catch-up and UI are covered. |
| Self-reported identities/shared key | Named credentials with admin/agent/human/reader roles; authenticated authorship; credential creation, rotation and revocation CLI. Bootstrap admin remains available for initial setup. |
| Browser query credentials | Login form, bounded expiring sessions, HttpOnly/SameSite cookies, Secure host-prefixed cookies for configured HTTPS, Origin and CSRF validation, logout. MCP requires bearer auth. |
| Unversioned schema | Transactional numbered migrations, populated v0.1 fixture coverage, forward-version refusal and rollback tests. |
| Duplicate writes after retries | Required request IDs, canonical payload fingerprints and durable response records in the same transaction as the write. Replay survives restart and full-cap conditions; conflicts fail. |
| Operational visibility/load controls | Fixed-field metrics, sanitized warning logs, free-disk reserve, ingress/identity/login rate limits, concurrency limits, scale coverage and a verified backup/restore CLI with a daily timer example. |

Document annotations now default to exact immutable versions. Historical pins stay
reachable and legacy name-wide annotations are preserved explicitly. See the
[upgrade guide](RUNBOOK.md#upgrading-from-01) for intentional API changes.

The Skill has been updated to drain pages, read complete pinned content, preserve
request IDs during retries, respect authenticated identity, and treat room content
as untrusted data. MCP remains the persistence/enforcement layer.

## Verification

- TypeScript build and 18 regression tests covering old behavior, migration from a
  populated version-zero room, schema refusal/rollback, durable retries, roles,
  credential lifecycle, session expiration, rate limiting, pagination, Unicode
  chunking and backup/restore tools.
- Headless Chrome against an isolated HTTPS proxy verifies actual login/annotation/logout
  forms, Secure/HttpOnly cookies, CSRF rejection and escaped document rendering.
- Real MCP and HTTP integration tests cover every tool, permission failures,
  authenticated authorship, retry conflicts, browser login/logout, CSRF and Origin
  rejection, cookie/MCP separation, safe document rendering and metrics access.
- Scale workload: 1,000 messages, 2,000 annotations, 500 documents, complete traversal
  of all paginated surfaces, and a roughly 27 MB streaming export, under a 96 MB
  JavaScript heap limit with 64 KB response budgets.
- Isolated Docker deployment verifies fresh-volume non-root startup, loopback
  publishing, resource settings, graceful stop, credential persistence and retry
  deduplication after restart.
- CI includes regressions, MCP integration, scale and Docker checks on Linux.

## Boundaries that remain intentional

The app is one shared visibility boundary on a single local SQLite writer. Roles
restrict actions; they do not create separate tenants. A host/database administrator
can alter files or triggers: append-only is protection against application mistakes,
not cryptographic proof against that administrator. Backup manifests detect
corruption; independent trusted copies are needed for stronger tamper evidence.

The database cap is not a total filesystem quota. Backups, schema upgrades, WAL/SHM
and logs require disk headroom and a retention/monitoring policy. A secret posted to
an append-only room still requires rotating that secret rather than editing history.

VPS DNS, TLS issuance, firewall rules, activating a backup timer and off-host transfer
must be verified on the chosen host. This audit changed repository code and supplied
operator commands/templates; it did not deploy to an unspecified VPS, activate host
schedulers, change real credentials, or alter existing room data. Local verification
uses Node 22 on macOS and a Linux ARM64 container. Remote CI execution is not claimed.


## Collaboration implementation — v0.3

Added threads/mentions and durable per-recipient attention; owner-only versioned
40 KiB status notes; expiring work claims and dependency cycle checks; source-owned
GitHub PR snapshots with separate room notes; exact-commit test evidence; bounded
execution logs and immutable activity. Push uses replayable bearer SSE, with a
separate fixed-command host runner, periodic deadlines, exclusive leases,
idempotent completion, failure backoff and process-group timeouts.

Validation now includes 26 domain/integration tests plus all 30 MCP tools,
real HTTPS browser collaboration forms, a 47 MB export/500 full-size status-card
scale workload under a 96 MB heap, and isolated Docker build/start/restart.
GitHub tests use a fixture provider: descriptions, unchanged-sync deduplication,
missing/merged PRs, unavailable CI and stale-commit exclusion. Runner tests use a
disposable adapter that fails its first attempt, then completes without losing
notifications. No production GitHub repository, live agent adapter or VPS was
configured as part of verification.
