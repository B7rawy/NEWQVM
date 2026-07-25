#!/usr/bin/env bash
# smoke.sh — comprehensive end-to-end regression suite (88 checks) for the backend:
# schema/dedup, counterparty submission/match/review, bulk import, governance guards,
# individual-read privacy RLS, Live/Sandbox environment isolation. Run against a FRESHLY SEEDED local stack:
#   pnpm --filter @qvm/api db:seed && bash apps/api/scripts/smoke.sh
# Requires: local API on $B, docker container qvm_postgres. Exits non-zero on any FAIL.
B=${SMOKE_BASE:-http://localhost:4000}
PASS=0; FAIL=0
ok(){ if [ "$1" = "$2" ]; then echo "  PASS | $3"; PASS=$((PASS+1)); else echo "  FAIL | $3  (got '$2' want '$1')"; FAIL=$((FAIL+1)); fi; }
jf(){ /usr/bin/python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('$1',''))"; }
psql(){ docker exec qvm_postgres psql -U qvm -d qvm_platform -tA -c "$1"; }
appsql(){ docker exec -e PGPASSWORD=qvm_app_local_dev qvm_postgres psql -U qvm_app -d qvm_platform -tA -c "$1"; }

MTOK=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"manager@qparts.local","password":"manager1234"}' | jf token)

