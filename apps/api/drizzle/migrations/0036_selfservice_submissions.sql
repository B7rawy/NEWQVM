-- 0036_selfservice_submissions — QNEW-71 §3.5: an ACTIVATION COLLISION (a self-registered account
-- whose identifier matches an existing entity) is routed into the /onboarding/review queue instead
-- of being flatly rejected. Such a submission belongs to NO workspace, so tenant_id becomes
-- nullable. RLS note: tenant_isolation matches (tenant_id = current_tenant_id() OR app_is_internal());
-- a NULL tenant_id row is therefore visible/writable ONLY to internal staff — exactly right for a
-- review-queue-only row.
ALTER TABLE "counterparty_submissions" ALTER COLUMN "tenant_id" DROP NOT NULL;
