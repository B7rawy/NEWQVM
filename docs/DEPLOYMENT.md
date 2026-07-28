# Deployment and Operations

How QVM gets to production, what runs there, and what to do when it breaks.

Everything here was read from the files cited. Paths are relative to the repo root.

---

## 1. The rule

**`./deploy.sh` is the only supported path to production.** Not `rsync`, not `scp`, not a manual `git pull` on the box.

This is not a style preference. From the header of `deploy.sh` (lines 2-10), a hand-written `rsync -az --delete` on 2026-07-25 deleted three paths that exist on the production VPS but not in the repo:

| Path deleted | What it was | Consequence |
|---|---|---|
| `pgdata/` | the Postgres **data directory** | Docker recreated it empty, Postgres re-initialised from scratch, **the entire database was lost** |
| `apps/api/start.sh` | pm2's entrypoint, holding the production runtime environment | the API could not be started |
| `.env` | compose/runtime configuration | migrations and tooling had no connection string |

It was recoverable only because a `pg_dump` had been taken minutes earlier by coincidence.

`deploy.sh` exists to make that specific accident impossible. Every guard in it corresponds to a failure that has actually happened — the comments in the file say so, and they are worth reading before you change anything.

**Run it from the repo root.** The script computes `HERE` (line 15) but never `cd`s into it, and two steps use paths relative to the current working directory: the migration pre-flight reads `apps/api/drizzle/migrations` (line 51) and the web build runs `corepack pnpm --filter @qvm/web build` (line 66). Invoking `./deploy.sh` from anywhere else fails.

```bash
cd /path/to/qvm-platform
./deploy.sh
```

---

## 2. Production topology

Live at **easycarty.store**, with each workspace on its own subdomain (`<slug>.easycarty.store`).

Subdomain resolution is implemented in two mirrored places:

- Backend: `apps/api/src/common/request-context.ts:31-40` (`resolveTenantSlug`). The subdomain is authoritative; the `X-Tenant` header is the fallback for the apex and for local dev. The root domain it strips comes from `APP_ROOT_DOMAIN`, read once at `apps/api/src/common/auth.guard.ts:14`.
- Frontend: `apps/web/src/lib/tenant.ts`. `currentSubdomain()` (line 29) derives the active workspace from `window.location.hostname`.

Wildcard DNS is **not** a hard requirement. `subdomainReachable()` (`tenant.ts:56-63`) probes the subdomain before the post-login redirect and stays on the apex in header mode if it does not resolve — the comment says this exists so nothing breaks before `*.easycarty.store` is live, and it self-heals once the record exists.

Both files keep their own copy of the reserved-subdomain list (`request-context.ts:24`, `tenant.ts:12`). They currently agree; nothing enforces that they stay in sync.

| Component | How it runs |
|---|---|
| API (`@qvm/api`) | a pm2 process named **`qvm-api`**, started from `apps/api/start.sh` |
| Web (`@qvm/web`) | a static Vite bundle in `apps/web/dist/`, built on the developer's machine and rsynced |
| Postgres 16 | a Docker container named **`qvm_postgres`**, database `qvm_platform`, owner role `qvm` |
| Repo checkout | `/var/www/easycarty` (overridable via `QVM_REMOTE`, `deploy.sh:14`) |
| Reverse proxy | nginx — serves the SPA and proxies `/api` from the **same origin** |

### What is not in the repo — be aware of this

Several things production depends on are prod-only files and are deliberately never transferred. This was verified by searching the tree: the only mentions of nginx or pm2 anywhere are comments in `deploy.sh`, `apps/web/src/lib/api.ts`, and `apps/api/scripts/smoke-prod.sh`. No `start.sh` exists in the repo at all.

- **`apps/api/start.sh`** — pm2's entrypoint. It holds the API's runtime environment (`APP_DATABASE_URL` and friends). The repo has no copy; the restore runbook at `deploy.sh:110` refers to it as the place the `qvm_app` password lives.
- **`.env`** on the server — sourced by `deploy.sh` steps 3 and 4 to supply `DATABASE_URL` (the *owner* role) for migrations and RLS verification. This is a different credential from the one the API runs as.
- **The nginx configuration.** Nothing in the repo describes it. Same-origin serving is inferred from `apps/web/src/lib/api.ts:10-12` and from `deploy.sh:84-85`, which fetches both `https://easycarty.store/` and `https://easycarty.store/api/me`.
- **The pm2 ecosystem file.** `deploy.sh:70` restarts `qvm-api` by name; nothing defines it in the repo.
- **The production Docker Compose file or override.** `infra/docker-compose.yml` mounts `./data/postgres` (line 16), which resolves to `infra/data/postgres` — that is the local dev volume, and it is what `PROTECT`'s `infra/data` entry covers. The incident and the deploy header name a *root-level* `pgdata/`. Those are different paths. The production compose definition is not in the repo — treat `infra/docker-compose.yml` as the **local dev** stack its own header says it is (line 1).

Nginx, pm2, and the production compose file must be reconstructed from the server if it is ever rebuilt. That is a real operational gap.

---

## 3. `deploy.sh`, step by step

The script is 111 lines and runs under `set -euo pipefail` (line 11), so any unhandled non-zero status aborts the deploy.

