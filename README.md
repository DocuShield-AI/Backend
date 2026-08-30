# DocuShield — Backend

The **NestJS API Gateway** for DocuShield, an AI co-pilot for legal contract risk triage. This service is the load-bearing wall of the system — every other component (frontend, AI/RAG microservice) talks through it.

## Tech Stack

- **Framework:** NestJS
- **Database:** Supabase Postgres + `pgvector` (via Prisma ORM)
- **Auth:** JWT + OAuth 2.0
- **Payments:** Stripe (Checkout, Subscriptions, Webhooks)
- **Rate Limiting:** Redis-backed, two-tier (`@nestjs/throttler`)
- **Job Queue:** Redis / BullMQ (producer side — consumed by the AI microservice)
- **Testing:** Postman contract tests, k6/Artillery load tests

## Features

- 🔑 Role-based access control (Admin / Legal / Viewer) via decorator guards
- 🔐 JWT issuing/verification + OAuth login flow
- 💳 Stripe payments with signature-verified webhooks (newest `2026-08-26.dahlia` API)
- 📁 Upload validation — file-size caps, MIME checks
- 🧬 SHA-256 content-hash dedupe (idempotent uploads, no double-billing)
- 🚦 Two-tier rate limiting (per-IP + per-workspace), **Redis-backed** — scales across replicas
- 🗄️ Redis caching for rule-engine decisions & RAG answers (cuts LLM calls, not just rate-limits them)
- 📬 Job queue producer — hands off valid, unique uploads to the AI service via Redis/BullMQ (never synchronous)
- 🧵 Structured pino logging with per-request correlation id propagated into BullMQ jobs
- 🗄️ Prisma schema for workspaces, contracts, clauses, and risk flags (pgvector-ready for RAG)

> **Embedding dimension (Part 7.1):** `Clause.embedding` is `vector(768)` — the output dimension of the Gemini embedding model used by the AI microservice. If the embedding model changes, this column and the migration must be updated together (dimension is baked into the column type, not row data).

## Getting Started

```bash
git clone https://github.com/<org>/docushield-backend.git
cd docushield-backend
npm install
cp .env.example .env
npx prisma migrate dev
npm run start:dev
```

API runs at `http://localhost:4000`.

## Environment Variables

| Variable | Description |
|---|---|
| `DATABASE_URL` | Supabase Postgres **pooled** (transaction-mode) connection string — used at runtime |
| `DIRECT_URL` | Supabase **direct** connection string — used only by `prisma migrate` |
| `REDIS_URL` | Redis for job queue, rate limiting & caching |
| `JWT_SECRET` | Secret for signing JWTs |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | OAuth provider credentials |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe API + webhook signing |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_ENTERPRISE` | Stripe Price IDs for each paid plan |
| `PUBLIC_BASE_URL` | Canonical API origin for Stripe redirects |
| `N8N_WEBHOOK_URL` | Annas's n8n workflow endpoint for payment-success events |
| `RATE_LIMIT_IP_PER_MINUTE` / `RATE_LIMIT_WORKSPACE_PER_MINUTE` | Tier 1 / Tier 2 throttler limits |
| `LOG_LEVEL` | pino log level (default `info`) |

## Project Structure

Layered architecture: **Routes (Controllers) → Services → Repositories**, grouped into feature modules under `modules/`, with cross-cutting infra under `common/`.

```text
src/
├── main.ts                       # bootstrap: pino logger, validation, CORS, rawBody
├── app.module.ts                 # root wiring + global trace-id middleware
├── common/                       # cross-cutting infra (all @Global)
│   ├── logger/                   # pino structured logger + correlation-id (trace)
│   │   ├── logger.module.ts
│   │   ├── trace-context.service.ts
│   │   └── trace-id.middleware.ts
│   ├── cache/                    # Redis cache (rule-engine + RAG)
│   │   ├── cache.module.ts
│   │   └── redis-cache.service.ts
│   └── rate-limit/               # Redis-backed two-tier throttler
│       ├── rate-limit.module.ts
│       └── workspace-throttler.guard.ts
└── modules/                      # feature domains
    ├── prisma/                   # PrismaService (global)
    ├── workspaces/               # placeholder — Shanza's auth/RBAC
    ├── contracts/
    │   ├── controllers/          # upload, get, status routes
    │   ├── services/             # business logic + queue producer call
    │   ├── repositories/         # Prisma data access
    │   └── validators/           # file MIME/size + sha256 hash
    ├── subscriptions/
    │   ├── controllers/          # checkout + stripe webhook (signature-verified)
    │   ├── services/             # stripe.service.ts
    │   └── dto/
    ├── queue/
    │   └── producers/            # ingestion producer (BullMQ)
    └── notifications/            # n8n-webhook.client.ts
```

## Testing

```bash
npm test            # unit + contract tests (Stripe signature, file validation, queue payload contract)
```

Load & integration tests live in the `load-tests/` and `postman/` folders once added.

```bash
# Contract tests
newman run postman/docushield.postman_collection.json

# Load testing
k6 run load-tests/rate-limit-and-queue.js
```

## Team

Built by **Shanza, Zayyam, and Annas** — work split so every member touches backend, frontend, AI, and testing. See the [Team Work Division doc](#) for the full breakdown.
