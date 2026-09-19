# DocuShield Backend — Senior Architecture Review

**Reviewed:** 2026-09-13
**Scope:** `src/**`, `prisma/schema.prisma`, `package.json`, tsconfigs, jest config, DB migration state

> **Status update (2026-09-16):** All blocking issues and the majority of gaps below have now been
> remediated; builds, lint, and all 14 test suites (92 tests) are green. See the resolution table in §6a.
> The original review was findings-only; the remediation pass was requested afterwards.

---

## 1. Verdict (TL;DR)

**Overall: B+ (good — genuinely production-lean in several places, not yet "industry standard" ship-ready).**

Strengths are architectural and security-critical: secure-by-default auth wiring, tenant scoping
in the SQL (not post-filtered), refresh-token rotation with replay detection, atomic single-use
invites, idempotent uploads/checkouts, Redis-backed multi-replica-safe rate limiting, correlation-id
logging, and a schema/engine split that is appropriate for the AI microservice boundary.

The gaps are mostly **operations, hardening, and two blocking issues** (deps not installed; DB
drift vs schema). The structure itself is above average for a team this size.

---

## 2. Blocking issues (fix before any demo / deploy)

### B1 — Dependencies added to lockfile but NOT installed
`package.json`/`package-lock.json` declare `@nestjs/jwt`, `@nestjs/passport`, `bcrypt`, `cookie-parser`,
`passport-jwt`, `passport-google-oauth20` (+ types), but they are **absent from `node_modules`**.

Consequences verified today:
- `npm run build` → **16 TS errors** (cannot find module `@nestjs/jwt`, `@nestjs/passport`, `bcrypt`, etc.).
- `npm test` → **14 suites: 5 fail** because `bcrypt` can't resolve (`password.service.ts:3`).
- The app **cannot boot**.

Fix (in one command): `npm install && npx prisma generate`. Do this first — everything below is moot until then.

### B2 — DB schema drift: the `invitations` table was never migrated
`prisma/schema.prisma` defines the `Invitation` model (invite/join flow), but
`prisma/migrations/20260101000000_init/migration.sql` (210 lines) predates it — there is **no
`CREATE TABLE "invitations"`** in the migration, and no later migration exists.

Consequences:
- The generated Prisma client has no `invitation` delegate (`Property 'invitation' does not exist`
  — part of the 16 build errors).
- The live Supabase DB has **no `invitations` table**, so `POST /auth/signup {type:"join"}` and
  `POST /workspaces/invite` would crash at runtime.
- Additionally, several `@@index` annotations added since the migration (e.g. `users(workspaceId)`,
  `clauses(contractId)`, `risk_flags(contractId)`, `subscriptions(stripeSubscriptionId)`, and the
  commit-message-touted "HNSW embedding index") are **not in the migration SQL**.

Verify drift: `npx prisma migrate status` → expect `1 migration ... has drifted / not applied`.
Fix when authorized: `npx prisma migrate dev --name add_invitations_and_indexes` (generates a diff migration
and marks it applied). The HNSW index cannot come from Prisma (embedding is `Unsupported`) — it must be
a hand-written `CREATE INDEX ... USING hnsw` migration step (e.g. `CREATE INDEX clauses_embedding_hnsw ON clauses
USING hnsw (embedding vector_cosine_ops);`). Verify the HNSW index is actually present: query `pg_indexes` —
this reviewer could not confirm it from migration state alone.

### B3 — DI wiring that will crash Nest at boot: `RoleInvalidationStore` crosses a module boundary it isn't allowed to
`WorkspacesService` (`workspaces/services/workspaces.service.ts:6`) injects `RoleInvalidationStore`,
but:
- `AuthModule` **provides** it (`auth.module.ts:46`) yet **exports only** `[AuthService, PassportModule]` (`auth.module.ts:72`).
- `AuthModule` is **not** `@Global`, and `WorkspacesModule` doesn't import `AuthModule`.

In Nest, a provider is only injectable in another module if the owning module is `@Global` or exports
it. As written, bootstrap throws
`Nest can't resolve dependencies of the WorkspacesService (PrismaService, ConfigService, ?, ...)`.