One step label is wrong: line 36 prints `2/6` where every other label is `n/8`. Cosmetic — do not read it as a different phase.

### Step 1 — back up production *before* touching it (lines 27-34)

```
ssh <host> "docker exec qvm_postgres pg_dumpall -U qvm --roles-only > /root/qvm_roles_<stamp>.sql \
         && docker exec qvm_postgres pg_dump    -U qvm qvm_platform > /root/qvm_backup_<stamp>.sql \
         && ls -lh /root/qvm_roles_<stamp>.sql /root/qvm_backup_<stamp>.sql"
```

`<stamp>` is `date +%Y%m%d_%H%M%S`, so every deploy leaves a distinct pair of files in `/root` on the production VPS. The trailing `ls -lh` prints the sizes so a zero-byte dump is visible instead of silent.

**Why both files.** The comment at lines 28-30 records the reason, learned during the same incident: a plain `pg_dump` restores the **data** but not the cluster **roles**. Restore data alone and every `GRANT` fails with `role qvm_app does not exist` — while drizzle sees `0002_app_role.sql` already recorded in its migrations table and will not recreate the role. The result is a database that restores "successfully" and an API that cannot connect. `pg_dumpall --roles-only` is what closes that.

**Why before migrating.** Migrations in this project are one-way; there are no down-migrations (`apps/api/drizzle.config.ts:3`, citing `CONVENTIONS §DB-7`). The dump is the only rollback that exists.

Note this step is a plain `&&` chain inside one `ssh`. If either dump fails, `set -e` aborts the deploy before anything is written to the server.

### Step 2 — sync source (lines 36-39)

```
rsync -az --delete <excludes> "$HERE/" "$HOST:$REMOTE/"
```

The exclude list is built from two arrays (lines 19-23):

```
PROTECT   = (pgdata  .env  apps/api/start.sh  apps/web/dist  infra/data  .git)   → --exclude "/<p>"
UNANCHORED= (node_modules)                                                        → --exclude "<p>"
```

| Excluded | Anchored? | Why |
|---|---|---|
| `pgdata` | yes | **the Postgres data directory on the server.** `--delete` removing it destroys the database. This is the entry the incident is about. |
| `.env` | yes | server-side configuration; the laptop's copy points at localhost |
| `apps/api/start.sh` | yes | pm2's entrypoint and the API's production environment |
| `apps/web/dist` | yes | shipped separately in step 5; excluding it here stops the source sync from wiping the currently-served bundle mid-deploy |
| `infra/data` | yes | local Postgres/MinIO volumes — gigabytes of laptop state that must never reach the server |
| `.git` | yes | the working tree is what ships; history is not needed on the box |
| `node_modules` | **no** | must match at **any** depth |

The leading `/` on the `PROTECT` entries anchors them to the transfer root, so `--exclude "/pgdata"` protects `<root>/pgdata` specifically rather than any directory named `pgdata` anywhere in the tree.

`node_modules` is deliberately **unanchored** (comment at lines 20-22): pnpm creates a symlink farm in `apps/*/node_modules` pointing into the root `.pnpm` store. Shipping the laptop's farm without its store leaves the server with dangling symlinks and unable to resolve a single import. So dependencies are never transferred — they are installed on the server instead.

**If you add a new prod-only path, add it to `PROTECT` in the same commit.** That array is the entire defence.

### Step 2b — install dependencies on the server (lines 41-42)

```
corepack pnpm install --frozen-lockfile --prod=false
```

`--frozen-lockfile` makes `pnpm-lock.yaml` — which *is* transferred — the source of truth, and fails rather than silently resolving a different tree than the one you tested against. `--prod=false` is required because the deploy uses `drizzle-kit` and `tsx` in steps 3 and 4, and both are devDependencies (`apps/api/package.json:36-37`).

### Step 3 — the orphaned-migration abort (lines 44-58)

A **local** Python pre-flight runs before migrations are applied:

```python
d = "apps/api/drizzle/migrations"
tags = {e["tag"] for e in json.load(open(f"{d}/meta/_journal.json"))["entries"]}
orphans = sorted(f[:-4] for f in os.listdir(d) if f.endswith(".sql") and f[:-4] not in tags)
if orphans:
    sys.exit("ABORT: migration(s) missing from meta/_journal.json, drizzle would skip them: " + ...)
```

**Why this exists** (comment at lines 45-48). Drizzle discovers migrations *only* through `meta/_journal.json`. A `.sql` file sitting in the migrations directory with no journal entry is **never opened**, and `drizzle-kit migrate` **still exits 0**. A forgotten journal entry therefore ships as a completely green deploy against a schema that was never altered — and the failure surfaces later as 500s from the API querying columns that do not exist.

Migrations `0036`–`0043` were hand-written rather than generated — `0044_snapshot_sync.sql` says so in its own header, and is itself an intentional no-op (`SELECT 1;`) whose only deliverable is a refreshed drizzle snapshot. Hand-written migrations are exactly the ones that get journalled by hand and forgotten.

Current state, verified: **50 `.sql` files, 50 journal entries, 0 orphans.** Latest is `0049_workflow_custody`.

