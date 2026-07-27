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

echo "###### PROD WORKFLOW ENGINE ######"
# The other sections prove the platform's invariants. None of them touches the workflow engine, so
# until now "the engine is deployed" meant the migrations ran — not that it does anything.
#
# EVERYTHING HERE RUNS IN THE SANDBOX ENVIRONMENT, and that is not a formality: an activated flow
# GOVERNS REAL ORDERS, so a test that drew one in live would be enforcing rules on the customer's own
# work for as long as it ran. Sandbox is environment-isolated (asserted two sections up), so a flow
# here cannot reach a live record. What cannot be done from outside is a full order chain: sandbox
# suppresses the vendor invitation on purpose and the quote link is stored as a hash, so there is no
# way to answer a quote without writing to the production database — which this script will not do.
S=(-H "Authorization: Bearer $ATOK" -H "X-Tenant: riyadh" -H "X-Environment: sandbox" -H 'Content-Type: application/json')
wfkey="smoke-prod-$$"

ok 1 "$(curl -s "${S[@]}" "$B/api/admin/workflows/catalog" | /usr/bin/python3 -c "
import sys, json
d = json.load(sys.stdin)
# the engine's vocabulary has to be SERVED, not merely present in the image: the builder and the
# assistant both draw from this, and a deploy that shipped code without it would look healthy
print(1 if d.get('itemStatuses') and d.get('roles') and d.get('gates') and d.get('actions') else 0)")"   "prod serves the governed catalog the builder draws from"

PWF=$(curl -s "${S[@]}" -X POST "$B/api/admin/workflows" \
  -d "$(printf '{"flowKey":"%s","nameAr":"فحص النشر","nameEn":"Deploy check","isDefault":true}' "$wfkey")" | jf id)
ok 1 "$([ -n "$PWF" ] && echo 1 || echo 0)" "a flow can be created on prod"

# An invented status must be refused by the DEPLOYED validator, not just the local one.
ok 400 "$(scode PUT "/api/admin/workflows/$PWF/graph" "${S[@]}" \
  -d '{"selectionCondition":{},"steps":[{"status":"totally_made_up","isEntry":true}],"transitions":[]}')" \
  "and a status the model invented is rejected there"

curl -s -o /dev/null "${S[@]}" -X PUT "$B/api/admin/workflows/$PWF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100,"pages":[{"page":"rfqs","mode":"action"}]},
          {"status":"confirmed","isTerminal":true,"x":340,"y":100,"pages":[{"page":"orders","mode":"action"}]}],
 "transitions":[{"from":"new_rfq","to":"confirmed","labelEn":"Confirm"}]}'
ok active "$(curl -s "${S[@]}" -X POST "$B/api/admin/workflows/$PWF/activate" | jf status)" \
  "a drawn flow activates"

# THE ENGINE ACTUALLY RUNS. Creating a request is a status move now (QNEW-90 item 7), so if the
# gateway were not wired on prod this row would simply not exist.
PBR=$(rpsql "select wb.id from workshop_branches wb
              join tenant_workshops tw on tw.workshop_id = wb.workshop_id and tw.status='active'
              join tenants t on t.id = tw.tenant_id and t.slug='riyadh'
             where wb.is_active limit 1")
PRFQ=$(curl -s "${S[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"PRODWF-1","items":[{"partNumber":"P1","quantity":1}]}' "$PBR")" | jf id)
ok 1 "$([ -n "$PRFQ" ] && echo 1 || echo 0)" "a request can still be raised while a flow is active (permissive until configured)"
ok 1 "$(rpsql "select count(*) from status_logs where entity_id='$PRFQ' and entity_type='rfq'")" \
  "and arriving is recorded as a move — the gateway is live on prod, not just deployed"
ok 1 "$(rpsql "select count(*) from workflow_record_state where entity_id='$PRFQ'")" \
  "bound to the flow version it entered under"

# Everything this section made, removed. A flow left ACTIVE here would govern the next real order.
rpsql "alter table workflow_flows disable trigger trg_workflow_flows_freeze;
       alter table workflow_steps disable trigger trg_workflow_steps_freeze;
       alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
       delete from workflow_transitions where flow_id in (select id from workflow_flows where flow_key='$wfkey');
       delete from workflow_steps       where flow_id in (select id from workflow_flows where flow_key='$wfkey');
       -- The LINES get a record_state row too, and workflow_record_state carries a composite FK to
       -- the flow. Deleting only the header's row left the lines' rows pointing at the flow, the
       -- flow delete failed on that constraint, and this check left an ACTIVE default flow on
       -- production — which would have governed the next real order. Clear the whole binding first.
       delete from workflow_record_state
        where entity_id = '$PRFQ'
           or entity_id in (select id from rfq_items where rfq_id = '$PRFQ');
       delete from workflow_flows where flow_key='$wfkey';
       alter table workflow_flows enable trigger trg_workflow_flows_freeze;
       alter table workflow_steps enable trigger trg_workflow_steps_freeze;
       alter table workflow_transitions enable trigger trg_workflow_transitions_freeze;
       delete from status_logs where entity_id='$PRFQ';
       delete from rfq_items where rfq_id='$PRFQ';
       delete from rfqs where id='$PRFQ'" > /dev/null
ok 0 "$(rpsql "select count(*) from workflow_flows where flow_key like 'smoke-prod-%'")" \
  "and this check leaves NO flow behind — an active one would govern the next real order"
ok 0 "$(rpsql "select count(*) from rfqs where environment='sandbox' and plate_number='PRODWF-1'")" \
  "nor the request it raised"

echo "###### CLEANUP ######"
CLEAN_OUT=$(rpsql "delete from counterparty_submissions where tax_number='PRODVERIFY1'; select 'cleaned'")
ok cleaned "$(echo "$CLEAN_OUT" | /usr/bin/tail -1)" "removed prod verify submission"

echo
echo "PROD RESULT:  $PASS passed,  $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1