Fix (pick one, when authorized): mark `AuthModule` `@Global`, or export `RoleInvalidationStore` from
`AuthModule`, or import `AuthModule` in `WorkspacesModule`. Cleanest is exporting the guard/store
providers you expect other modules to use.

---

## 3. Strengths (industry-standard quality — keep these)

1. **Secure-by-default auth wiring.** Global `JwtAuthGuard` (`APP_GUARD`) with `@Public()` opt-out
   (`jwt-auth.guard.ts:26-33`); `RolesGuard` narrows but never grants (`roles.guard.ts:24-42`).
   A forgotten decorator fails closed, not open.
2. **Tenant isolation is enforced at the query layer, not after the fetch.** Workspace id always comes
   from the token (`contracts.controller.ts:42`, `workspaces.controller.ts:26`); cross-tenant fetches
   are `findFirst({where:{id, workspaceId}})` (`contracts.repository.ts:118-121`); a foreign contract
   returns 404, not 403, to avoid confirming existence (`contracts.service.ts:86-88`); viewer scoping
   happens inside `where` (`contracts.repository.ts:80-92`).
3. **Refresh-token rotation done properly.** Per-session `jti`; retired tokens tracked in a `spent` set;
   replaying a spent token revokes **all** sessions (`auth.service.ts:201-232`, `refresh-token.store.ts`).
   Fail-closed store (`run()` throws 503 when Redis is down).
4. **Access/refresh dual secrets** (`auth.module.ts:36`, `auth.service.ts:360`) — leaked access token
   can't mint new tokens. Cookies `httpOnly + SameSite=lax`, secret pinned in production.
5. **Atomic single-use invite claim.** `updateMany({where:{usedAt:null}})` inside the same transaction
   as user creation (`auth.service.ts:125-157`) — consumer-wins, safe under two simultaneous joins.
6. **Idempotency at two entry points.** SHA-256 hash + DB unique `contracts(workspace_id,file_hash)`
   (`schema.prisma:154`); Stripe checkout pinned with an `idempotencyKey` of workspace+plan
   (`stripe.service.ts:56`).
7. **BullMQ producer** with traceId propagation into job payloads, exponential backoff, retry=3, and
   bounded retention (`ingestion.producer.ts:28-42`).
8. **Two-tier Redis-backed rate limiting** — IP + workspace — safe across multiple replicas
   (`rate-limit.module.ts:22-35`); throttler guard prefers the verified JWT workspace
   (`workspace-throttler.guard.ts:20-28`).
9. **Correlation-id logging** with `AsyncLocalStorage` carried into worker jobs (`trace-context.service.ts`,
   `ingestion.producer.ts:31`); pino redacts authorization/cookie headers (`logger.module.ts:17`).
10. **Stripe webhook authenticity** via raw body + signature construct (`stripe-webhook.controller.ts:30-41`,
    `main.ts:8` rawBody).
11. **Comments explain *why* and the trade-offs** (fail-open vs fail-closed, 404-vs-403, unverified OAuth
    email → account takeover). This is genuinely better than most production codebases.

---

## 4. Gaps & inconsistencies (non-blocking, by severity)

### High
- **H1 — Upload path is not transactional.** `uploadContract` (`contracts.service.ts:30-58`) does
  create-contract → enqueue → create-ingestion-job as three separate writes. If the enqueue or the
  `ingestionJob` write fails, you get an orphan `contract` row (status `queued` forever) or a queued
  job with no tracking row. Wrap in try/catch: on failure, delete the contract + job, or persist the
  BullMQ job id and reconcile. At minimum, catch and log.
- **H2 — No Stripe idempotency/event dedup on the webhook consumer.** A delivered-twice
  `checkout.session.completed` re-upserts (fine) but also re-fires the n8n notification
  (`stripe.service.ts:143-150`). Record `stripe_event_id` in a table (or Redis SET) and skip
  already-handled events. Stripe retries webhooks for hours — dedupe is required, not optional.
- **H3 — The `.catch(() => undefined)` on workspace plan update** (`stripe.service.ts:140`)/line
  silently swallows failures — a paid plan could stay `free` with no trace. Log the error instead.