An abort here leaves the new source already on the server and its dependencies installed (steps 2 and 2b have run) but the API process **not yet restarted** — the restart is step 6. Production keeps serving the old code. That ordering is lucky rather than designed, but it means a failed pre-flight is not an outage.

Then, over ssh:

```
cd $REMOTE && set -a && . ./.env && set +a && cd apps/api && npx drizzle-kit migrate
```

`set -a` exports everything the `.env` defines so `drizzle.config.ts:9` can read `DATABASE_URL` from the process environment. Migrations run as the **owner** role, not `qvm_app`.

### Step 4 — verify RLS before letting traffic in (lines 62-63)

```
npx tsx scripts/verify-rls.ts
```

`apps/api/scripts/verify-rls.ts` queries every base table in the `public` schema (`relkind='r'`, line 39) and exits 1 if any of them:

1. has RLS **disabled** (line 50);
2. has RLS enabled but **zero policies** — which silently blocks `qvm_app` from the table entirely (line 52);
3. carries `tenant_id` without `FORCE ROW LEVEL SECURITY` (line 53), or carries `tenant_id` with no policy whose `qual`/`with_check` mentions `current_tenant_id` (lines 54-55);
4. carries an `environment` column without a **RESTRICTIVE** policy mentioning `current_environment` (lines 56-57). `order_number_counters` is the one hard-coded exemption (line 47), because it carries `environment` only as part of its unique key and `next_order_number()` must read the row it is bumping.

**Why it runs before the restart.** Its own header (lines 1-4) names the incident: new tables are born fully open to `qvm_app` via the default ACL, and the original policy loop in `0001_security_functions.sql` (lines 30-36) only covered tables that existed at that moment. `platform_audit` slipped through exactly that way — created in `0029` with no RLS at all, giving `qvm_app` unrestricted cross-tenant read/write/delete on the admin audit ledger until `0034_audit_hardening.sql` closed it. A migration that adds a table and forgets `apply_tenant_rls()` produces no error — it produces a tenancy leak. This step is the only thing standing between that mistake and production traffic.

The RESTRICTIVE requirement in check 4 is not pedantry (`verify-rls.ts:12-14`): permissive policies are OR-ed, and the generated `tenant_isolation` policy is literally `using (tenant_id = current_tenant_id() or app_is_internal())` (`0001_security_functions.sql:33-35`). A permissive environment policy would be OR-ed with that `app_is_internal()` escape and bypassed in exactly the cross-workspace portals where the Live/Sandbox boundary matters most.

One small drift worth knowing: the file's own docstring (line 9) says "RLS disabled or not FORCEd", but the `forced` check on line 53 only applies to tables that carry `tenant_id`. Global tables are not required to FORCE.

### Step 5 — build and ship the web bundle (lines 65-67)

```
corepack pnpm --filter @qvm/web build
rsync -az --delete "$HERE/apps/web/dist/" "$HOST:$REMOTE/apps/web/dist/"
```

The bundle is built **on the developer's machine**, not the server. `--delete` here is scoped to `apps/web/dist/` on both sides, so stale hashed assets from the previous build are removed. This is why `apps/web/dist` is in `PROTECT` for step 2 — the source sync must not touch it, this step owns it.

`apps/web/package.json:9` defines `build` as `tsc -b && vite build`, so a TypeScript error fails the deploy here.

### Step 6 — restart and poll for readiness (lines 69-77)

```
pm2 restart qvm-api --update-env && pm2 list | grep qvm-api
```

`--update-env` makes pm2 re-read the environment from the entrypoint rather than reusing the process's cached copy — without it, a change to `start.sh` would not take effect on restart. The `grep` is not decoration: if `qvm-api` is absent from `pm2 list`, grep exits 1, ssh propagates it, and `set -e` aborts.

Then a readiness poll:

```bash
for i in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' https://easycarty.store/api/me)" = "401" ] && { printf ' up\n'; break; }
  printf '.'; sleep 2
done
```

**Why polling and not `sleep`** (comment at lines 71-72): Nest takes roughly 10 seconds to boot. A fixed 5-second wait once made step 7 report a spurious 502 and abort a perfectly good deploy. The poll waits up to 20 × 2 s ≈ 40 s.

**Why `401` is the success condition.** `GET /api/me` is guarded, so an unauthenticated request returning 401 proves the whole stack is up: nginx is proxying, the process is listening, Nest's DI graph resolved, and `AuthGuard` is running (`auth.guard.ts:35` throws `missing bearer token`). A 200 would mean auth is *not* being enforced; a 502 means the process is not there.

The loop has no failure branch — if the API never comes up, it simply falls through after 40 s. The failure is caught by step 7.

### Step 7 — HTTP checks that fail the deploy (lines 78-85)

```bash
check "SPA loads"       200 https://easycarty.store/
check "API alive (401)" 401 https://easycarty.store/api/me
```

`check()` returns 1 on a mismatch, and under `set -e` that aborts the script. The step's own banner spells out the intent: *"these MUST fail the deploy, not just print"* — a check that only prints a red line is a check nobody reads.

### Step 8 — behavioural regression suite against production (lines 87-98)

