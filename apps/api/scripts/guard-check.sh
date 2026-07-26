#!/usr/bin/env bash
# guard-check.sh — proves the workflow GUARD both stays out of the way and bites.
#
# Its own file because it drives a full RFQ → send → quote → pick-winner chain twice, and inlining
# that in smoke.sh meant three layers of shell escaping around JSON payloads. Prints one
# "  PASS | …" / "  FAIL | …" line per check; smoke.sh folds the counts into its own totals.
#
# $1 = base url   $2 = platform-admin token
#
# JSON payloads are built with printf, NOT an inline python dict: `{...}` inside nested double
# quotes hits bash brace expansion, which silently mangles the body into something the API rejects.
set -uo pipefail
B="${1:-http://localhost:4000}"
ATOK="$2"
PY=/usr/bin/python3
AR=(-H "Authorization: Bearer $ATOK" -H "X-Tenant: riyadh" -H "Content-Type: application/json")
psql(){ docker exec qvm_postgres psql -U qvm -d qvm_platform -tA -c "$1"; }
ok(){ if [ "$1" = "$2" ]; then echo "  PASS | $3"; else echo "  FAIL | $3  (got '$2' want '$1')"; fi; }

wfclean(){
  psql "alter table workflow_flows disable trigger trg_workflow_flows_freeze;
        alter table workflow_steps disable trigger trg_workflow_steps_freeze;
        alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
        delete from workflow_transitions where flow_id in (select id from workflow_flows where flow_key like 'smoke-%');
        delete from workflow_steps       where flow_id in (select id from workflow_flows where flow_key like 'smoke-%');
        delete from workflow_record_state where flow_id in (select id from workflow_flows where flow_key like 'smoke-%');
        delete from workflow_flows where flow_key like 'smoke-%';
        alter table workflow_flows enable trigger trg_workflow_flows_freeze;
        alter table workflow_steps enable trigger trg_workflow_steps_freeze;
        alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null
}

# the branch must belong to a workshop LINKED to riyadh, or rfq creation 400s
BR=$(psql "select wb.id from workshop_branches wb
            join tenant_workshops tw on tw.workshop_id = wb.workshop_id and tw.status='active'
            join tenants t on t.id = tw.tenant_id and t.slug='riyadh'
            where wb.is_active limit 1")
VID=$(psql "select tv.vendor_id from tenant_vendors tv join vendors v on v.id = tv.vendor_id
            where tv.status='active' and v.is_active and v.activation_status='active' limit 1")

# Drive one item from new_rfq to priced (picking a winning quote). Echoes the final response body.
pick_winner() {
  local plate="$1" rid tok it qi
  local ACT=("${AR[@]}")
  [ -n "${ACTOR:-}" ] && ACT=(-H "Authorization: Bearer $ACTOR" -H "X-Tenant: riyadh" -H "Content-Type: application/json")
  rid=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"GP","quantity":1}]}' "$BR" "$plate")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  [ -z "$rid" ] && { echo '{"message":"could not create the RFQ"}'; return; }
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/send" \
    -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  [ -z "$tok" ] && { echo '{"message":"could not send the RFQ to a vendor"}'; return; }
  it=$(psql "select id from rfq_items where rfq_id='$rid' limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  [ -z "$qi" ] && { echo '{"message":"the vendor quote was not recorded"}'; return; }
  curl -s "${ACT[@]}" -X POST "$B/api/rfqs/$rid/items/$it/winning-quote" \
    -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
}

blocked(){ echo "$1" | $PY -c "import sys,json;print(1 if 'message' in json.load(sys.stdin) else 0)"; }

# 1) permissive until configured — this is what makes the rollout safe for live orders
wfclean
ok 0 "$(blocked "$(pick_winner GUARD-OFF)")" "with NO active workflow a normal move is allowed"

# 2) activate a workflow whose ONLY arrow is new_rfq → confirmed
FID=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-guard","nameAr":"حارس","nameEn":"Guard","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FID/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"confirmed","labelEn":"Confirm"}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$FID/activate"
ok active "$(psql "select status from workflow_flows where id='$FID'")" "a workflow can be activated"

# 3) the same move is now off the drawn path, so it must be refused
ok 1 "$(blocked "$(pick_winner GUARD-ON)")" "and a move that is NOT an arrow in it is refused"

