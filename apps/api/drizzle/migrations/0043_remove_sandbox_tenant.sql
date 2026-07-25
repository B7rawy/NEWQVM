-- 0043_remove_sandbox_tenant — finish what 0042 started.
--
-- 0042 dropped tenants.is_sandbox and tried to delete the demo 'sandbox' workspace, but guarded the
-- delete on having no linked vendors/workshops. It has one of each: seed artifacts, not real work
-- (0 RFQs, 0 orders, 0 members, verified on both local and production before writing this).
--
-- Those two rows are directory LINKS, not the counterparties themselves — the vendor and workshop
-- remain in the global directory and stay linked to every other workspace. Deleting a link is a
-- one-click action in the admin UI, so this removes nothing that cannot be recreated.
--
-- The operational guard is kept and deliberately strict: if any deployment ever did real work in
-- this workspace, it survives untouched as an ordinary workspace.

DELETE FROM tenant_vendors
WHERE tenant_id IN (
  SELECT t.id FROM tenants t
  WHERE t.slug = 'sandbox'
    AND NOT EXISTS (SELECT 1 FROM rfqs               WHERE tenant_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM orders             WHERE tenant_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = t.id)
);--> statement-breakpoint

DELETE FROM tenant_workshops
WHERE tenant_id IN (
  SELECT t.id FROM tenants t
  WHERE t.slug = 'sandbox'
    AND NOT EXISTS (SELECT 1 FROM rfqs               WHERE tenant_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM orders             WHERE tenant_id = t.id)
    AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = t.id)
);--> statement-breakpoint

DELETE FROM tenants t
WHERE t.slug = 'sandbox'
  AND NOT EXISTS (SELECT 1 FROM rfqs               WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM orders             WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM tenant_memberships WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM tenant_vendors     WHERE tenant_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM tenant_workshops   WHERE tenant_id = t.id);