```bash
set -a; [ -f "$HERE/.env" ] && . "$HERE/.env"; set +a
export PROD_SSH="${PROD_SSH:-$HOST}"
if [ -z "${SMOKE_ADMIN_PASS:-}" ] || [ -z "${SMOKE_MANAGER_PASS:-}" ]; then
  echo "  SKIPPED: ..."
else
  bash "$HERE/apps/api/scripts/smoke-prod.sh"
fi
```

**Why it runs locally and not on the server** (comment at lines 88-90): `smoke-prod.sh`'s `rpsql()` helper (`smoke-prod.sh:8`) does `ssh "$PROD_SSH" "docker exec qvm_postgres psql ..."`. Executed *on* the box, every database assertion fails with `Host key verification failed`.

**Why the credentials come from the environment.** `smoke-prod.sh:9-12` explains: the script talks to production, so a password committed in a tracked file is a live credential in version control — and it stays in git history long after anyone rotates it. The script aborts without `PROD_SSH` (line 14) and without `SMOKE_ADMIN_PASS` / `SMOKE_MANAGER_PASS` (lines 17-20), and `deploy.sh` **skips rather than fails** if the passwords are absent, so a deploy without them still completes.

What `smoke-prod.sh` actually asserts against the live system:

| Section | Checks | Lines |
|---|---|---|
| Schema & policies | `counterparty_type` on `vendors`+`workshops`, 6 dedup indexes, 2 staging tables with RLS, `directory_read` present and the old `global_read` gone on `vendors`/`workshops` | 30-34 |
| Dedup behaviour | duplicate company tax number and duplicate individual mobile are rejected, cross-scope duplicates allowed — run inside `BEGIN … ROLLBACK`, so **nothing persists** | 37-43 |
| Governance guards | a manager gets 403 on `POST /vendors`, `POST /org/workshops`, `GET /vendors/available`, `GET /counterparty/review`, and 200 on `GET /vendors` | 46-50 |
| Submit → reject | a real submission is created, checked for candidate-name leakage, seen by admin review, rejected — then the `vendors` row count is compared before and after to prove no directory write happened | 53-61 |
| Live/Sandbox boundary | live count > 0, sandbox count = 0, **no header behaves as live**, `/me` echoes the resolved environment both ways, every `environment` table carries the RESTRICTIVE policy on prod, and `is_sandbox` no longer exists anywhere | 63-81 |
| Cleanup | deletes the verification submission by its tax number | 84-85 |

The comment at lines 64-66 explains why the boundary must be asserted *through nginx*: if the proxy ever strips `X-Environment`, `resolveEnvironment()` (`request-context.ts:20-22`) fails open to `live` and a user who believes they are in Sandbox writes real data.

Three things to be aware of. First, this suite **writes to production** (a submission is created, then rejected, then deleted). It is prod-safe by construction, not read-only. Second, it authenticates as two fixture accounts, defaulting to `admin@qparts.local` and `manager@qparts.local` (`smoke-prod.sh:15-16`) — those accounts therefore exist on production with real passwords. Third, it does not run under `set -e`: it tallies PASS/FAIL and exits 1 at the end (line 89).

It also runs **after** traffic is already live. It is a post-deploy regression detector, not a gate.

---

## 4. Restore runbook

Printed by `deploy.sh` at the end of every run (lines 101-111). Reproduced here with the gaps in the printed version filled in.

If `pgdata` is lost, or a migration has to be rolled back to a known-good dump:

```bash
# 1. ROLES FIRST — before any data.
docker exec -i qvm_postgres psql -U qvm -d postgres < /root/qvm_roles_<stamp>.sql

# 2. Drop the damaged database.
docker exec qvm_postgres psql -U qvm -d postgres -c 'drop database qvm_platform;'

# 3. Recreate it, owned by qvm.
docker exec qvm_postgres psql -U qvm -d postgres -c 'create database qvm_platform owner qvm;'

# 4. Restore the data.
docker exec -i qvm_postgres psql -U qvm -d qvm_platform < /root/qvm_backup_<stamp>.sql

# 5. Bring the schema forward. The dump carries its own drizzle migration rows,
#    so this applies only what is genuinely newer than the backup.
cd /var/www/easycarty && set -a && . ./.env && set +a && cd apps/api && npx drizzle-kit migrate

# 6. Restart the API.
pm2 restart qvm-api
```

**Note on step 5.** The version printed by `deploy.sh:108` is just `cd apps/api && npx drizzle-kit migrate`, with no `. ./.env`. Run as printed, `drizzle.config.ts:9` falls back to its hardcoded local default (`localhost:5432`, placeholder password) and the migrate fails or targets the wrong database. Source the server `.env` first, as above.

**Step 1 is not optional and the ordering matters.** If you skip it, the `GRANT`s in step 4 fail (`role qvm_app does not exist`) and the API cannot authenticate. Worse, `drizzle-kit migrate` in step 5 sees `0002_app_role.sql` already recorded in the restored migrations table and will not re-create the role — so the problem does not self-heal.

If step 1 *was* skipped, the recovery is to set the password manually. `deploy.sh:110`:

```
alter role qvm_app with login password '<the value from apps/api/start.sh>';
```

Take the value from `apps/api/start.sh` on the production VPS. Do not invent one — the API reads it from `APP_DATABASE_URL` in that same file, and the two must match. Note that `0002_app_role.sql:6` creates the role with a hardcoded *development* password; production must have had it changed, and `start.sh` is the only record of what it is.