### Medium
- **M1 — `ContractsService.getContract` return type is `Promise<... | null>` but it always throws on
  null** (`contracts.service.ts:89-101`). Drop `null` from the signature; it's misleading and forces
  defensive `!contract` checks on every caller (e.g. `getContractStatus`).
- **M2 — `GET /contracts` is `take: 100` with no pagination** (`contracts.repository.ts:97`). Cursor /
  offset pagination is unavoidable for a real dashboard. Same for `GET /workspaces/me/members`.
- **M3 — `CreateCheckoutDto.workspaceId` is required but overridden from the token**
  (`subscriptions.controller.ts:18-21`, `create-checkout.dto.ts:4-6`). Remove it from the DTO (or mark
  `@Optional`) — a required body field that the server ignores is a trap for future maintainers.
- **M4 — `fileUrl` is `s3://contracts/...` but nothing writes to S3** (`contracts.service.ts:32`); it's
  a contract to a future AI service. If the bucket is meant to be private, the consumer must handle signing.
  Document this seam explicitly.
- **M5 — Silently-swallowed errors at the edges.** `stripe.service.ts:140`, `n8n-webhook.client.ts` logs
  but continues (acceptable), `RedisCacheService.onModuleInit` catches connect errors and logs
  (`redis-cache.service.ts:22-24`) — the app then runs with a dead cache. Decide a policy per dependency:
  fail-fast (DB, queue) vs fail-soft (cache, n8n) and make it consistent and documented.
- **M6 — `WorkspaceThrottlerGuard` falls back to attacker-controlled `x-workspace-id`**
  (`workspace-throttler.guard.ts:24`). Because it prefers the JWT, authenticated routes are safe, but an
  anonymous caller can set arbitrary values and squat the per-workspace bucket. Remove the header
  fallback for non-public routes (leave it only for genuinely unauthenticated endpoints).

### Low / polish
- **L1 — No ESLint config.** `npm run lint` fails — there is no `eslint.config.*` in the repo
  (devDeps installed). `@eslint/js` + `typescript-eslint` are already present; add a flat config.
- **L2 — No e2e tests.** `test/` directory is absent; only unit tests (14 suites). At least one
  boot-level e2e (`NestFactory.create` + supertest) covering the global guards order
  (Jwt → Roles → Throttler) would catch DI/ordering regressions like B3.
- **L3 — No OpenAPI/Swagger.** With `class-validator` DTOs everywhere, `@nestjs/swagger` is nearly free
  and would document the API for the AI-service/AI-team and frontend.
- **L4 — `main.ts` hardening.** No `app.enableShutdownHooks()` (necessary for BullMQ/Redis/Prisma
  graceful drain), `process.env.PORT`/`FRONTEND_URL` read directly without validation, no global
  exception filter to normalize error shape. Consider `helmet` for the non-webhook surface.
- **L5 — No health/readiness endpoint** (`/healthz` liveness + `/ready` checking Redis/DB/queue). This
  is table stakes for any deployment target.
- **L6 — No CI config in the repo.** Wire a workflow that runs `build` + `test` (and later `lint`,
  `migrate status`) on PRs — would have caught B1/B2 immediately.
- **L7 — Login brute-force.** No targeted throttle on `/auth/login` (only the coarse per-IP tier,
  `rate-limit.module.ts:26`). Consider a low limit on the login route specifically.
- **L8 — Auth store micro-nit:** `RoleInvalidationStore` uses a SET with a single member `'1'`
  (`role-invalidation.store.ts:40-42`) — a plain set/exists key does the same job with less ambiguity.
- **L9 — Unused code/legacy:** `WorkspacesService.isMember` (`workspaces.service.ts:87-93`) isn't called
  anywhere — remove or use it (e.g. in the OAuth join path for verified membership).
- **L10 — `accessTokenTtlSeconds` parsing duplicated** with the cookie parser in `auth.controller.ts`
  (`parseMs`) and the service (`workspaces.service.ts:175-193`). Two ms-parsers with slightly different
  rules — extract one shared util.
- **L11 — Type cast smells:** `contract.status as ContractStatus` (`contracts.service.ts:116`) and the
  `Plan`/`Role` string casts in stripe flow. Minor; Prisma's runtime types should be trusted directly.
