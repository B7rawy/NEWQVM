#!/usr/bin/env bash
# smoke.sh — comprehensive end-to-end regression suite (46 checks) for the backend:
# schema/dedup, counterparty submission/match/review, bulk import, governance guards,
# individual-read privacy RLS. Run against a FRESHLY SEEDED local stack:
#   pnpm --filter @qvm/api db:seed && bash apps/api/scripts/smoke.sh
# Requires: local API on $B, docker container qvm_postgres. Exits non-zero on any FAIL.
B=${SMOKE_BASE:-http://localhost:4000}
PASS=0; FAIL=0
ok(){ if [ "$1" = "$2" ]; then echo "  PASS | $3"; PASS=$((PASS+1)); else echo "  FAIL | $3  (got '$2' want '$1')"; FAIL=$((FAIL+1)); fi; }
jf(){ /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))"; }
psql(){ docker exec qvm_postgres psql -U qvm -d qvm_platform -tA -c "$1"; }
appsql(){ docker exec -e PGPASSWORD=qvm_app_local_dev qvm_postgres psql -U qvm_app -d qvm_platform -tA -c "$1"; }

MTOK=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"manager@qparts.local","password":"manager1234"}' | jf token)
ATOK=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@qparts.local","password":"admin1234"}' | jf token)
M=(-H "Authorization: Bearer $MTOK" -H "X-Tenant: riyadh" -H 'Content-Type: application/json')
A=(-H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json')
AR=(-H "Authorization: Bearer $ATOK" -H "X-Tenant: riyadh" -H 'Content-Type: application/json')
scode(){ local m=$1 p=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X $m "$B$p" "$@"; }

echo "############ SECTION 1 — SCHEMA & DEDUP (Slice 1) ############"
ok 2 "$(psql "select count(*) from information_schema.columns where column_name='counterparty_type' and table_name in ('vendors','workshops')")" "counterparty_type on vendors+workshops"
ok 4 "$(psql "select count(*) from pg_indexes where indexname like '%_company_tax_uq' or indexname like '%_individual_mobile_uq'")" "4 scoped dedup indexes"
ok 2 "$(psql "select count(*) from pg_class where relname in ('counterparty_submissions','import_batches') and relrowsecurity")" "2 staging tables w/ RLS"
# dedup behaviour (transaction rollback)
D1=$(docker exec -i qvm_postgres psql -U qvm -d qvm_platform -q 2>&1 <<'SQL'
BEGIN;
INSERT INTO vendors (legal_name,counterparty_type,tax_number) VALUES ('D A','company','DTAX');
INSERT INTO vendors (legal_name,counterparty_type,tax_number) VALUES ('D B','company','DTAX');
ROLLBACK;
SQL
)
ok 1 "$(echo "$D1" | /usr/bin/grep -c 'duplicate key')" "company dup tax blocked"
D2=$(docker exec -i qvm_postgres psql -U qvm -d qvm_platform -q 2>&1 <<'SQL'
BEGIN;
INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('I A','individual','0500');
INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('I B','individual','0500');
ROLLBACK;
SQL
)
ok 1 "$(echo "$D2" | /usr/bin/grep -c 'duplicate key')" "individual dup mobile blocked"
D3=$(docker exec -i qvm_postgres psql -U qvm -d qvm_platform -q 2>&1 <<'SQL'
BEGIN;
INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('IX','individual','0577');
INSERT INTO vendors (legal_name,counterparty_type,primary_phone) VALUES ('CY','company','0577');
ROLLBACK;
SQL
)
ok 0 "$(echo "$D3" | /usr/bin/grep -c 'duplicate key')" "cross-scope (indiv mobile == company phone) allowed"

echo "############ SECTION 2 — SUBMISSION API + MATCH + REVIEW (Slice 2) ############"
# T1 new company
R1=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"Riyadh Bolts","taxNumber":"NEWTAX1","email":"b@x.com"}')
ok pending "$(echo "$R1" | jf status)" "T1 submit new company -> pending"
ok False "$(echo "$R1" | jf autoLinked)" "T1 autoLinked false"
SUB1=$(echo "$R1" | jf submissionId)
# T2 privacy — no candidate names in response
ok False "$(echo "$R1" | /usr/bin/python3 -c 'import sys,json;print("candidates" in json.load(sys.stdin))')" "T2 privacy: response has NO candidates array"
ok True  "$(echo "$R1" | /usr/bin/python3 -c 'import sys,json;print("matchCount" in json.load(sys.stdin))')" "T2 privacy: response has matchCount"
# T3 no identifier
ok 400 "$(scode POST /api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","legalName":"No Id Co"}')" "T3 submit w/o identifier -> 400"
# T4 name % escape (only Gulf exists; '%%' escaped -> 0)
R4=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"%%","email":"p@x.com"}')
ok 0 "$(echo "$R4" | jf matchCount)" "T4 name '%%' escaped -> matchCount 0 (no match-all)"
# T5 listMine
ok True "$(curl -s $B/api/counterparty/submissions "${M[@]}" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["count"]>=1)')" "T5 listMine sees own submissions"
# T6 review sees pending (admin) with candidate names available
ok True "$(curl -s $B/api/counterparty/review "${A[@]}" | /usr/bin/python3 -c 'import sys,json;print(json.load(sys.stdin)["count"]>=1)')" "T6 admin review sees pending"
# T7 approve T1 -> creates vendor + links riyadh
R7=$(curl -s -X POST $B/api/counterparty/submissions/$SUB1/approve "${A[@]}" -d '{}')
VID1=$(echo "$R7" | jf entityId)
ok approved "$(echo "$R7" | jf status)" "T7 approve -> approved"
ok "company|NEWTAX1|riyadh" "$(psql "select v.counterparty_type||'|'||v.tax_number||'|'||t.slug from vendors v join tenant_vendors tv on tv.vendor_id=v.id join tenants t on t.id=tv.tenant_id where v.id='$VID1'")" "T7 DB: vendor created (company/NEWTAX1) + linked riyadh"
# T8 resubmit same tax -> auto-link to same entity
R8=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"Riyadh Bolts 2","taxNumber":"NEWTAX1"}')
ok merged "$(echo "$R8" | jf status)" "T8 resubmit exact tax -> merged (auto-link)"
ok True "$(echo "$R8" | jf autoLinked)" "T8 autoLinked true"
ok "$VID1" "$(echo "$R8" | jf entityId)" "T8 auto-linked to the SAME vendor id"
# T9 individual create + auto-link
R9=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"individual","legalName":"Sami Person","mobile":"0561110001"}')
S9=$(echo "$R9" | jf submissionId)
curl -s -X POST $B/api/counterparty/submissions/$S9/approve "${A[@]}" -d '{}' >/dev/null
VIND=$(psql "select id from vendors where primary_phone='0561110001' and counterparty_type='individual'")
R9b=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"individual","legalName":"Sami P","mobile":"0561110001"}')
ok merged "$(echo "$R9b" | jf status)" "T9 individual exact-mobile -> auto-link"
ok "$VIND" "$(echo "$R9b" | jf entityId)" "T9 individual auto-linked to same id"
# T10 type-scoped: company w/ phone MOB2, then individual w/ MOB2 must NOT auto-link
Rc=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"PhoneCo","taxNumber":"PHTAX1","mobile":"0562220002"}')
Sc=$(echo "$Rc" | jf submissionId)
curl -s -X POST $B/api/counterparty/submissions/$Sc/approve "${A[@]}" -d '{}' >/dev/null
Ri=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"individual","legalName":"Person Same Phone","mobile":"0562220002"}')
ok pending "$(echo "$Ri" | jf status)" "T10 individual sharing a COMPANY phone -> pending (type-scoped, no wrong auto-link)"
ok False "$(echo "$Ri" | jf autoLinked)" "T10 autoLinked false"
# T11 fuzzy name candidate visible to ADMIN (not workspace)
Rf=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"Gulf Auto","taxNumber":"GULFX1"}')
ok True "$(curl -s $B/api/counterparty/review "${A[@]}" | /usr/bin/python3 -c 'import sys,json;d=json.load(sys.stdin);print(any(any(cc["name"]=="Gulf Auto Parts Co." for cc in s["match_candidates"]) for s in d["submissions"]))')" "T11 admin review exposes candidate NAME (Gulf Auto Parts Co.)"
# T13 approve-dup -> 'use merge'
Rd1=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"Dup One","taxNumber":"DUP99"}'); SD1=$(echo "$Rd1" | jf submissionId)
Rd2=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"Dup Two","taxNumber":"DUP99"}'); SD2=$(echo "$Rd2" | jf submissionId)
curl -s -X POST $B/api/counterparty/submissions/$SD1/approve "${A[@]}" -d '{}' >/dev/null
Rdd=$(curl -s -X POST $B/api/counterparty/submissions/$SD2/approve "${A[@]}" -d '{}')
ok True "$(echo "$Rdd" | /usr/bin/python3 -c 'import sys,json;print("merge" in json.load(sys.stdin).get("message",""))')" "T13 approve duplicate-key -> 'use merge instead' (not generic error)"
# T14 guards
ok 403 "$(scode GET /api/counterparty/review "${M[@]}")" "T14 manager -> review = 403"
ok 403 "$(scode POST /api/counterparty/submissions/$SUB1/approve "${M[@]}" -d '{}')" "T14 manager -> approve = 403"
# reject flow
Rr=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"To Reject","taxNumber":"REJ1"}'); SR=$(echo "$Rr" | jf submissionId)
ok rejected "$(curl -s -X POST $B/api/counterparty/submissions/$SR/reject "${A[@]}" -d '{"notes":"no"}' | jf status)" "T14 reject -> rejected"
ok 0 "$(psql "select count(*) from vendors where tax_number='REJ1'")" "T14 reject leaves 0 directory rows"