**Verify before you declare it done:**

```bash
cd /var/www/easycarty && set -a && . ./.env && set +a && cd apps/api && npx tsx scripts/verify-rls.ts
```

A restore that misses roles or policies produces a database that looks fine and leaks across tenants.

---

## 5. Environment variables

**Names only.** Never commit a value. `.gitignore:12-14` excludes `.env` and `.env.*` while keeping `.env.example`, which contains placeholders. `.env.example` is the template — `cp .env.example .env` and fill it in.

### Read by the API at runtime

| Variable | Read at | Behaviour |
|---|---|---|
| `API_PORT` | `src/main.ts:11` | listen port; defaults to 4000 |
| `APP_DATABASE_URL` | `src/db/db.service.ts:34` | **the most consequential variable in the system.** Must point at the non-superuser `qvm_app` role. A superuser or the table owner bypasses RLS entirely, and nothing fails loudly — tenancy silently stops being enforced |
| `APP_ROOT_DOMAIN` | `src/common/auth.guard.ts:14` | root domain for `<slug>.<root>` workspace resolution; defaults to `qvm.localhost` |
| `JWT_SECRET` | `src/modules/auth/auth.module.ts:10-13` | **throws on boot if unset when `NODE_ENV === "production"`.** Outside production it falls back to a hardcoded dev string |
| `JWT_EXPIRES_IN` | `src/modules/auth/auth.module.ts:21` | token TTL; defaults to `1d` |
| `IMPERSONATION_TTL` | `src/modules/admin/impersonation.service.ts:92` | "view as" token TTL; defaults to `30m`. **Not present in `.env.example`** |
| `NODE_ENV` | `auth.module.ts:12`, `notifications/notifications.service.ts:46`, `rfq/vendor-rfq.service.ts:107` | exactly three call sites: gates the JWT-secret requirement, real notification dispatch, and whether raw vendor quote tokens are echoed in API responses |
| `EMAIL_PROVIDER` | `src/modules/notifications/notifications.service.ts:75` | any value other than `console` marks the email channel as provider-enabled; defaults to `console` |
| `WHATSAPP_ENABLED` | `src/modules/notifications/notifications.service.ts:76` | `"true"` marks the WhatsApp channel enabled |
| `AI_PROVIDER` | `src/common/ai.service.ts:19-21` | defaults to `off`. The assistant is enabled **only** when this is `gemini` *and* `GEMINI_API_KEY` is set. **Only the `gemini` branch is implemented** despite `.env.example:41` listing `claude` |
| `GEMINI_API_KEY` | `src/common/ai.service.ts:21, 67` | required for the workflow-canvas assistant. `.env.example:42` notes it should be appended to the server `.env` only, never committed |
| `GEMINI_MODEL` | `src/common/ai.service.ts:66` | defaults to `gemini-2.0-flash` |

### Read by tooling, not by the running API

| Variable | Read at | Purpose |
|---|---|---|
| `DATABASE_URL` | `drizzle.config.ts:9`, `scripts/verify-rls.ts:19`, `drizzle/seed/index.ts:15` | the **owner** role. Migrations, RLS verification, and seeding. Deliberately different from `APP_DATABASE_URL` |
| `SEED_I_KNOW_THIS_IS_NOT_LOCAL` | `drizzle/seed/index.ts:31` | see §7 |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | `infra/docker-compose.yml:9-14` | local Postgres container |
| `S3_ACCESS_KEY`, `S3_SECRET_KEY` | `infra/docker-compose.yml:29-30` | MinIO root credentials. Used by compose **only** — no API code reads them |

### Build-time, web

| Variable | Read at | Purpose |
|---|---|---|
| `VITE_API_URL` | `apps/web/src/lib/api.ts:12` | `VITE_API_URL \|\| (import.meta.env.PROD ? "" : "http://localhost:4000")`. In a production build it resolves to `""` → same-origin, nginx proxies `/api`. The `\|\|` (not `??`) is deliberate so an *empty* value also falls through to the mode default |

Subtlety worth knowing: `apps/web` has no `.env` of its own and `vite.config.ts` sets no `envDir`, so Vite loads env files from `apps/web/` only. The `VITE_API_URL=http://localhost:4000` line in the repo-root `.env.example` is therefore **not** picked up by `vite build` — which is why production builds correctly get `""`. Add an `apps/web/.env` and that stops being true.

### Used by `deploy.sh` and `smoke-prod.sh`

`QVM_HOST`, `QVM_REMOTE`, `PROD_SSH`, `SMOKE_ADMIN_PASS`, `SMOKE_MANAGER_PASS`, `SMOKE_ADMIN_EMAIL`, `SMOKE_MANAGER_EMAIL`, `SMOKE_BASE`. None appear in `.env.example`; the smoke credentials are read from your local `.env`, which git ignores.

Note that `deploy.sh:13` gives `QVM_HOST` a **hardcoded default value** naming the production host. Setting `QVM_HOST` in your environment overrides it. Removing the default would be an improvement.

### Declared in `.env.example` but read by nothing

