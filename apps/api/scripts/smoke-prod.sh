#!/usr/bin/env bash
# smoke-prod.sh — PROD-SAFE verification: confirms deployed schema/policies/guards WITHOUT
# writing to the directory (submit→reject only, then cleans up). Needs SSH to the prod host.
B=${SMOKE_BASE:-https://easycarty.store}
PASS=0; FAIL=0
ok(){ if [ "$1" = "$2" ]; then echo "  PASS | $3"; PASS=$((PASS+1)); else echo "  FAIL | $3  (got '$2' want '$1')"; FAIL=$((FAIL+1)); fi; }
jf(){ /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))"; }
rpsql(){ ssh "$PROD_SSH" "docker exec qvm_postgres psql -U qvm -d qvm_platform -tA -c \"$1\""; }
# Credentials come from the environment, never from this file. This script talks to PRODUCTION, so
# a password committed here is a live credential in version control — and it stays in git history
# long after anyone changes it. Export them for the run:
#   SMOKE_ADMIN_PASS=... SMOKE_MANAGER_PASS=... bash scripts/smoke-prod.sh
: "${PROD_SSH:=}"
if [ -z "$PROD_SSH" ]; then echo "ABORT: set PROD_SSH (e.g. user@host) — it is not hardcoded here."; exit 1; fi
: "${SMOKE_ADMIN_EMAIL:=admin@qparts.local}"
: "${SMOKE_MANAGER_EMAIL:=manager@qparts.local}"
if [ -z "${SMOKE_ADMIN_PASS:-}" ] || [ -z "${SMOKE_MANAGER_PASS:-}" ]; then
  echo "ABORT: set SMOKE_ADMIN_PASS and SMOKE_MANAGER_PASS before running against production."
  exit 1
fi
login(){ curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d "$(printf '{"email":"%s","password":"%s"}' "$1" "$2")" | jf token; }
MTOK=$(login "$SMOKE_MANAGER_EMAIL" "$SMOKE_MANAGER_PASS")
ATOK=$(login "$SMOKE_ADMIN_EMAIL" "$SMOKE_ADMIN_PASS")
M=(-H "Authorization: Bearer $MTOK" -H "X-Tenant: riyadh" -H 'Content-Type: application/json')
A=(-H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json')
scode(){ local m=$1 p=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X $m "$B$p" "$@"; }

echo "###### PROD SCHEMA & POLICIES ######"
ok 2 "$(rpsql "select count(*) from information_schema.columns where column_name='counterparty_type' and table_name in ('vendors','workshops')")" "counterparty_type on vendors+workshops"
ok 6 "$(rpsql "select count(*) from pg_indexes where indexname like '%_company_tax_uq' or indexname like '%_individual_mobile_uq'")" "6 dedup indexes (vendors + workshops + service_providers)"
ok 2 "$(rpsql "select count(*) from pg_class where relname in ('counterparty_submissions','import_batches') and relrowsecurity")" "2 staging tables w/ RLS"
ok 2 "$(rpsql "select count(*) from pg_policies where tablename in ('vendors','workshops') and policyname='directory_read'")" "directory_read policy on both (Slice 4)"
ok 0 "$(rpsql "select count(*) from pg_policies where tablename in ('vendors','workshops') and policyname='global_read'")" "old global_read policy removed"

echo "###### PROD DEDUP (transaction rollback — no persistence) ######"
DUP=$(ssh "$PROD_SSH" 'docker exec -i qvm_postgres psql -U qvm -d qvm_platform -q' 2>&1 <<'SQL'
BEGIN; INSERT INTO vendors (legal_name,counterparty_type,tax_number) VALUES ('PA','company','PTAX'); INSERT INTO vendors (legal_name,counterparty_type,tax_number) VALUES ('PB','company','PTAX'); ROLLBACK;
BEGIN; INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('PIA','individual','0511'); INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('PIB','individual','0511'); ROLLBACK;
BEGIN; INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('PIX','individual','0588'); INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('PCY','company','0588'); ROLLBACK;
SQL
)
ok 2 "$(echo "$DUP" | /usr/bin/grep -c 'duplicate key')" "company-tax + individual-mobile dups blocked; cross-scope allowed"

echo "###### PROD GOVERNANCE GUARDS ######"
ok 403 "$(scode POST /api/vendors "${M[@]}" -d '{"legalName":"x"}')" "manager POST /vendors -> 403"
ok 403 "$(scode POST /api/org/workshops "${M[@]}" -d '{"name":"x"}')" "manager POST /org/workshops -> 403"
ok 403 "$(scode GET /api/vendors/available "${M[@]}")" "manager GET /vendors/available -> 403"
ok 200 "$(scode GET /api/vendors "${M[@]}")" "manager GET /vendors -> 200"
ok 403 "$(scode GET /api/counterparty/review "${M[@]}")" "manager GET /counterparty/review -> 403"

echo "###### PROD SUBMIT->REJECT (no directory write) + PRIVACY ######"
V0=$(rpsql "select count(*) from vendors")
R=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"PROD VERIFY (delete)","taxNumber":"PRODVERIFY1"}')
ok pending "$(echo "$R" | jf status)" "prod submit -> pending"
ok False "$(echo "$R" | /usr/bin/python3 -c 'import sys,json;print("candidates" in json.load(sys.stdin))')" "prod submit response has NO candidate names (privacy)"
SUB=$(echo "$R" | jf submissionId)
ok True "$(curl -s $B/api/counterparty/review "${A[@]}" | /usr/bin/python3 -c "import sys,json;print(any(s['id']=='$SUB' for s in json.load(sys.stdin)['submissions']))")" "prod admin review sees it"
ok rejected "$(curl -s -X POST $B/api/counterparty/submissions/$SUB/reject "${A[@]}" -d '{"notes":"verify"}' | jf status)" "prod reject -> rejected"
V1=$(rpsql "select count(*) from vendors")
ok "$V0" "$V1" "prod directory unchanged (no vendor created: $V0 -> $V1)"

