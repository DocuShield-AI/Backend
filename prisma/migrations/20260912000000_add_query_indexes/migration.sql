-- Add FK-column indexes for the query paths the API actually runs.
-- Prisma does not index foreign-key columns automatically; without these,
-- member listing, clause/flag/audit lookups and the Stripe webhook lookup
-- would degrade to sequential scans as the tables grow.

-- CreateIndex
CREATE INDEX "users_workspace_id_idx" ON "users"("workspace_id");

-- CreateIndex
CREATE INDEX "invitations_workspace_id_idx" ON "invitations"("workspace_id");

-- CreateIndex
CREATE INDEX "subscriptions_stripe_subscription_id_idx" ON "subscriptions"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "clauses_contract_id_idx" ON "clauses"("contract_id");

-- CreateIndex
CREATE INDEX "risk_flags_clause_id_idx" ON "risk_flags"("clause_id");

-- CreateIndex
CREATE INDEX "risk_flags_contract_id_idx" ON "risk_flags"("contract_id");

-- CreateIndex
CREATE INDEX "notification_logs_risk_flag_id_idx" ON "notification_logs"("risk_flag_id");

-- CreateIndex
CREATE INDEX "audit_logs_contract_id_idx" ON "audit_logs"("contract_id");

-- CreateIndex
CREATE INDEX "audit_logs_clause_id_idx" ON "audit_logs"("clause_id");

-- HNSW vector index for the clause-embedding similarity search (RAG).
-- Cannot be expressed in the Prisma schema (embedding is an Unsupported
-- vector column), so it lives here as raw SQL.

-- CreateIndex
CREATE INDEX "clauses_embedding_hnsw_idx" ON "clauses" USING hnsw ("embedding" vector_cosine_ops);