`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `PAYMENT_MODE`. Verified by grep across `apps/api/src`, `apps/web/src`, and `packages/` — zero hits. There is no upload or attachment code in the repo (no `multer`, no `FileInterceptor`, no S3 client dependency) and no payment integration. The MinIO container in `infra/docker-compose.yml` starts but nothing talks to it.

Also note `.env.example:29` claims "the notifications layer guards on `is_sandbox`". That comment is **stale** — `tenants.is_sandbox` was dropped in `0042_retire_sandbox_workspace.sql`, and `smoke-prod.sh:81` asserts the column no longer exists anywhere. The guard is now the per-call `environment` value plus `NODE_ENV` (`notifications.service.ts:44-47`).

---

## 6. The Docker Postgres container

Defined for local dev in `infra/docker-compose.yml`. Production runs a container with the same name (`qvm_postgres`), same DB user (`qvm`), and same database (`qvm_platform`) — that is what every `docker exec` in `deploy.sh` and `smoke-prod.sh` assumes — but as noted in §2, the production compose definition itself is not in the repo, and the data directory it mounts is named `pgdata` rather than `infra/data/postgres`.

```yaml
postgres:
  image: postgres:16-alpine
  container_name: qvm_postgres
  restart: unless-stopped
  ports: ["${POSTGRES_PORT:-5433}:5432"]
  volumes: ["./data/postgres:/var/lib/postgresql/data"]
  healthcheck: pg_isready every 5s, 10 retries
```

`deploy.sh` never runs `docker compose` against production. The container is managed by hand on the server; the script only `docker exec`s into it.

### Port confusion — set `POSTGRES_PORT` explicitly

There are three different defaults in the repo and they disagree:

| Default | Where |
|---|---|
| **5433** | `infra/docker-compose.yml:14` |
| **5434** | `.env.example:5, 6, 8`, `db.service.ts:35`, `verify-rls.ts:19`, `seed/index.ts:15` |
| **5432** | `drizzle.config.ts:9` |

`.env.example` ships `POSTGRES_PORT=5434`, so a correctly copied `.env` makes compose publish 5434 and everything lines up. If you *omit* `POSTGRES_PORT`, compose binds 5433 while every code-level fallback looks for 5434 and drizzle-kit looks for 5432, and nothing connects. Always set it.

### Two roles, and why

`apps/api/drizzle/migrations/0002_app_role.sql` creates `qvm_app` — a plain `LOGIN` role with `SELECT/INSERT/UPDATE/DELETE` on all tables plus default privileges for future ones (lines 9-15). Its header states the rule bluntly:

> superusers/owner bypass RLS; the API must NOT use the owner role. Migrations/seed only.

| Role | Used by | Connection string |
|---|---|---|
| `qvm` (owner) | `drizzle-kit migrate`, `verify-rls.ts`, seed, `psql` for ops | `DATABASE_URL` |
| `qvm_app` (non-superuser) | the running API | `APP_DATABASE_URL` |

`DbService` connects with `postgres(url, { max: 10 })` (`db.service.ts:36`) and opens a transaction per request, setting five session GUCs in one `set_config` call (`db.service.ts:43-48`): `app.tenant_id`, `app.user_id`, `app.is_internal`, `app.environment`, `app.impersonator_id`. The `true` third argument to `set_config` is what makes them transaction-local, so they cannot leak across pooled connections. `app.impersonator_id` is written but has no reader yet — the comment on line 48 says so.

**If `APP_DATABASE_URL` is ever pointed at the owner role, every RLS policy in the database silently stops applying.** No error, no log line. This is the single highest-consequence configuration fact in the system.

---

## 7. Seeding — and the guard that stops you destroying production

`pnpm db:seed` runs `apps/api/drizzle/seed/index.ts`, which **truncates every table** and reinserts fixtures with publicly-known passwords.

Because the repo is rsynced to the server, both the seed script and a production `.env` sit next to each other on the production VPS. One `pnpm db:seed` in the wrong directory would replace production with fixtures. Lines 17-37 guard against exactly that:

```ts
const isLocal = ["localhost","127.0.0.1","::1","0.0.0.0","host.docker.internal"].includes(host);
if (!isLocal && process.env.SEED_I_KNOW_THIS_IS_NOT_LOCAL !== "yes") {
  console.error(`REFUSING TO SEED: '${host}' is not a local database, and seeding TRUNCATES everything.`);
  process.exit(1);
}
```

`host` is the hostname parsed out of `DATABASE_URL` (lines 23-29). The escape hatch is deliberately verbose. If you find yourself typing `SEED_I_KNOW_THIS_IS_NOT_LOCAL=yes`, stop and confirm the host in `DATABASE_URL` first.

---

## 8. pm2

The API is a single pm2 process, `qvm-api`.

```bash
pm2 list                       # is it up, how many restarts
pm2 restart qvm-api --update-env
pm2 describe qvm-api           # entrypoint, cwd, log paths, uptime, memory
pm2 stop qvm-api
```

`--update-env` is what `deploy.sh:70` uses; it forces pm2 to re-read the environment rather than reuse the previous process's copy. Without it, a change in `start.sh` does not take effect.

A restart count that climbs on its own means the process is crash-looping — check the logs before restarting again.

---

## 9. Reading logs

The repo contains no logging configuration, no ecosystem file, and no log-shipping setup. These are the standard pm2 and Docker commands, not something the project defines.

**API:**

```bash
pm2 logs qvm-api                  # follow
pm2 logs qvm-api --lines 200      # recent history
pm2 logs qvm-api --err            # stderr only
pm2 flush qvm-api                 # truncate
pm2 describe qvm-api              # shows the actual log file paths
```

On boot the API prints `[qvm-api] listening on http://localhost:<port>/api` (`main.ts:14`). If that line is missing, Nest never finished bootstrapping — the usual cause is `JWT_SECRET must be set in production` thrown from `auth.module.ts:12`.

