#!/usr/bin/env bash
# deploy.sh — the ONLY supported way to ship qvm-platform to production.
#
# WHY THIS FILE EXISTS (2026-07-25 incident):
# a hand-written `rsync -az --delete` wiped three prod-only paths that do not exist in the repo:
#   • pgdata/                 → the POSTGRES DATA DIRECTORY. Docker recreated it empty and Postgres
#                               re-initialised from scratch. The entire database was lost.
#   • apps/api/start.sh       → pm2's entrypoint, holding the production environment.
#   • .env                    → the compose/runtime secrets.
# It was recoverable only because a pg_dump had been taken minutes earlier. Never deploy by hand.
set -euo pipefail

HOST=${QVM_HOST:-root@145.14.158.129}
REMOTE=${QVM_REMOTE:-/var/www/easycarty}
HERE=$(cd "$(dirname "$0")" && pwd)

# Paths that live ONLY on the server. --delete would destroy them; they must never be transferred.
# NOTE: a leading "/" anchors to the transfer root, so these are ROOT-relative.
PROTECT=(pgdata .env apps/api/start.sh apps/web/dist infra/data .git)
# node_modules must match at ANY depth: pnpm puts a symlink farm in apps/*/node_modules that points
# into the root .pnpm store. Pushing the laptop's farm without its store leaves prod unable to resolve
# anything, so we never transfer them and run a real install on the server instead.
UNANCHORED=(node_modules)

say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1/8  backing up production first (never migrate without one)"
# BOTH files are required. A plain pg_dump restores the DATA but not the cluster ROLES, and every
# GRANT then fails with "role qvm_app does not exist" — while drizzle sees 0002_app_role.sql already
# recorded and will not recreate it, so the API cannot start. Learned the hard way on 2026-07-25.
STAMP=$(date +%Y%m%d_%H%M%S)
ssh "$HOST" "docker exec qvm_postgres pg_dumpall -U qvm --roles-only > /root/qvm_roles_$STAMP.sql \
  && docker exec qvm_postgres pg_dump    -U qvm qvm_platform > /root/qvm_backup_$STAMP.sql \
  && ls -lh /root/qvm_roles_$STAMP.sql /root/qvm_backup_$STAMP.sql"

say "2/6  syncing source"
EXCL=(); for p in "${PROTECT[@]}";   do EXCL+=(--exclude "/$p"); done
        for p in "${UNANCHORED[@]}"; do EXCL+=(--exclude "$p");  done
rsync -az --delete "${EXCL[@]}" "$HERE/" "$HOST:$REMOTE/"

say "2b/8  installing dependencies on the server (the lockfile is the source of truth)"
ssh "$HOST" "cd $REMOTE && corepack pnpm install --frozen-lockfile --prod=false 2>&1 | tail -3"

say "3/8  applying migrations"
# drizzle discovers migrations ONLY through meta/_journal.json — a .sql file with no entry there is
# never opened, and `migrate` still exits 0. That means a forgotten journal entry ships as a green
# deploy against a schema that was never altered, and the API 500s on the columns it now queries.
# Refuse to deploy rather than find out from production.
/usr/bin/python3 - <<'PYCHECK'
import json, os, sys
d = "apps/api/drizzle/migrations"
tags = {e["tag"] for e in json.load(open(f"{d}/meta/_journal.json"))["entries"]}
orphans = sorted(f[:-4] for f in os.listdir(d) if f.endswith(".sql") and f[:-4] not in tags)
if orphans:
    sys.exit("ABORT: migration(s) missing from meta/_journal.json, drizzle would skip them: "
             + ", ".join(orphans))
print(f"  migrations: {len(tags)} journalled, 0 orphaned")
PYCHECK

ssh "$HOST" "cd $REMOTE && set -a && . ./.env && set +a && cd apps/api && npx drizzle-kit migrate"

say "4/8  verifying the RLS + environment invariants BEFORE letting traffic in"
ssh "$HOST" "cd $REMOTE && set -a && . ./.env && set +a && cd apps/api && npx tsx scripts/verify-rls.ts"

say "5/8  building + shipping the web bundle"
corepack pnpm --filter @qvm/web build
rsync -az --delete "$HERE/apps/web/dist/" "$HOST:$REMOTE/apps/web/dist/"

say "6/8  restarting the API"
ssh "$HOST" "pm2 restart qvm-api --update-env && pm2 list | grep qvm-api"
# Nest needs ~10s to boot; a 5s wait made step 7 report a spurious 502 and abort a good deploy.
# Poll for readiness instead of guessing, and fail only if it never comes up.
printf '   waiting for the API'
for i in $(seq 1 20); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' https://easycarty.store/api/me)" = "401" ] && { printf ' up\n'; break; }
  printf '.'; sleep 2
done
say "7/8  smoke-checking the live site (these MUST fail the deploy, not just print)"
check(){ # check <label> <expected-code> <url>
  local got; got=$(curl -s -o /dev/null -w '%{http_code}' "$3")
  if [ "$got" = "$2" ]; then printf '   ok   %-34s %s\n' "$1" "$got"
  else printf '   FAIL %-34s got %s want %s\n' "$1" "$got" "$2"; return 1; fi
}
check "SPA loads"          200 https://easycarty.store/
check "API alive (401)"    401 https://easycarty.store/api/me

say "8/8  behavioural regression suite against production"
# Run this from HERE, not on the server: smoke-prod.sh's rpsql() helper ssh's INTO the prod host,
# so executing it on the box makes every DB assertion fail with "Host key verification failed".
# smoke-prod.sh refuses to run unless the credentials are in the environment — they are no longer
# hardcoded in a tracked file. Take them from the local .env, which git ignores.
set -a; [ -f "$HERE/.env" ] && . "$HERE/.env"; set +a
export PROD_SSH="${PROD_SSH:-$HOST}"
if [ -z "${SMOKE_ADMIN_PASS:-}" ] || [ -z "${SMOKE_MANAGER_PASS:-}" ]; then
  echo "  SKIPPED: set SMOKE_ADMIN_PASS and SMOKE_MANAGER_PASS in .env to run the production smoke suite."
else
  bash "$HERE/apps/api/scripts/smoke-prod.sh"
fi

say "done — backup at /root/qvm_backup_$STAMP.sql + roles at /root/qvm_roles_$STAMP.sql"
cat <<'EOF'

RESTORE RUNBOOK (if pgdata is ever lost):
  1. docker exec -i qvm_postgres psql -U qvm -d postgres < /root/qvm_roles_<stamp>.sql   # roles FIRST
  2. docker exec qvm_postgres psql -U qvm -d postgres -c 'drop database qvm_platform;'
  3. docker exec qvm_postgres psql -U qvm -d postgres -c 'create database qvm_platform owner qvm;'
  4. docker exec -i qvm_postgres psql -U qvm -d qvm_platform < /root/qvm_backup_<stamp>.sql
  5. cd apps/api && npx drizzle-kit migrate      # the dump carries its own migration rows
  6. pm2 restart qvm-api
  If step 1 was skipped, qvm_app has no password: alter role qvm_app with login password '<from start.sh>';
EOF
