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
- 💳 Stripe payments with signature-verified webhooks
- 📁 Upload validation — file-size caps, MIME checks
- 🧬 SHA-256 content-hash dedupe (idempotent uploads, no double-billing)
- 🚦 Two-tier rate limiting (per-IP + per-workspace)
- 📬 Job queue producer — hands off valid, unique uploads to the AI service
- 🗄️ Prisma schema for workspaces, contracts, clauses, and risk flags (pgvector-ready for RAG)

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
| `DATABASE_URL` | Supabase Postgres pooled (transaction-mode) connection string |
| `JWT_SECRET` | Secret for signing JWTs |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | OAuth provider credentials |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe API + webhook signing |
| `REDIS_URL` | Redis instance for rate limiting & job queue |

## Project Structure
src/
├── modules/
│ ├── auth/ # JWT, OAuth, guards
│ ├── uploads/ # Validation, idempotency, queue producer
│ ├── payments/ # Stripe checkout, subscriptions, webhooks
│ └── rate-limit/ # Throttler config
├── prisma/ # Schema & migrations
└── common/ # Shared decorators, filters, interceptors

## Testing

```bash
# Contract tests
newman run postman/docushield.postman_collection.json

# Load testing
k6 run load-tests/rate-limit-and-queue.js
```

## Team

Built by **Shanza, Zayyam, and Annas** — work split so every member touches backend, frontend, AI, and testing. See the [Team Work Division doc](#) for the full breakdown.