**Postgres:**

```bash
docker logs qvm_postgres
docker logs --tail 200 -f qvm_postgres
docker exec qvm_postgres pg_isready -U qvm -d qvm_platform
```

**Interactive SQL on production** (read-only investigation; be careful):

```bash
docker exec -it qvm_postgres psql -U qvm -d qvm_platform
```

### What you will and will not find in the logs

Two things are worth setting expectations about.

**Notifications are logged, not sent.** `apps/api/src/modules/notifications/notifications.service.ts:61-65`:

```ts
if (status === "sent") {
  // real provider dispatch goes here (SMTP/WhatsApp/webhook), using `secret` for the link.
  void secret;
  this.logger.log(`SEND ${input.channel} → ${input.recipient} [${input.template}]`);
}
```

There is no SMTP, WhatsApp, or webhook client anywhere in `apps/api`. A `SEND email → …` line in the pm2 log means a row was written to `notification_log` with `status = 'sent'` and a log line was printed. **Nothing left the process.** The vendor quote-access link — the only way a vendor without a portal account can quote (`apps/api/src/modules/rfq/quote-access.controller.ts`) — is generated, passed to `NotificationsService` as the `secret` argument (`vendor-rfq.service.ts:102`), and discarded. In non-production the raw token is echoed back in the API response for testing; in production it is not (`vendor-rfq.service.ts:107`).

**Application-level auditing lives in the database, not the logs.** `platform_audit` is written by the admin surfaces — impersonation start/stop, user admin, workspace admin, platform-staff changes, and counterparty review (`src/modules/admin/*.service.ts`, `src/modules/counterparty/counterparty.service.ts`) — and `0034_audit_hardening.sql` makes it append-only for `qvm_app` (read policy internal-only, insert policy internal-or-own-tenant, **no** update or delete policy at all). `status_logs` records every status transition written through `StatusService` (`src/common/status.service.ts:143`). Query those, not `pm2 logs`, when you need to reconstruct what a user did.

---

## 10. Local development

```bash
cp .env.example .env          # POSTGRES_PORT=5434 is already correct; fill in the passwords
corepack pnpm install
corepack pnpm db:up           # docker compose -f infra/docker-compose.yml up -d
corepack pnpm db:migrate      # drizzle-kit migrate, as the owner role
corepack pnpm db:seed         # fixtures (truncates first)
corepack pnpm dev             # api on 4000, vite on 5200
```

Requirements from the root `package.json`: **Node ≥ 22**, pnpm 9.15.0 via corepack, Docker. The web dev port is set in `apps/web/vite.config.ts:6`.

### Do not run the API with `tsx`

From `apps/api/README.md:9-10`: esbuild does not emit `emitDecoratorMetadata`, which breaks Nest's dependency injection. The dev script (`apps/api/package.json:8`) is deliberately

```
node --import @swc-node/register/esm-register src/main.ts
```

Seeds and migrations use `tsx`/`drizzle-kit` normally — they have no decorators.

### The dev server has no hot-reload

That command has no watcher. `scripts/smoke.sh:16-27` compares the running process's start time against the newest `.ts` mtime under `src/` and `drizzle/`, and **aborts** rather than reporting results:

> `ABORT: the running API started before the newest source edit — restart it, or these results are fiction.`

The comment notes this has already produced a false green once. Restart the API manually after every backend edit.

---

## 11. Test scripts

There is **no unit-test framework** in this repo — no jest, no vitest, no `*.spec.ts`, and no `.github/` directory of any kind. All verification is bash + curl + psql.

| Script | Command | What it does |
|---|---|---|
| `apps/api/scripts/verify-rls.ts` | `pnpm --filter @qvm/api db:verify` | the RLS/environment invariant check. Runs in the deploy. Run it after **every** migration |
| `apps/api/scripts/smoke.sh` | `pnpm --filter @qvm/api test:smoke` | self-described 88-check end-to-end suite (`smoke.sh:2`) against a **freshly seeded local** stack. Shells out to `docker exec psql`, so the container must be running. Exits non-zero on any FAIL |
| `apps/api/scripts/guard-check.sh` | invoked as `bash …/guard-check.sh` from `smoke.sh:306` | drives a full RFQ → send → quote → pick-winner chain twice, proving the workflow guard both stays out of the way when unconfigured (line 65) and bites when configured (line 78). Also checks the freeze-trigger column tuple via `pg_proc.prosrc` (lines 94-96, 225), page routing by `?queue=` (lines 172-194), the three custody handoff modes (lines 215-217), SLA `due_at` (line 220), the `my-work` endpoint (line 229), and that no migration is orphaned from `_journal.json` (lines 104-109) |
| `apps/api/scripts/smoke-prod.sh` | `pnpm --filter @qvm/api test:smoke:prod` | the production variant. Refuses to run without `PROD_SSH`, `SMOKE_ADMIN_PASS`, `SMOKE_MANAGER_PASS` |