- **L12 — `stripe.service.ts:13-25`** reads secrets via `getOrThrow` at construction — fine, but note the
  singleton will throw on boot if `STRIPE_SECRET_KEY` is absent, even if Stripe isn't used. Consider lazy
  init or a `@nestjs/bullmq`-style provider guard for local dev without Stripe keys (mirror the Google
  strategy pattern at `auth.module.ts:54-68`).

---

## 5. Things verified healthy (so nobody worries about them)
- `.env` (real creds) is **gitignored**; `.env.example` is tracked and matches usage.
- Migration status for the *original* 10 tables is in sync; pgvector extension + `vector(768)` confirmed
  (earlier `scripts/verify-db.js` run).
- Secrets are never logged; pino redacts `authorization` and `cookie` headers.
- All routes are behind the global JWT guard except deliberate `@Public()` (auth surface + Stripe webhook),
  which is the correct set.

---

## 6a. Resolution status (2026-09-16 remediation pass)

| Id | Resolution |
|----|-----------|
| B1 | `npm install` after restoring `package.json`/lock; `npx prisma generate`. Build passes; 8 transitive npm advisories remain (none in direct deps). |
| B2 | Already handled by the team: migrations `add_invitations` + `add_query_indexes` (incl. HNSW) exist and are applied. Only residual drift = Supabase auto-created extensions. |
| B3 | `AuthModule` now exports `RoleInvalidationStore` + `RefreshTokenStore`. |
| H1 | `uploadContract` enqueues, then records the job; on failure it deletes the contract row and throws, so no orphan rows. |
| H2 | Webhook dedup via Redis `stripe:event:{id}` — checked before handling, set (24h TTL) only after success so retries after failure still process. |
| H3 | Workspace plan-update failure now logged through `Logger.error` instead of a silent `.catch(() => undefined)`. |
| M1 | `getContract` returns `Promise<ContractWithIngestion>` (non-null; `NotFoundException` on miss). |
| M2 | `GET /contracts` supports `cursor` + `limit` (keyset pagination, default 20, max 100) via `ListContractsQueryDto`. |
| M3 | `workspaceId` removed from `CreateCheckoutDto`; the controller injects it from the token. |
| M4 | Documented seam (s3:// URL + hash consumed by the AI worker); consumer handles signing — no code change. |
| M5 | Policy kept intentional and per-dependency: DB/queue fail-fast, cache/n8n fail-soft with logged errors. |
| M6 | Header fallback removed; throttle key = verified JWT `workspaceId`, else `req.ip`. |
| L1 | Flat `eslint.config.mjs` (typescript-eslint + prettier, spec-file relaxations); `npm run lint` green. |
| L2 | Deferred — infra-dependent (needs live DB/Redis); unit coverage unchanged at 92 tests. |
| L3 | `@nestjs/swagger` wired; interactive docs at `/api/docs`. |
| L4 | `main.ts`: `enableShutdownHooks()`, validated `PORT`, `helmet`, raw-body preserved for webhooks. |
| L5 | `GET /health` (public): DB ping with 3s timeout, returns `ok/degraded`. |
| L6 | Deferred — CI to be added by the team on their provider (runs `build`+`test`+`lint`). |
| L7 | `POST /auth/login` carries a dedicated `@Throttle({ ip: 10/min })` cap. |
| L8 | `RoleInvalidationStore` simplified to SET/EXISTS with a TTL. |
| L9 | `WorkspacesService.isMember` removed along with its spec section. |
| L10 | Single `parseDurationToSeconds` util in `src/common/utils`; controller + service + refresh TTL all use it. |
| L11 | Type casts left as-is — Prisma runtime types are the source of truth (no functional change). |
| L12 | Deferred — Stripe keys remain `getOrThrow` at boot; a provider guard (mirroring the Google strategy) is a follow-up for local dev without keys. |

Comments across the core files were trimmed to *why*-only (security/runtime rationale); essay-style docblocks
and stale doc-markers were removed. Final state: `npm run build` ✅, `npm run lint` ✅, `npm test` ✅
(14 suites / 92 tests), `npx prisma validate` ✅.