echo "###### PROD LIVE/SANDBOX BOUNDARY (ADR-0012) ######"
# The boundary must hold THROUGH nginx: if the proxy ever strips X-Environment, resolveEnvironment()
# fails open to 'live' and a user who believes they are in Sandbox writes real data. Silent by design
# unless asserted here.
AR=(-H "Authorization: Bearer $ATOK" -H "X-Tenant: riyadh" -H 'Content-Type: application/json')
LIVEN=$(curl -s "${AR[@]}" -H 'X-Environment: live' $B/api/rfqs | jf count)
SBXN=$(curl  -s "${AR[@]}" -H 'X-Environment: sandbox' $B/api/rfqs | jf count)
BAREN=$(curl -s "${AR[@]}" $B/api/rfqs | jf count)
LIVE_NONZERO=0; [ "${LIVEN:-0}" -gt 0 ] && LIVE_NONZERO=1
ok 1 "$LIVE_NONZERO" "prod live has at least one RFQ (=$LIVEN)"
ok 0 "$SBXN"         "prod sandbox is isolated from live"
ok "$LIVEN" "$BAREN" "no header behaves as live (fails closed to real data)"
ok live    "$(curl -s "${AR[@]}" $B/api/me | jf environment)"                              "/me echoes the resolved environment (live)"
ok sandbox "$(curl -s "${AR[@]}" -H 'X-Environment: sandbox' $B/api/me | jf environment)"  "/me echoes the resolved environment (sandbox)"
ok 0 "$(rpsql "select count(*) from information_schema.columns c
  where c.table_schema='public' and c.column_name='environment' and c.table_name <> 'order_number_counters'
    and not exists (select 1 from pg_policies p where p.tablename=c.table_name
                    and p.policyname='environment_isolation' and p.permissive='RESTRICTIVE')")" "every environment table carries the RESTRICTIVE policy on prod (no magic count)"
ok 0  "$(rpsql "select count(*) from information_schema.columns where column_name='is_sandbox'")" "tenants.is_sandbox retired on prod"

echo "###### CLEANUP ######"
CLEAN_OUT=$(rpsql "delete from counterparty_submissions where tax_number='PRODVERIFY1'; select 'cleaned'")
ok cleaned "$(echo "$CLEAN_OUT" | /usr/bin/tail -1)" "removed prod verify submission"

echo
echo "PROD RESULT:  $PASS passed,  $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