`test:smoke` reseeds first (`tsx drizzle/seed/index.ts > /dev/null && bash scripts/smoke.sh`), so it destroys your local data every run. That is intentional — the assertions depend on known fixture state.

Note `guard-check.sh` is not marked executable in the repo; it is always invoked via `bash`, so this is harmless but easy to trip over if you try to run it directly.

---

## 12. Adding a migration — the deploy-relevant checklist

Most production incidents in this project trace back to a migration. Before you run `deploy.sh`:

1. **Journal it.** Every `.sql` in `apps/api/drizzle/migrations/` needs an entry in `meta/_journal.json`. The deploy aborts otherwise (§3, step 3) — but only after the source has already shipped.
2. **Call `apply_tenant_rls()` or `apply_global_rls()` on every new table.** The `0001_security_functions.sql` policy loop was one-shot and covers only tables that existed then. `verify-rls.ts` is the backstop, and it runs in the deploy, but catching it locally is cheaper.
3. **Run `pnpm --filter @qvm/api db:verify` locally.** Same check the deploy runs.
4. **Run `pnpm --filter @qvm/api test:smoke` locally.** Restart the API first, or the staleness guard will (correctly) abort.
5. **After a hand-written migration, write a snapshot-sync no-op.** This was the standing hazard here for nineteen migrations: the snapshot chain stalled at `0047` while `0048`–`0066` were hand-written, seventeen columns existed in the database and in no schema file, and `db:generate` emitted 23 bare `ADD COLUMN`s for columns that already existed — SQL that dies on the first statement. `0067_snapshot_sync.sql` closed it, and its header is the worked example of the discipline: verify every statement the diff wants against the live database *before* emptying the file, and enumerate what you checked. `guard-check.sh` now asserts the three-way agreement (schema `.ts` ↔ newest snapshot ↔ live database) over the workflow tables, so the next stall fails the suite instead of waiting for whoever runs `generate`. Today `db:generate` prints "No schema changes, nothing to migrate" — if it prints anything else, something has drifted since.

---

## 13. Known operational gaps

Stated plainly, because a deployment document that hides them is worse than none.

| Gap | Detail |
|---|---|
| **nginx, pm2, and the production compose file are not in the repo** | Verified by grep: the only occurrences of "nginx" or "pm2" anywhere are comments. If the production VPS is lost, the application code and database can be restored from backups, but the serving layer must be rebuilt from memory |
| **`apps/api/start.sh` is prod-only and unversioned** | No file by that name exists anywhere in the tree. It holds the API's entire runtime environment — no copy, no template, no documentation of its contents |
| **The printed restore runbook omits sourcing `.env`** | `deploy.sh:108`'s `drizzle-kit migrate` would fall back to `drizzle.config.ts`'s localhost default. See §4 |
| **Notifications never dispatch** | `NotificationsService` writes the `notification_log` row and prints a line. No SMTP/WhatsApp/webhook client exists. Emailed vendor quote links are generated and thrown away in production |
| **No CI** | No `.github/`, no pipeline. `verify-rls.ts` and the smoke suites only run when a human runs them, or as part of `deploy.sh` |
| **No linter configuration** | The root `lint` script calls `pnpm --recursive lint`; no package (`@qvm/api`, `@qvm/web`, `@qvm/shared`) defines a `lint` script, so it is a no-op |
| **CORS is fully open** | `main.ts:8` is `NestFactory.create(AppModule, { cors: true })`. No origin allowlist |
| **No rate limiting and no helmet** | Neither `@nestjs/throttler` nor `helmet` appears in any `package.json`. The public `POST /api/quote-access/:token/quote` endpoint (`quote-access.controller.ts:13`) is unauthenticated and unthrottled |
| **`QVM_HOST` has a committed default naming the production host** | `deploy.sh:13` |
| **Fixture accounts exist on production** | `smoke-prod.sh:15-16` defaults to two `@qparts.local` accounts and authenticates as them against the live site |
| **The production smoke suite writes to production** | Submit → reject → cleanup. Safe by construction, but not read-only |
| **`0002_app_role.sql` commits a development password for `qvm_app`** | Line 6. Fine locally; production must have had it rotated, and only `start.sh` records what to |
| **Root `README.md` and `apps/api/README.md` are stale** | Both are in Arabic and describe Phase 0 / Phase 2a — the API README lists three modules. There are 29 module directories under `apps/api/src/modules` and 50 migrations |
| **`ADR-0011` is cited in four places but does not exist** | Referenced in `apps/api/src/modules/rfq/rfq.service.ts:43`, `drizzle/seed/index.ts:148,158`, and `drizzle/schema/org.ts:11`. `docs/decisions/` contains `0001`–`0010` and `0012` only |
| **The reserved-subdomain list is duplicated** | `apps/api/src/common/request-context.ts:24` and `apps/web/src/lib/tenant.ts:12`. They agree today; nothing enforces it |