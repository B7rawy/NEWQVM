-- 0075_workshop_soon_labels.sql — two pages in the workshop menu claimed "Soon" while working.
--
-- Found by the guard added alongside 0074, which asserts a shared route reads the same in every
-- portal. /admin/users and /settings are wired routes rendering real components, and every other
-- portal marks them built; only the workshop tree carried `soon: true`, transcribed into the
-- catalog by 0069 along with everything else.
--
-- Checked before changing: GET /api/admin/users answers 200 for a workshop user, the same as for a
-- workspace manager. /settings renders the same component in every portal (the 404 on /api/settings
-- is an endpoint no portal's Settings page calls).
--
-- A "Soon" pill on a page that opens and works is a small lie that teaches people not to trust the
-- pill, which is the one thing it has to be right about.

update app_pages set is_built = true, updated_at = now()
where persona = 'workshop' and path in ('/admin/users', '/settings');
