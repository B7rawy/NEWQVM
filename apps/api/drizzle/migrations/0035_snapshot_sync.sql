-- 0035_snapshot_sync — INTENTIONAL NO-OP.
-- Purpose: refresh drizzle's snapshot (meta/0035_snapshot.json) so future `drizzle-kit generate`
-- diffs against the CURRENT schema. Migrations 0030–0034 were hand-written (workshop_users,
-- counterparty identity, individual-read privacy, activation_status, audit hardening), so the
-- snapshot chain had stalled at 0029; the SQL drizzle generated here duplicated those already-
-- applied objects (verified: additions only, zero DROPs — .ts and the live DB are in lockstep)
-- and was therefore emptied. The snapshot is the deliverable of this migration, not DDL.
SELECT 1;