echo "############ SECTION 3 — BULK IMPORT (Slice 3) ############"
IMP=$(curl -s -X POST $B/api/counterparty/import "${M[@]}" -d '{"kind":"vendor","filename":"s.xlsx","rows":[
  {"counterpartyType":"company","legalName":"Imp New A","taxNumber":"IMPA1"},
  {"counterpartyType":"company","legalName":"Imp Nahdi","taxNumber":"NEWTAX1"},
  {"counterpartyType":"company","legalName":"Imp NoId"},
  {"counterpartyType":"individual","legalName":"Imp Indiv","mobile":"0563330003"},
  {"counterpartyType":"company","legalName":"Imp New B","taxNumber":"IMPB1"}]}')
ok 5 "$(echo "$IMP" | jf total)" "import total = 5"
ok 1 "$(echo "$IMP" | jf autoLinked)" "import autoLinked = 1 (NEWTAX1 exists)"
ok 3 "$(echo "$IMP" | jf pending)" "import pending = 3"
ok 1 "$(echo "$IMP" | jf errors)" "import errors = 1 (no identifier)"
BID=$(echo "$IMP" | jf batchId)
ok "completed|4|1" "$(psql "select status||'|'||valid_rows||'|'||error_rows from import_batches where id='$BID'")" "import batch: completed valid=4 err=1"
ok 3 "$(psql "select count(*) from counterparty_submissions where import_batch_id='$BID' and source='excel_import' and status='pending'")" "3 imported submissions staged (source+batch)"
# 1000-row cap
BIG=$(/usr/bin/python3 -c 'import json;print(json.dumps({"kind":"vendor","rows":[{"legalName":"C%d"%i,"taxNumber":"T%d"%i} for i in range(1001)]}))')
ok 400 "$(curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/counterparty/import "${M[@]}" -d "$BIG")" "import >1000 rows -> 400 (cap)"