wfclean
psql "delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'GUARD-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'GUARD-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'GUARD-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'GUARD-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'GUARD-%'" > /dev/null

# ── 0048 governance ─────────────────────────────────────────────────────────────────────────────
# The FROZEN/TUNABLE split is a hardcoded column tuple inside a plpgsql function. A new semantic
# column that nobody adds to it is silently editable on an ACTIVE flow — i.e. the rules can be
# rewritten under orders already executing them. That is the failure this whole feature exists to
# prevent, so it is asserted here rather than trusted.
ok t "$(psql "select prosrc like '%owner_roles%' from pg_proc where proname='workflow_child_freeze'")" \
  "the freeze trigger governs owner_roles (semantics are frozen)"
ok f "$(psql "select prosrc like '%NEW.pages%' from pg_proc where proname='workflow_child_freeze'")" \
  "but NOT pages — a mis-routed status stays fixable without republishing"

# permissive until configured: a step created without an opinion routes nowhere
ok "'[]'::jsonb" "$(psql "select column_default from information_schema.columns
                          where table_name='workflow_steps' and column_name='pages'")" \
  "pages defaults to [] — routing is opt-in, not something a new step inherits"

# every migration on disk must be reachable by the runner, or a deploy silently applies nothing
ok 0 "$(/usr/bin/python3 -c "
import json,os
d='$(cd "$(dirname "$0")/.." && pwd)/drizzle/migrations'
tags={e['tag'] for e in json.load(open(d+'/meta/_journal.json'))['entries']}
print(len([f for f in os.listdir(d) if f.endswith('.sql') and f[:-4] not in tags]))")" \
  "no migration is orphaned from meta/_journal.json"

# ── who may make the move (0048) ────────────────────────────────────────────────────────────────
# Every status endpoint here is platform-staff-only and the seeded admin is super_admin, who is
# break-glass BY DESIGN. So a rule restricting an arrow can only ever be observed to bite against a
# non-super platform user — without minting one, this guard would look like it worked while doing
# nothing at all.
HASH=$(psql "select password_hash from users where email='admin@qparts.local'")
psql "insert into users (email, full_name, password_hash, is_active)
      values ('rolecheck@qparts.local','Role Check','$HASH',true)
      on conflict (email) do update set is_active=true" > /dev/null
psql "insert into platform_members (user_id, role, is_active)
      select id,'purchasing',true from users where email='rolecheck@qparts.local'
      on conflict do nothing" > /dev/null
PTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"rolecheck@qparts.local","password":"admin1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")

wfclean
FID2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-roles","nameAr":"صلاحيات","nameEn":"Roles","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FID2/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","allowedRoles":["finance_manager"]}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$FID2/activate"

ok 1 "$(ACTOR=$PTOK blocked "$(ACTOR=$PTOK pick_winner ROLE-DENY)")" \
  "a role rule refuses an actor who does not hold the role"
ok 0 "$(blocked "$(pick_winner ROLE-GLASS)")" \
  "but a platform super_admin is break-glass and still gets through"