# The API dev server does NOT hot-reload (it is `node --import @swc-node/register src/main.ts`).
# Running this suite against a process started before the last edit produces green results for code
# that is not running — which has already happened once. Refuse to report on a stale server.
PID=$(/usr/sbin/lsof -ti tcp:${B##*:} -sTCP:LISTEN 2>/dev/null | /usr/bin/head -1)
if [ -n "$PID" ]; then
  API_EPOCH=$(/bin/ps -o lstart= -p "$PID" | { read -r l; /bin/date -j -f '%a %b %d %T %Y' "$l" +%s 2>/dev/null || echo 0; })
  SRC_EPOCH=$(/usr/bin/find src drizzle -name '*.ts' -exec /usr/bin/stat -f '%m' {} + 2>/dev/null | /usr/bin/sort -rn | /usr/bin/head -1)
  if [ "${API_EPOCH:-0}" -gt 0 ] && [ "${SRC_EPOCH:-0}" -gt "${API_EPOCH:-0}" ]; then
    echo "ABORT: the running API started before the newest source edit — restart it, or these results are fiction."
    exit 1
  fi
fi

ATOK=$(curl -s -X POST $B/api/auth/login -H 'Content-Type: application/json' -d '{"email":"admin@qparts.local","password":"admin1234"}' | jf token)
M=(-H "Authorization: Bearer $MTOK" -H "X-Tenant: riyadh" -H 'Content-Type: application/json')
A=(-H "Authorization: Bearer $ATOK" -H 'Content-Type: application/json')
AR=(-H "Authorization: Bearer $ATOK" -H "X-Tenant: riyadh" -H 'Content-Type: application/json')
scode(){ local m=$1 p=$2; shift 2; curl -s -o /dev/null -w '%{http_code}' -X $m "$B$p" "$@"; }

echo "############ SECTION 1 — SCHEMA & DEDUP (Slice 1) ############"
ok 2 "$(psql "select count(*) from information_schema.columns where column_name='counterparty_type' and table_name in ('vendors','workshops')")" "counterparty_type on vendors+workshops"
ok 6 "$(psql "select count(*) from pg_indexes where indexname like '%_company_tax_uq' or indexname like '%_individual_mobile_uq'")" "6 scoped dedup indexes (vendors + workshops + service_providers)"
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
# T4 name % escape (only Gulf exists; '%%' escaped -> 0). Company needs a tax number (QNEW-71 AC2);
# use a UNIQUE tax so the only possible match is the escaped-LIKE name (which must not match-all).
R4=$(curl -s -X POST $B/api/counterparty/submissions "${M[@]}" -d '{"kind":"vendor","counterpartyType":"company","legalName":"%%","taxNumber":"ESCAPE-TEST-9","email":"p@x.com"}')
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

echo "############ SECTION 6 — LIVE/SANDBOX ISOLATION (ADR-0012) ############"
# The boundary must hold in the DATABASE, not merely in the queries: a session that forgets the
# predicate has to get nothing, not the other environment's rows.
RIY=$(psql "select id from tenants where slug='riyadh'")
envq(){ appsql "select set_config('app.tenant_id','$RIY',false),set_config('app.is_internal','$2',false),set_config('app.environment','$1',false); select count(*) from rfqs" | /usr/bin/tail -1; }
LIVE_N=$(envq live false)
# assert the live corpus is NON-EMPTY: comparing the command to itself can never fail, and if the
# seed ever stops creating an RFQ the two "sees zero" checks below would pass vacuously.
ok 1 "$([ "${LIVE_N:-0}" -gt 0 ] && echo 1 || echo 0)" "live session sees at least one live RFQ (=$LIVE_N)"
ok 0 "$(envq sandbox false)"        "sandbox session sees ZERO live RFQs"
ok 0 "$(envq sandbox true)"         "app_is_internal() does NOT reopen the boundary (restrictive policy)"

# A sandbox session must not be able to forge a row labelled live.
FORGED=$(appsql "select set_config('app.tenant_id','$RIY',false),set_config('app.is_internal','false',false),set_config('app.environment','sandbox',false);
  insert into rfqs (tenant_id,environment,order_number,workshop_branch_id)
  values ('$RIY','live','SMOKE-FORGE',(select id from workshop_branches limit 1))" 2>&1 | grep -c 'row-level security')
ok 1 "$FORGED" "a sandbox session CANNOT insert a row labelled live"

# Document numbering is per-environment: a sandbox test must never burn a live order number.
SBXNUM=$(psql "select public.next_order_number('$RIY','SMOKE-',null,'sandbox')")
LIVENUM=$(psql "select public.next_order_number('$RIY','SMOKE-',null,'live')")
ok "SMOKE-SBX-1" "$SBXNUM"  "sandbox numbers are marked and counted separately"
ok "SMOKE-1"     "$LIVENUM" "the live sequence is untouched by the sandbox one"
psql "delete from order_number_counters where prefix='SMOKE-'" > /dev/null

# Every environment-scoped table must be protected, and the flag it replaced must be gone.
ok 0  "$(psql "select count(*) from information_schema.columns where column_name='is_sandbox'")" "tenants.is_sandbox retired (one sandbox mechanism, not two)"
ok 0 "$(psql "select count(*) from information_schema.columns c
  where c.table_schema='public' and c.column_name='environment' and c.table_name <> 'order_number_counters'
    and not exists (select 1 from pg_policies p where p.tablename=c.table_name
                    and p.policyname='environment_isolation' and p.permissive='RESTRICTIVE')")" "every environment table carries the RESTRICTIVE policy (no magic count)"

# --- regressions found by auditing the boundary itself ---
# An emailed quote link carries no X-Environment header, so the token lookup must search BOTH
# environments; a single 'live' lookup made every sandbox link 404 as "invalid token".
BR=$(psql "select id from workshop_branches limit 1")
VID=$(psql "select vendor_id from tenant_vendors limit 1")
SR=$(curl -s "${AR[@]}" -H 'X-Environment: sandbox' -X POST $B/api/rfqs -d "{\"workshopBranchId\":\"$BR\",\"plateNumber\":\"SMOKE-ENV\",\"items\":[{\"partNumber\":\"P1\",\"quantity\":1}]}")
SRID=$(echo "$SR" | jf id)
STOK=$(curl -s "${AR[@]}" -H 'X-Environment: sandbox' -X POST $B/api/rfqs/$SRID/send -d "{\"vendorIds\":[\"$VID\"]}" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['results'][0]['token'])")
SITEM=$(psql "select id from rfq_items where rfq_id='$SRID' limit 1")
QPAY=$(/usr/bin/python3 -c "import json,sys;print(json.dumps({'items':[{'rfqItemId':sys.argv[1],'offeredCost':50}]}))" "$SITEM")
ok 201 "$(scode POST /api/quote-access/$STOK/quote -H 'Content-Type: application/json' -d "$QPAY")" "a SANDBOX quote link resolves (not 404)"
ok sandbox "$(psql "select environment from rfq_vendor_items where rfq_item_id='$SITEM'")" "and its quote is stored as sandbox"
ok 404 "$(scode POST /api/quote-access/deadbeefdeadbeefdeadbeefdeadbeef/quote -H 'Content-Type: application/json' -d '{"items":[{"rfqItemId":"00000000-0000-0000-0000-000000000000","offeredCost":1}]}')" "a bogus token is still rejected"

# A workshop filing a request from its portal must land in the environment it is working in.
ok sandbox "$(psql "select environment from rfqs where id='$SRID'")" "a sandbox-created RFQ is stored as sandbox"

# Platform-staff write routes run as internal, which satisfies the PERMISSIVE tenant policy — so they
# must bind the parent document to the ACTING workspace themselves, or a staffer on workspace A can
# hang an invoice/PO/delivery/return off workspace B's order.
OID=$(psql "select id from orders limit 1")
OWNER=$(psql "select t.slug from orders o join tenants t on t.id=o.tenant_id limit 1")
ok 404 "$(scode POST /api/orders/$OID/purchase-orders -H "Authorization: Bearer $ATOK" -H 'X-Tenant: jeddah' -H 'Content-Type: application/json')" "a PO cannot be raised on ANOTHER workspace's order"

echo "############ SECTION 7 — AUTHORIZATION PRECONDITIONS & PII FLOOR ############"
# A winning quote is not sufficient to confirm: the winner id survives a later status change, so
# without a pre-approval-state check a CANCELLED item became a real order line (proven 25/07/2026).
CB=$(psql "select id from workshop_branches limit 1")
CV=$(psql "select vendor_id from tenant_vendors limit 1")
CPAY=$(/usr/bin/python3 -c "import json,sys;print(json.dumps({'workshopBranchId':sys.argv[1],'plateNumber':'SMOKE-PRECOND','items':[{'partNumber':'PC1','quantity':1}]}))" "$CB")
CRID=$(curl -s "${AR[@]}" -X POST $B/api/rfqs -d "$CPAY" | jf id)
CTOK=$(curl -s "${AR[@]}" -X POST $B/api/rfqs/$CRID/send -d "{\"vendorIds\":[\"$CV\"]}" | /usr/bin/python3 -c "import sys,json;print(json.load(sys.stdin)['results'][0]['token'])")
CIT=$(psql "select id from rfq_items where rfq_id='$CRID' limit 1")
QP=$(/usr/bin/python3 -c "import json,sys;print(json.dumps({'items':[{'rfqItemId':sys.argv[1],'offeredCost':50}]}))" "$CIT")
curl -s -o /dev/null -X POST $B/api/quote-access/$CTOK/quote -H 'Content-Type: application/json' -d "$QP"
CQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$CIT' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST $B/api/rfqs/$CRID/items/$CIT/winning-quote -d "{\"quoteItemId\":\"$CQI\"}"
ok priced "$(psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$CIT'")" "picking a winner moves the item to 'priced'"
psql "update rfq_items set status_id=(select id from item_statuses where code='cancelled') where id='$CIT'" > /dev/null
ok 400 "$(scode POST /api/rfqs/$CRID/confirm -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json')" "a CANCELLED item cannot be confirmed into an order"
ok 0 "$(psql "select count(*) from order_items where rfq_item_id='$CIT'")" "and no order line was created from it"

# RLS is the floor under the API: an ordinary session must not be able to enumerate people.
RIY2=$(psql "select id from tenants where slug='riyadh'")
piiq(){ appsql "select set_config('app.tenant_id','$RIY2',false),set_config('app.is_internal','false',false),set_config('app.environment','live',false); select count(*) from $1" | /usr/bin/tail -1; }
ok 0 "$(piiq users)"            "a non-internal session cannot read the users table"
ok 0 "$(piiq platform_members)" "a non-internal session cannot enumerate platform staff"
ok 1 "$(appsql "select set_config('app.is_internal','true',false); select count(*) > 0 from users" | /usr/bin/tail -1 | /usr/bin/sed 's/t/1/;s/f/0/')" "internal staff CAN still read users"

# THE SINGLE STATUS-WRITE ENTRY POINT (QNEW-75). status_logs was designed and had zero writers, so
# stage-speed reporting, early/late cancellation and "reject → restore previous status" had no data.
ok 1 "$([ "$(psql "select count(*) from status_logs where entity_type='rfq_item' and entity_id='$CIT'")" -ge 1 ] && echo 1 || echo 0)" "picking a winner is recorded in status_logs"
ok priced "$(psql "select s.code from status_logs l join item_statuses s on s.id=l.to_status_id where l.entity_type='rfq_item' and l.entity_id='$CIT' order by l.created_at desc limit 1")" "and it records the status it moved TO"
ok new_rfq "$(psql "select s.code from status_logs l join item_statuses s on s.id=l.from_status_id where l.entity_type='rfq_item' and l.entity_id='$CIT' order by l.created_at desc limit 1")" "and the status it moved FROM"
ok 1 "$([ -n "$(psql "select changed_by from status_logs where entity_id='$CIT' limit 1")" ] && echo 1 || echo 0)" "and WHO moved it (from the JWT, never a request body)"
ok live "$(psql "select environment from status_logs where entity_id='$CIT' limit 1")" "history is environment-scoped like the record it describes"

# release the winner FK before deleting the quote rows it points at, or the cleanup half-fails
psql "delete from status_logs where entity_id in (select id from rfq_items where rfq_id='$CRID') or entity_id='$CRID';
      update rfq_items set winning_vendor_quote_item_id = null where rfq_id='$CRID';
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id='$CRID');
      delete from rfq_vendors where rfq_id='$CRID'; delete from rfq_items where rfq_id='$CRID';
      delete from notification_log where template='vendor_rfq_invite'; delete from rfqs where id='$CRID'" > /dev/null


# cleanup
psql "delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id='$SRID');
      delete from rfq_vendors where rfq_id='$SRID'; delete from rfq_items where rfq_id='$SRID';
      delete from notification_log where environment='sandbox'; delete from rfqs where id='$SRID';
      delete from order_number_counters where environment='sandbox'" > /dev/null


echo "############ SECTION 8 — WORKFLOW ENGINE (QNEW-64) ############"
wf(){ curl -s "${AR[@]}" "$@"; }
ok 403 "$(scode POST /api/admin/workflows -H "Authorization: Bearer $MTOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' -d '{"flowKey":"nope","nameEn":"X","nameAr":"س"}')" "a non-super-admin cannot create a flow"
CAT=$(wf $B/api/admin/workflows/catalog)
ok 1 "$(echo "$CAT" | /usr/bin/python3 -c 'import sys,json;d=json.load(sys.stdin);print(1 if len(d["itemStatuses"])>0 and len(d["roles"])>0 else 0)')" "the governed catalog the canvas and AI must draw from is served"

WFID=$(wf -X POST $B/api/admin/workflows -d '{"flowKey":"smoke","nameEn":"Smoke","nameAr":"اختبار","isDefault":false}' | jf id)
ok 1 "$([ -n "$WFID" ] && echo 1 || echo 0)" "a draft flow can be created"

# a status the model invented must be refused, not stored
BADG='{"steps":[{"status":"totally_made_up","isEntry":true}],"transitions":[]}'
ok 400 "$(scode PUT /api/admin/workflows/$WFID/graph -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' -d "$BADG")" "an invented status code is rejected"
TWOENTRY='{"steps":[{"status":"new_rfq","isEntry":true},{"status":"priced","isEntry":true,"isTerminal":true}],"transitions":[]}'
ok 400 "$(scode PUT /api/admin/workflows/$WFID/graph -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' -d "$TWOENTRY")" "two entry steps are rejected"

# a graph with a dead-end saves (drafts may be half-drawn) but must NOT activate
DEADEND='{"selectionCondition":{},"steps":[{"status":"new_rfq","isEntry":true},{"status":"priced"},{"status":"confirmed","isTerminal":true}],"transitions":[{"from":"new_rfq","to":"priced"}]}'
ok 200 "$(scode PUT /api/admin/workflows/$WFID/graph -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' -d "$DEADEND")" "a half-drawn draft still saves"
ok 400 "$(scode POST /api/admin/workflows/$WFID/activate -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh')" "but a flow that would strand records cannot be activated"

GOOD='{"selectionCondition":{},"steps":[{"status":"new_rfq","isEntry":true},{"status":"priced"},{"status":"confirmed","isTerminal":true}],"transitions":[{"from":"new_rfq","to":"priced"},{"from":"priced","to":"confirmed"}]}'
wf -o /dev/null -X PUT $B/api/admin/workflows/$WFID/graph -d "$GOOD"
ok 201 "$(scode POST /api/admin/workflows/$WFID/activate -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh')" "a complete flow activates"
ok active "$(psql "select status from workflow_flows where id='$WFID'")" "and is recorded as active"

# the guarantee that protects in-flight orders
ok 409 "$(scode PUT /api/admin/workflows/$WFID/graph -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' -d "$GOOD")" "an ACTIVE flow cannot be edited in place"
ok 409 "$(scode DELETE /api/admin/workflows/$WFID -H "Authorization: Bearer $ATOK" -H 'X-Tenant: riyadh')" "and cannot be deleted"
V2=$(wf -X POST $B/api/admin/workflows/$WFID/new-version | jf id)
ok draft "$(psql "select status from workflow_flows where id='$V2'")" "the supported path is a new draft version"
ok 3 "$(psql "select count(*) from workflow_steps where flow_id='$V2'")" "and the graph is cloned into it"

# the database refuses even if the API is bypassed
ok 3 "$(psql "select count(*) from pg_trigger where tgname like 'trg_workflow%_freeze'")" "the freeze is enforced by the DB, not just the API"

# flows are per-environment: built in Sandbox, activated in Live (ADR-0012)
SBXN=$(curl -s "${AR[@]}" -H 'X-Environment: sandbox' $B/api/admin/workflows | jf count)
ok 0 "$SBXN" "flows built in Live are invisible in Sandbox"

# ── THE GUARD ────────────────────────────────────────────────────────────────
# Kept in its own file: it drives a full RFQ→quote→winner chain twice, and inlining that here meant
# three layers of shell escaping around JSON. `guard-check.sh` prints one PASS/FAIL line per check.
GUARD_OUT=$(bash "$(dirname "$0")/guard-check.sh" "$B" "$ATOK")
echo "$GUARD_OUT" | grep -E '^  (PASS|FAIL)'
PASS=$((PASS + $(echo "$GUARD_OUT" | grep -c '^  PASS')))
FAIL=$((FAIL + $(echo "$GUARD_OUT" | grep -c '^  FAIL')))

echo
echo "############################################################"
echo "RESULT:  $PASS passed,  $FAIL failed"
echo "############################################################"
[ "$FAIL" -eq 0 ] || exit 1