echo "############ SECTION 4 — GOVERNANCE GUARDS (Slice 5 rework) ############"
ok 403 "$(scode POST /api/vendors "${M[@]}" -d '{"legalName":"Bypass"}')" "manager POST /vendors -> 403"
ok 403 "$(scode POST /api/org/workshops "${M[@]}" -d '{"name":"Bypass"}')" "manager POST /org/workshops -> 403"
ok 403 "$(scode GET /api/vendors/available "${M[@]}")" "manager GET /vendors/available -> 403 (no directory browse)"
ok 200 "$(scode GET /api/vendors "${M[@]}")" "manager GET /vendors (linked list) -> 200"
ok 201 "$(scode POST /api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"Gov Ok","taxNumber":"GOVOK1"}')" "manager POST /counterparty/submissions -> 201"
ok 201 "$(scode POST /api/vendors "${AR[@]}" -d '{"legalName":"Admin Direct","taxNumber":"ADMD1"}')" "platform POST /vendors -> 201 (still curates)"

echo "############ SECTION 5 — INDIVIDUAL-READ PRIVACY RLS (Slice 4) ############"
RIY=$(psql "select id from tenants where slug='riyadh'"); JED=$(psql "select id from tenants where slug='jeddah'")
# Sami Person (0561110001) is an individual linked to riyadh (approved in T9)
ok 1 "$(appsql "select set_config('app.is_internal','true',false); select count(*) from vendors where primary_phone='0561110001'" | /usr/bin/tail -1)" "internal sees the individual"
ok 1 "$(appsql "select set_config('app.is_internal','false',false),set_config('app.tenant_id','$RIY',false); select count(*) from vendors where primary_phone='0561110001'" | /usr/bin/tail -1)" "linked workspace (riyadh) sees the individual"
ok 0 "$(appsql "select set_config('app.is_internal','false',false),set_config('app.tenant_id','$JED',false); select count(*) from vendors where primary_phone='0561110001'" | /usr/bin/tail -1)" "UNLINKED workspace (jeddah) does NOT see the individual"
ok 1 "$(appsql "select set_config('app.is_internal','false',false),set_config('app.tenant_id','$JED',false); select count(*) from vendors where tax_number='NEWTAX1'" | /usr/bin/tail -1)" "any workspace still sees a COMPANY (global)"

echo
echo "############################################################"
echo "RESULT:  $PASS passed,  $FAIL failed"
echo "############################################################"
[ "$FAIL" -eq 0 ] || exit 1