# activation refuses an owner role nobody holds — the check that stops a workspace locking itself out
FID3=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-unstaffed","nameAr":"غير مأهول","nameEn":"Unstaffed","isDefault":false}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FID3/graph" -d '{"selectionCondition":{"any":true},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100,"ownerRoles":["vendor_admin"]},
          {"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}'
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$FID3/activate" | $PY -c "
import sys,json;d=json.load(sys.stdin);print(1 if 'nobody in this workspace holds' in str(d.get('message','')) else 0)")" \
  "activation refuses a step owned by a role nobody holds"

wfclean
psql "delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'ROLE-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ROLE-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ROLE-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'ROLE-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'ROLE-%';
      delete from platform_members where user_id in (select id from users where email='rolecheck@qparts.local');
      delete from users where email='rolecheck@qparts.local'" > /dev/null

# ── status -> page routing (0048) ───────────────────────────────────────────────────────────────
# The load-bearing rule is the SAFETY one: a status the flow routes NOWHERE must keep appearing on
# every page. Without it, the first time an admin routes one status, every other status silently
# vanishes from every queue — live work hidden, no error anywhere.
rcount(){ curl -s "${AR[@]}" "$B/api/rfqs$1" | $PY -c "import sys,json;print(json.load(sys.stdin)['count'])"; }
RSTATUS=$(psql "select s.code from rfqs r join item_statuses s on s.id=r.status_id limit 1")
BASE=$(rcount "")

wfclean
ok "$BASE" "$(rcount '?queue=rfqs')" "with no active flow, ?queue= filters nothing"

# route the status the existing RFQ is actually at, to a DIFFERENT page
FID4=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-route","nameAr":"توجيه","nameEn":"Route","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FID4/graph" \
  -d "$(printf '{"selectionCondition":{},"steps":[{"status":"%s","isEntry":true,"x":80,"y":100,"pages":["orders"]},{"status":"settled","isTerminal":true,"x":340,"y":100}],"transitions":[{"from":"%s","to":"settled","labelEn":"Settle"}]}' "$RSTATUS" "$RSTATUS")"
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$FID4/activate"
ok "$BASE" "$(rcount '?queue=orders')" "a routed status appears on the page it was routed to"
ok 0        "$(rcount '?queue=rfqs')"   "and NOT on a page it was not routed to"
ok "$BASE" "$(rcount '')"               "asking for no queue still returns everything"

# now the same status is routed NOWHERE — it must come back on every page
wfclean
FID5=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-route2","nameAr":"توجيه","nameEn":"Route2","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FID5/graph" \
  -d "$(printf '{"selectionCondition":{},"steps":[{"status":"%s","isEntry":true,"x":80,"y":100},{"status":"settled","isTerminal":true,"x":340,"y":100,"pages":["orders"]}],"transitions":[{"from":"%s","to":"settled","labelEn":"Settle"}]}' "$RSTATUS" "$RSTATUS")"
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$FID5/activate"
ok "$BASE" "$(rcount '?queue=rfqs')"   "SAFETY RULE: an unrouted status still appears on every page"
ok "$BASE" "$(rcount '?queue=orders')" "SAFETY RULE: including pages other statuses are routed to"
wfclean

# ── custody / handoff (0049) ────────────────────────────────────────────────────────────────────
# The three modes are the whole answer to "who hands off to whom", and they are easy to get subtly
# wrong (a move that silently keeps custody with the previous desk looks fine until nobody picks the
# work up). Each is driven for real through new_rfq -> priced.
custody(){ # $1 = handoff mode -> echoes "<assignee-email-or-POOL> <role>"
  wfclean
  local F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d "$(printf '{"flowKey":"smoke-cust-%s","nameAr":"عهدة","nameEn":"Custody","isDefault":true}' "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" \
    -d "$(printf '{"selectionCondition":{},"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100,"ownerRoles":["company_admin"],"slaHours":8}],"transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","handoff":"%s"}]}' "$1")"
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$F/activate"
  pick_winner "CUST-$1" > /dev/null
  psql "select coalesce((select email from users where id=rs.assignee_user_id),'POOL')
        from workflow_record_state rs
        join rfq_items i on i.id = rs.entity_id
        join rfqs r on r.id = i.rfq_id where r.plate_number='CUST-$1' limit 1"
}
ok "manager@qparts.local" "$(custody pool)"  "handoff=pool lands on the destination step's only owner"
ok "admin@qparts.local"   "$(custody actor)" "handoff=actor gives it to whoever made the move"
ok "POOL"                 "$(custody keep)"  "handoff=keep leaves an unheld record unheld"

# the SLA target becomes a real deadline on the record
ok true "$(psql "select (due_at is not null and due_at > now() + interval '7 hours')::text
              from workflow_record_state rs join rfq_items i on i.id = rs.entity_id
              join rfqs r on r.id = i.rfq_id where r.plate_number like 'CUST-%' limit 1")" \
  "the step's target duration becomes a due date on the record"

ok t "$(psql "select prosrc like '%NEW.handoff%' from pg_proc where proname='workflow_child_freeze'")" \
  "the freeze trigger governs handoff too"

# my-work must answer, and must not explode on an empty workspace
ok 200 "$(curl -s -o /dev/null -w '%{http_code}' "${AR[@]}" "$B/api/admin/workflows/my-work")" \
  "GET /my-work answers"

wfclean
psql "delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'CUST-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'CUST-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'CUST-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'CUST-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'CUST-%'" > /dev/null
