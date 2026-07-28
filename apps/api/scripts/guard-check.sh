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

# Every workspace now ARRIVES with an active default flow (template.ts / template.service.ts), and
# nearly every test below installs a default flow of its own. Two active defaults in one status
# domain is a unique-index violation (workflow_flows_default_uq), so wfclean PARKS the standard
# flows back to 'draft' and wfrestore puts them back at the end of the file.
#
# Parked, not deleted: the standard flow is the workspace's real configuration and carries its
# version history, and a test suite that deletes a customer's workflow to make room for its own is
# one bad `psql` away from doing it somewhere that matters. Parking also keeps the existing "with NO
# active workflow …" checks below honest — permissive-until-configured is still a real property, and
# it is still asserted, on a workspace that genuinely has nothing active.
STD_KEYS="'standard','standard-vendor'"

wfclean(){
  psql "alter table workflow_flows disable trigger trg_workflow_flows_freeze;
        alter table workflow_steps disable trigger trg_workflow_steps_freeze;
        alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
        delete from workflow_transitions where flow_id in (select id from workflow_flows where flow_key like 'smoke-%');
        delete from workflow_steps       where flow_id in (select id from workflow_flows where flow_key like 'smoke-%');
        delete from workflow_record_state where flow_id in (select id from workflow_flows where flow_key like 'smoke-%');
        delete from workflow_flows where flow_key like 'smoke-%';
        update workflow_flows set status='draft' where flow_key in ($STD_KEYS) and status='active';
        alter table workflow_flows enable trigger trg_workflow_flows_freeze;
        alter table workflow_steps enable trigger trg_workflow_steps_freeze;
        alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null
}

# Put the workspace's own workflow back exactly as provisioning left it: the NEWEST version of each
# standard key active again, older ones untouched (a reset test leaves a retired predecessor behind
# and it must stay retired).
#
# A run that dies partway leaves the standard flows parked as drafts, and nothing repairs that on its
# own — provisioning skips a workspace that already has a flow, so a restart will not undo it. The
# repair is to run this suite again: its standard-flow section opens with wfrestore.
wfrestore(){
  psql "alter table workflow_flows disable trigger trg_workflow_flows_freeze;
        with latest as (
          select distinct on (tenant_id, environment, flow_key) id
          from workflow_flows where flow_key in ($STD_KEYS)
          order by tenant_id, environment, flow_key, version desc)
        update workflow_flows set status='active'
        where id in (select id from latest) and status='draft';
        alter table workflow_flows enable trigger trg_workflow_flows_freeze" > /dev/null
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
# selectionCondition was '{"any":true}' here, which is not a condition at all — and since 0065 it is
# EVALUATED, where `any` not being an array makes isEmptyCondition() read the whole thing as empty
# and the flow silently match every record. The save now refuses that shape; '{}' is the deliberate
# way to say "everything", and this flow never activates anyway (that is what it is testing).
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FID3/graph" -d '{"selectionCondition":{},
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

# ── page roles (0050 / QNEW-89 §3) ──────────────────────────────────────────────────────────────
# The shape change from ["rfqs"] to [{page,mode}] silently breaks jsonb containment, and the routing
# predicate used exactly that. If these two ever fail together, every routed status has vanished from
# every screen — the failure the safety rule exists to prevent, caused by the migration itself.
ok true "$(psql "select ('[\"rfqs\"]'::jsonb @> to_jsonb('rfqs'::text))::text")" \
  "jsonb containment finds a bare key in a FLAT array (the old shape)"
ok false "$(psql "select ('[{\"page\":\"rfqs\",\"mode\":\"action\"}]'::jsonb @> to_jsonb('rfqs'::text))::text")" \
  "but NOT in an array of objects — which is why routing.ts had to change with the migration"

ok 0 "$(psql "select count(*) from workflow_steps s
              where jsonb_array_length(s.pages) > 0
                and not exists (select 1 from jsonb_array_elements(s.pages) e where e ? 'mode')")" \
  "every placement carries a mode after the migration"

# the shape CHECK must refuse the old form and an unknown mode. Wrapped in a transaction that rolls
# back — an earlier version of this check ran a bare UPDATE and wiped every placement in the database.
ok "refused|refused" "$(psql "begin;
  do \$\$ begin update workflow_steps set pages='[\"rfqs\"]'::jsonb; raise notice 'ACCEPTED';
     exception when check_violation then raise notice 'refused'; end \$\$;
  do \$\$ begin update workflow_steps set pages='[{\"page\":\"rfqs\",\"mode\":\"typo\"}]'::jsonb; raise notice 'ACCEPTED';
     exception when check_violation then raise notice 'refused'; end \$\$;
  rollback;" 2>&1 | /usr/bin/grep -o 'refused\|ACCEPTED' | /usr/bin/paste -sd'|' -)" \
  "the shape check refuses the old flat form and an unknown mode"

# routing still resolves through the new shape. Read off the workspace's own STANDARD flow, which is
# provisioned rather than seeded, so the number is a property of the template (template.ts) and not
# of whatever a developer last drew: six item statuses are placed on the Requests screen.
ok 6 "$(psql "select count(*) from workflow_steps ws
              join workflow_flows f on f.id = ws.flow_id
              join tenants t on t.id = f.tenant_id and t.slug = 'riyadh'
              where f.flow_key = 'standard' and f.environment = 'live'
                and exists (select 1 from jsonb_array_elements(ws.pages) e where e->>'page'='rfqs')")" \
  "routing resolves a page key out of the new {page,mode} shape"

# A status can now be an `action` station on several screens, so two people pressing two buttons on
# the same record is ordinary use. Without the row lock both reads see the same status, both pass the
# guard, and the loser writes a status_logs row claiming a move from a state it was never in.
ok 1 "$(/usr/bin/grep -c "order by id for update" "$(cd "$(dirname "$0")/.." && pwd)/src/common/status.service.ts")" \
  "the status gateway locks the rows it is about to move"

# §3.4 — the canonical case: ONE status, two stations, two different roles.
#
# Built here rather than borrowed from a fixture. This used to reach into a seeded demo flow, which
# has been removed because it drew statuses the product never writes; and the flow that replaced it
# is the workspace's REAL, live default, so mutating its routing to prove a point about routing
# would be changing live configuration from a test.
wfclean
WFI=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-place","nameAr":"أماكن","nameEn":"Placement","isDefault":false}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$WFI/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced"},{"from":"priced","to":"confirmed"}]}'
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$WFI/placement" \
  -d '{"status":"priced","pages":[{"page":"rfqs","mode":"action"},{"page":"workshop_requests","mode":"watch"}]}'
ok "action|watch" "$(psql "select string_agg(e->>'mode', '|' order by e->>'page')
                           from workflow_steps s
                           join item_statuses i on i.id = s.item_status_id,
                           lateral jsonb_array_elements(s.pages) e
                           where i.code='priced' and s.flow_id='$WFI'")" \
  "one status can be ACTION on the desk that owns it and WATCH on the portal tracking it"

# a watch station still SHOWS the record — read-only is not invisible
ok 1 "$(psql "select count(*) from workflow_steps ws
              where ws.flow_id='$WFI'
                and exists (select 1 from jsonb_array_elements(ws.pages) e
                            where e->>'page'='workshop_requests')")" \
  "a watch placement is visible to the routing predicate (read-only, not hidden)"
wfclean

# ── exit gates (0051 / QNEW-89 §4) ──────────────────────────────────────────────────────────────
# Drives a two-line RFQ where only ONE line gets a winning quote, then tries to confirm. A gate that
# only returns true/false is useless on a disabled button, so these assert the NAMED offending line
# as well as the refusal.
gate_flow(){ # $1 = gates json for the confirm transition
  wfclean
  local F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d '{"flowKey":"smoke-gate","nameAr":"بوابة","nameEn":"Gate","isDefault":true}' \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "{\"selectionCondition\":{},
   \"steps\":[{\"status\":\"new_rfq\",\"isEntry\":true,\"x\":80,\"y\":100},
             {\"status\":\"priced\",\"x\":340,\"y\":100},
             {\"status\":\"confirmed\",\"isTerminal\":true,\"x\":600,\"y\":100}],
   \"transitions\":[{\"from\":\"new_rfq\",\"to\":\"priced\",\"labelEn\":\"Price\"},
                   {\"from\":\"new_rfq\",\"to\":\"confirmed\",\"labelEn\":\"Confirm\",\"gates\":$1},
                   {\"from\":\"priced\",\"to\":\"confirmed\",\"labelEn\":\"Confirm\",\"gates\":$1}]}"
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$F/activate"
}

half_priced_rfq(){ # two lines, only the first gets a winning quote -> echoes the confirm response
  local rid tok it qi
  rid=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"AA-1","quantity":1},{"partNumber":"BB-2","quantity":1}]}' "$BR" "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  it=$(psql "select id from rfq_items where rfq_id='$rid' order by part_number limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$rid/items/$it/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
  curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/confirm" -d '{}'
}

gate_flow '[{"gate":"all_items_at_status","params":{"status":"priced"},"enforcement":"block"}]'
GR=$(half_priced_rfq GATE-A)
ok 1 "$(echo "$GR" | $PY -c "import sys,json;print(1 if json.load(sys.stdin).get('gates') else 0)")" \
  "a gate refuses the move when the business is not ready"
ok "BB-2" "$(echo "$GR" | $PY -c "
import sys,json;g=json.load(sys.stdin)['gates'][0]
print(g['offending'][0].split(' ')[0] if g['offending'] else 'none')")" \
  "and NAMES the line standing in the way, so the button can say what to fix"
ok False "$(echo "$GR" | $PY -c "import sys,json;print(json.load(sys.stdin)['canOverride'])")" \
  "a block gate cannot be overridden"

gate_flow '[{"gate":"all_items_at_status","params":{"status":"priced"},"enforcement":"warn_override"}]'
ok True "$(half_priced_rfq GATE-B | $PY -c "import sys,json;print(json.load(sys.stdin)['canOverride'])")" \
  "the same rule as warn_override offers an override instead"

# enforcement must be resolved when it is STORED: the DB CHECK requires it, so a payload that omits
# it used to produce a row Postgres refused while the API reported success.
gate_flow '[{"gate":"min_quotes_per_item","params":{"n":3}}]'
ok warn_override "$(psql "select distinct e->>'enforcement' from workflow_transitions t,
                          lateral jsonb_array_elements(t.gates) e where jsonb_array_length(t.gates)>0")" \
  "a gate saved without an enforcement takes the catalog's default"

wfclean
psql "delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'GATE-%');
      delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'GATE-%'));
      delete from orders where rfq_id in (select id from rfqs where plate_number like 'GATE-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'GATE-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'GATE-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'GATE-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'GATE-%'" > /dev/null

# ── record conditions (QNEW-89 §4.1) ────────────────────────────────────────────────────────────
# `condition` was stored, round-tripped, frozen by triggers and evaluated by NOTHING since the engine
# was built. This is the owner's own branching example: the same status leads one way for an insurance
# customer and nowhere for anyone else.
wfclean
FIDC=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-cond","nameAr":"شرط","nameEn":"Cond","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FIDC/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price",
   "condition":{"all":[{"field":"payer_type","op":"eq","value":"insurance"}]}}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$FIDC/activate"

cond_attempt(){ # $1=plate $2=payer -> echoes the winning-quote response
  local rid tok it qi
  rid=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"P1","quantity":1}]}' "$BR" "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  psql "update rfqs set payer_type='$2' where id='$rid'" > /dev/null
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  it=$(psql "select id from rfq_items where rfq_id='$rid' limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/items/$it/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
}

ok 0 "$(blocked "$(cond_attempt COND-INS insurance)")" \
  "a condition lets the move through when the record matches it"
ok 1 "$(blocked "$(cond_attempt COND-CASH cash_client)")" \
  "and refuses it when the record does not"
ok 1 "$(cond_attempt COND-CASH2 cash_client | $PY -c "
import sys,json;print(1 if 'Who pays' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "the refusal names the RULE in plain words, not just 'not allowed'"

# a line inherits its request's facts, or a condition on the payer could never be judged on the
# line-level moves, which is where most of the work happens
ok 1 "$(psql "select count(*) from workflow_transitions where condition::text like '%payer_type%'")" \
  "the condition survives a save (it is not silently reset to {})"

wfclean
psql "delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'COND-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'COND-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'COND-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'COND-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'COND-%'" > /dev/null

# ── approval gates (0052 / QNEW-89 §6) ──────────────────────────────────────────────────────────
# `requires_approval` was storable, drawn as a padlock, and enforced NOWHERE, while a complete
# approvals engine sat in another module with zero references between them. This is the round trip.
MGRID=$(psql "select id from users where email='manager@qparts.local'")
MTOK2=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"manager@qparts.local","password":"manager1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
MR=(-H "Authorization: Bearer $MTOK2" -H "X-Tenant: riyadh" -H "Content-Type: application/json")

wfclean
psql "delete from approval_actions; delete from approval_requests; delete from approval_levels; delete from approval_policies" > /dev/null
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/approvals/policies" \
  -d "$(printf '{"name":"Pricing sign-off","entityType":"rfq_item","levels":[{"approverUserId":"%s"}]}' "$MGRID")"
FIDA=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-appr","nameAr":"موافقة","nameEn":"Appr","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$FIDA/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","requiresApproval":true}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$FIDA/activate"

APR=$(pick_winner APPR-1)
ok 1 "$(echo "$APR" | $PY -c "import sys,json;print(1 if json.load(sys.stdin).get('needsApproval') else 0)")" \
  "a padlocked move is refused until it is signed off"
ok "new_rfq>priced" "$(echo "$APR" | $PY -c "import sys,json;print(json.load(sys.stdin).get('transitionKey'))")" \
  "and says WHICH move needs the signature"

# the guard must not write: it runs inside the caller's transaction, which its own refusal rolls back
ok 0 "$(psql "select count(*) from approval_requests")" \
  "the refusal creates NO request — the guard judges, it does not write"

APIT=$(psql "select i.id from rfq_items i join rfqs r on r.id=i.rfq_id where r.plate_number='APPR-1' limit 1")
REQ1=$(curl -s "${AR[@]}" -X POST "$B/api/approvals/request-move" \
  -d "$(printf '{"entityType":"rfq_item","entityId":"%s","transitionKey":"new_rfq>priced"}' "$APIT")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('requestId',''))")
ok True "$(curl -s "${AR[@]}" -X POST "$B/api/approvals/request-move" \
  -d "$(printf '{"entityType":"rfq_item","entityId":"%s","transitionKey":"new_rfq>priced"}' "$APIT")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('joined'))")" \
  "asking twice joins the request already waiting instead of splitting the approvers"

ACT=$(curl -s "${MR[@]}" -X POST "$B/api/approvals/requests/$REQ1/act" -d '{"action":"approve"}')
ok True "$(echo "$ACT" | $PY -c "import sys,json;print(json.load(sys.stdin).get('moved'))")" \
  "THE FINAL APPROVAL PERFORMS THE MOVE — nothing here would ever unstick it otherwise"
ok priced "$(psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$APIT'")" \
  "and the record actually arrives at the status it was signed off for"
ok 1 "$(psql "select count(*) from approval_requests where consumed_at is not null")" \
  "the grant is spent, so it cannot authorise the same move twice"

# ── the approvals inbox — the screen the chain must not ship without ────────────────────────────
# A chain creates records that wait BY DESIGN, and there is no scheduler here to tell anyone. If the
# approver cannot see the decision, the engine has simply stopped orders for no visible reason.
psql "delete from approval_actions; delete from approval_requests" > /dev/null
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/approvals/request-move" \
  -d "$(printf '{"entityType":"rfq_item","entityId":"%s","transitionKey":"new_rfq>priced"}' "$APIT")"

ok 1 "$(curl -s "${MR[@]}" "$B/api/approvals" | $PY -c "import sys,json;print(len(json.load(sys.stdin)['waitingOnMe']))")" \
  "the named approver sees the decision waiting on them"
ok 0 "$(curl -s "${AR[@]}" "$B/api/approvals" | $PY -c "import sys,json;print(len(json.load(sys.stdin)['waitingOnMe']))")" \
  "and someone who is not the approver does not"
ok 1 "$(curl -s "${AR[@]}" "$B/api/approvals" | $PY -c "import sys,json;print(len(json.load(sys.stdin)['mine']))")" \
  "the requester can see what they asked for and who it is sitting with"

# 0045 stopped a workspace user reading the directory, so the requester's name is snapshotted rather
# than joined — otherwise the approver is asked to authorise something "by someone".
ok 1 "$(curl -s "${MR[@]}" "$B/api/approvals" | $PY -c "
import sys,json;print(1 if json.load(sys.stdin)['waitingOnMe'][0].get('requested_by_name') else 0)")" \
  "the approver can see WHO asked, without the directory being opened to them"

wfclean
psql "delete from approval_actions; delete from approval_requests; delete from approval_levels; delete from approval_policies;
      delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'APPR-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'APPR-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'APPR-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'APPR-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'APPR-%'" > /dev/null

# ── exception flows (0054 / QNEW-89 §7) ─────────────────────────────────────────────────────────
# Cancellation and return as flows ATTACHED to a record rather than statuses spliced into its chain.
# The distinction is the whole design: an order that merely has a cancellation REQUESTED must still
# be `confirmed`, or there is nothing to put back when the request is refused.
wfclean
psql "delete from workflow_exceptions;
      delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'EXC-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'EXC-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'EXC-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'EXC-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'EXC-%'" > /dev/null
# a record of our own, quoted and ready to move — otherwise the "frozen" assertion below can pass
# for the wrong reason (a validation error rather than the freeze).
EXRFQ=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"EXC-1","items":[{"partNumber":"P1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
EXTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$EXRFQ/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
EXIT_ID=$(psql "select id from rfq_items where rfq_id='$EXRFQ' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$EXTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$EXIT_ID")"
EXQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$EXIT_ID' limit 1")
EXBEFORE=$(psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$EXIT_ID'")

EXC=$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions" \
  -d "$(printf '{"entityType":"rfq_item","entityId":"%s","kind":"cancellation","reason":"customer changed their mind"}' "$EXIT_ID")")
EXID=$(echo "$EXC" | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$([ -n "$EXID" ] && echo 1 || echo 0)" "a cancellation can be raised against a live record"

# THE FREEZE. Not one of the workflow's rules — a statement that the record must not move at all.
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$EXRFQ/items/$EXIT_ID/winning-quote" \
  -d "$(printf '{"quoteItemId":"%s"}' "$EXQI")" \
  | $PY -c "import sys,json;print(1 if 'being reviewed' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "while it is open the record is FROZEN, whatever the workflow says"
ok "$EXBEFORE" "$(psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$EXIT_ID'")" \
  "and the record keeps its real status — it did not become 'cancellation requested'"

ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions/$EXID/resolve" -d '{"decision":"approve"}' \
  | $PY -c "import sys,json;print(1 if 'cannot decide' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "the person who asked for it cannot decide it"

ok "$EXBEFORE" "$(curl -s "${MR[@]}" -X POST "$B/api/workflow/exceptions/$EXID/resolve" \
  -d '{"decision":"reject","note":"they changed their mind back"}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('restoredTo'))")" \
  "refusing it restores the EXACT status the record was frozen at"

ok 0 "$(psql "select count(*) from workflow_exceptions where status='open'")" \
  "and the freeze lifts once it is decided"

psql "delete from workflow_exceptions;
      delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'EXC-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'EXC-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'EXC-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'EXC-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'EXC-%'" > /dev/null

# ── auto-advance + loop prevention (0055 / QNEW-89 §5.2 + QNEW-90 item 5) ───────────────────────
# These are tested together because they must SHIP together: automation without a loop guard walks
# an order to the end of the flow, or round in a circle, in one transaction nobody asked for.
auto_flow(){ # $1 = transitions json, $2 = plate suffix -> echoes the status it ENDED at
  wfclean
  psql "delete from workflow_auto_fired" > /dev/null
  local F rid tok it qi
  F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d '{"flowKey":"smoke-auto","nameAr":"تلقائي","nameEn":"Auto","isDefault":true}' \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "{\"selectionCondition\":{},
   \"steps\":[{\"status\":\"new_rfq\",\"isEntry\":true,\"x\":80,\"y\":100},
             {\"status\":\"priced\",\"x\":340,\"y\":100},
             {\"status\":\"confirmed\",\"x\":600,\"y\":100},
             {\"status\":\"processing\",\"isTerminal\":true,\"x\":860,\"y\":100}],
   \"transitions\":$1}"
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$F/activate"
  rid=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"AUTO-%s","items":[{"partNumber":"P1","quantity":1}]}' "$BR" "$2")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  it=$(psql "select id from rfq_items where rfq_id='$rid' limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$rid/items/$it/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
  echo "$it" > /tmp/qvm_auto_item
  psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$it'"
}

ok priced "$(auto_flow '[{"from":"new_rfq","to":"priced","labelEn":"Price"},
  {"from":"priced","to":"confirmed","labelEn":"Confirm"},
  {"from":"confirmed","to":"processing","labelEn":"Process"}]' A)" \
  "nothing moves on its own unless a transition opts in"

ok processing "$(auto_flow '[{"from":"new_rfq","to":"priced","labelEn":"Price"},
  {"from":"priced","to":"confirmed","labelEn":"Confirm","autoAdvance":true},
  {"from":"confirmed","to":"processing","labelEn":"Process","autoAdvance":true}]' B)" \
  "an opted-in chain carries the record forward by itself"
ok 2 "$(psql "select count(*) from status_logs where entity_id='$(cat /tmp/qvm_auto_item)' and auto_advanced")" \
  "and each automatic step is recorded AS automatic"
ok 1 "$(psql "select count(*) from (select distinct changed_by from status_logs
               where entity_id='$(cat /tmp/qvm_auto_item)' and auto_advanced and changed_by is null) x")" \
  "with NO actor — attributing it to whoever triggered it would be a false audit record"

# THE LOOP. Two transitions that each satisfy the other, both auto, both allowed to repeat.
ok confirmed "$(auto_flow '[{"from":"new_rfq","to":"priced","labelEn":"Price"},
  {"from":"priced","to":"confirmed","labelEn":"Confirm","autoAdvance":true,"autoOnce":false},
  {"from":"confirmed","to":"priced","labelEn":"Back","autoAdvance":true,"autoOnce":false},
  {"from":"confirmed","to":"processing","labelEn":"Process"}]' C)" \
  "a deliberate cycle terminates instead of running forever"
ok 3 "$(psql "select count(*) from status_logs where entity_id='$(cat /tmp/qvm_auto_item)' and auto_advanced")" \
  "and stops at the depth cap — exactly 3 automatic moves, not more"

wfclean
psql "delete from workflow_auto_fired; delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'AUTO-%');
      delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'AUTO-%'));
      delete from orders where rfq_id in (select id from rfqs where plate_number like 'AUTO-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'AUTO-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'AUTO-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'AUTO-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'AUTO-%'" > /dev/null

# ── what a move DOES (0056) + a hold is not a cancellation (0057 / QNEW-90 items 3, 4) ───────────
# Every check below started life as a real defect, which is why they are here rather than in a
# throwaway script: an action that wrote to a column that does not exist; a hold filed as a
# cancellation and rendered one click from ending a live order; a hold that swallowed the very
# operation that placed it and rolled the whole thing back with a message about a return.
wfclean
psql "delete from workflow_exceptions; delete from workflow_action_runs; delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'ACTS-%'));
      delete from orders where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ACTS-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'ACTS-%'" > /dev/null

# An action the server does not know must be refused at SAVE time. Discovering it at run time means
# the flow looks configured and quietly does nothing.
ACF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-acts","nameAr":"أفعال","nameEn":"Acts","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$(curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$ACF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"P","actions":[{"action":"bogus_action"}]}]}' \
  | $PY -c "import sys,json;print(1 if 'unknown action' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "an action this server does not know is refused when the flow is SAVED"

# The real flow: pricing a line puts it on hold, and cutting the order fills a field on the header.
# Two transitions in two separate requests, which is the only way to test that a freeze outlives the
# operation that recorded it.
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$ACF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[
   {"from":"new_rfq","to":"priced","labelEn":"Price","actions":[{"action":"lock_record","params":{"reason":"the price needs a look"}}]},
   {"from":"priced","to":"confirmed","labelEn":"Confirm line"},
   {"from":"new_rfq","to":"confirmed","labelEn":"Confirm header","actions":[{"action":"set_field","params":{"field":"shipping_type","value":"express"}}]}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$ACF/activate"

ACR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"ACTS-1","items":[{"partNumber":"P1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ACTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$ACR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
ACIT=$(psql "select id from rfq_items where rfq_id='$ACR' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$ACTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$ACIT")"
ACQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$ACIT' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$ACR/items/$ACIT/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$ACQI")"

ok priced "$(psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$ACIT'")" \
  "an action that freezes the record does not veto the move that triggered it"
ok hold/open "$(psql "select kind||'/'||status from workflow_exceptions where entity_id='$ACIT'")" \
  "lock_record files a HOLD, not a cancellation"
ok "the workflow" "$(psql "select requested_by_name from workflow_exceptions where entity_id='$ACIT'")" \
  "and names the engine as what placed it, not whoever tripped it"

ACEID=$(psql "select id from workflow_exceptions where entity_id='$ACIT'")
ok 1 "$(curl -s "${AR[@]}" "$B/api/workflow/exceptions" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(1 if not d['open'] and len(d['held'])==1 else 0)")" \
  "a hold is kept OUT of the inbox that renders a 'Cancel it' button"
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions/$ACEID/resolve" -d '{"decision":"approve"}' \
  | $PY -c "import sys,json;print(1 if 'release it instead' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "and cannot be approved at all — there is no path from a hold to 'cancelled'"

# THE COMPOSITION FAILURE. The freeze must reach a later operation, and refusing it must undo
# everything that operation had already done — including the action that ran before it.
ACCONF=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$ACR/confirm" -d '{}')
ok 1 "$(echo "$ACCONF" | $PY -c "import sys,json;print(1 if 'on hold' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a hold recorded EARLIER stops a later operation, and says so as a hold"
ok 0 "$(psql "select count(*) from orders where rfq_id='$ACR'")" "which produced no order"
ok "" "$(psql "select coalesce(shipping_type,'') from rfqs where id='$ACR'")" \
  "and rolled back the action that had already run on the header"

curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/workflow/exceptions/$ACEID/release" -d '{"note":"looked at"}'
ok released "$(psql "select status from workflow_exceptions where id='$ACEID'")" \
  "releasing a hold records it as released, not as a request that was rejected"
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$ACR/confirm" -d '{}'
ok express "$(psql "select coalesce(shipping_type,'') from rfqs where id='$ACR'")" \
  "and then the same operation goes through, action and all"
ok 1 "$(psql "select count(*) from workflow_action_runs where outcome='ok' and action='set_field'")" \
  "with the run log showing outcome=ok — a column that actually exists"

# A cancellation is somebody's question. The release path must not be able to answer it.
ACO=$(psql "select id from orders where rfq_id='$ACR' limit 1")
ACC=$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions" \
  -d "$(printf '{"entityType":"order","entityId":"%s","kind":"cancellation","reason":"they changed their mind"}' "$ACO")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions/$ACC/release" -d '{}' \
  | $PY -c "import sys,json;print(1 if 'do not release' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "release refuses a cancellation — only a person may answer one"
ok open "$(psql "select status from workflow_exceptions where id='$ACC'")" \
  "and it stays open for whoever has to decide it"

wfclean
psql "delete from workflow_exceptions; delete from workflow_action_runs; delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'ACTS-%'));
      delete from orders where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ACTS-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'ACTS-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'ACTS-%'" > /dev/null

# ── the SIXTH place, and the freeze tuple's newer members ────────────────────────────────────────
# The five-place rule (zod schema → get() SELECT → saveGraph INSERT → newVersion clone → AI result
# schema) names five places a transition field must be plumbed through. It misses a sixth, and the
# sixth is the only one a user can reach: WorkflowCanvas.tsx builds the save payload from its own
# `Edge` interface, and `PUT :id/graph` REPLACES every transition. A field the canvas does not carry
# is therefore not merely un-editable — it is destroyed the next time anyone drags a node and saves.
#
# That is not hypothetical. actions, condition, auto_advance and auto_once were all missing from
# that interface, so opening the builder and moving one box wiped every action, every condition and
# every automatic move in the flow.
#
# TWO CHECKS, because neither half is sufficient alone and a bash suite cannot drive React:
#   - the round trip below asserts the API PRESERVES what a canvas-shaped save sends;
#   - the greps after it assert the canvas still SENDS it.
# The first would have stayed green all through the bug. Only the second catches it.
wfclean
RTF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-rt","nameAr":"ذهاب وعودة","nameEn":"Round trip","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$RTF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"P","priority":5,"autoAdvance":true,"autoOnce":false,
   "condition":{"all":[{"field":"payer_type","op":"eq","value":"insurance"}]},
   "actions":[{"action":"lock_record","params":{"reason":"look at it"}}]}]}'
# now save again with EXACTLY the payload the canvas sends, as if a node had been nudged
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$RTF/graph" \
  -d "$(curl -s "${AR[@]}" "$B/api/admin/workflows/$RTF" | $PY -c "
import sys, json
f = json.load(sys.stdin)
print(json.dumps({
  'selectionCondition': {},
  'steps': [{'status': s['status'], 'isEntry': s['is_entry'], 'isTerminal': s['is_terminal'],
             'slaHours': s.get('sla_hours'), 'x': s['x'] + 10, 'y': s['y'],
             'pages': s.get('pages', []), 'ownerRoles': s.get('owner_roles', [])} for s in f['steps']],
  # the canvas Edge interface, field for field
  'transitions': [{'from': t['from'], 'to': t['to'], 'labelEn': t.get('label_en'),
                   'requiresApproval': t['requires_approval'], 'allowedRoles': t.get('allowed_roles', []),
                   'priority': t['priority'], 'handoff': t['handoff'], 'gates': t.get('gates', []),
                   'actions': t.get('actions', []), 'condition': t.get('condition', {}),
                   'autoAdvance': t['auto_advance'], 'autoOnce': t['auto_once']} for t in f['transitions']],
}))")"
RT=$(curl -s "${AR[@]}" "$B/api/admin/workflows/$RTF" | $PY -c "
import sys, json
t = json.load(sys.stdin)['transitions'][0]
print('%s|%s|%s|%s' % (len(t.get('actions') or []), 'yes' if (t.get('condition') or {}) else 'no',
                       t['auto_advance'], t['auto_once']))")
ok "1|yes|True|False" "$RT" \
  "a canvas-shaped save preserves actions, condition and auto-advance instead of wiping them"

# The client-side half of the same guarantee. A bash suite cannot drive React, but it can assert the
# payload builder still mentions every field — which is exactly the check that would have caught it.
CANVAS=apps/web/src/pages/admin/WorkflowCanvas.tsx
for FIELD in actions condition autoAdvance autoOnce; do
  ok 1 "$(/usr/bin/grep -c "e\.$FIELD" "$(dirname "$0")/../../../$CANVAS" 2>/dev/null | /usr/bin/head -1 | { read n; [ "${n:-0}" -gt 0 ] && echo 1 || echo 0; })" \
    "the canvas save payload still carries $FIELD"
done

# The freeze tuple has now been hand-retyped by six migrations. Nothing asserted its newer members,
# so a seventh retype that dropped one would un-freeze it on every active flow, silently.
for COL in actions gates auto_advance auto_once; do
  ok t "$(psql "select prosrc like '%NEW.$COL%' from pg_proc where proname='workflow_child_freeze'")" \
    "the freeze trigger still governs $COL"
done

wfclean

# ── THE RUN LOG GETS A SCREEN (QNEW-90 item 6) ───────────────────────────────────────────────────
# /workflow/run-log is the ONLY place an action failure is visible. runActions() may never throw, so
# a rule that breaks leaves the record moved, the flow looking configured, and nothing anywhere
# saying otherwise. Every check below is a way that visibility could be lost while the suite stayed
# green: the log showing one half of the story, the failure filter swallowing or inventing rows, the
# count going blind past the page, the wrong people locked out or let in.
rlclean(){
  psql "delete from workflow_action_runs; delete from workflow_exceptions; delete from status_logs;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'RLOG-%');
        delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'RLOG-%'));
        delete from orders where rfq_id in (select id from rfqs where plate_number like 'RLOG-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'RLOG-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'RLOG-%');
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'RLOG-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from rfqs where plate_number like 'RLOG-%'" > /dev/null
}
wfclean; rlclean

# One flow, all three outcomes, on purpose:
#   new_rfq → priced    fires on the LINE, and set_field is header-only        → skipped
#   new_rfq → confirmed fires on the HEADER: shipping_type is writable         → ok
#                                            client_po is not, on an rfq       → failed
RLF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-rl","nameAr":"سجل التشغيل","nameEn":"Run log","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$RLF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[
   {"from":"new_rfq","to":"priced","labelEn":"Price","actions":[{"action":"set_field","params":{"field":"shipping_type","value":"express"}}]},
   {"from":"priced","to":"confirmed","labelEn":"Confirm line"},
   {"from":"new_rfq","to":"confirmed","labelEn":"Confirm header","actions":[
      {"action":"set_field","params":{"field":"shipping_type","value":"express"}},
      {"action":"set_field","params":{"field":"client_po","value":"PO-9"}}]}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$RLF/activate"

RLR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"RLOG-1","items":[{"partNumber":"RLOG-P1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
RLTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$RLR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
RLIT=$(psql "select id from rfq_items where rfq_id='$RLR' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$RLTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$RLIT")"
RLQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$RLIT' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$RLR/items/$RLIT/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$RLQI")"
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$RLR/confirm" -d '{}'

# BOTH HALVES OR THE SCREEN IS MISNAMED. status_logs answers "what moved", workflow_action_runs
# answers "what the engine did about it"; a screen headed "Status Logs" that served only one is a
# lie by omission, and serving only actions is the easier mistake to make.
ok "action,move" "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?limit=200" \
  | $PY -c "import sys,json;print(','.join(sorted({r['kind'] for r in json.load(sys.stdin)['rows']})))")" \
  "the run log serves BOTH the moves and the engine's actions, in one stream"
ok 1 "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?limit=200" \
  | $PY -c "import sys,json;d=json.load(sys.stdin)['rows'];print(1 if all(r['reference'] for r in d if r['entity_type'] in ('rfq','rfq_item')) else 0)")" \
  "and names the record a human recognises, not a uuid"
# A move has no outcome because a move that failed was rolled back and never written. Leaving moves
# in the failure view would render them as failures whose detail is missing.
ok "action|failed" "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?outcome=failed" \
  | $PY -c "import sys,json;d=json.load(sys.stdin)['rows'];print('|'.join(sorted({r['kind'] for r in d}))+'|'+'|'.join(sorted({r['outcome'] for r in d})))")" \
  "outcome=failed narrows to action rows and to failures only"
# The count is the alarm, so it is taken over the whole log. Computed over the returned page it would
# read 0 the moment somebody shortened the window — a broken rule reporting itself as healthy.
ok 1 "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?limit=1" | $PY -c "import sys,json;print(json.load(sys.stdin)['failed'])")" \
  "the failure count spans the whole log, not just the page returned"
ok 0 "$(curl -s "${AR[@]}" -H 'X-Environment: sandbox' "$B/api/workflow/run-log" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(len(d['rows'])+d['failed'])")" \
  "and Live activity is invisible from Sandbox, log and count alike"

# WHO MAY READ IT. Not @PlatformOnly: the person who must act on a failed rule is the workspace's own
# manager, and hiding the log behind platform staff would mean a workspace learns its flow has been
# failing for a week by asking us. Not open either — the log spans every record in the workspace.
RLMGR=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"manager@qparts.local","password":"manager1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
RLADV=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"staff@qparts.local","password":"staff1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
ok 200 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/workflow/run-log?limit=1" \
  -H "Authorization: Bearer $RLMGR" -H 'X-Tenant: riyadh')" \
  "the workspace's own manager can read the run log"
ok 403 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/workflow/run-log?limit=1" \
  -H "Authorization: Bearer $RLADV" -H 'X-Tenant: riyadh')" \
  "an ordinary workspace user cannot — it spans records that are not theirs"

wfclean; rlclean

# ── THE DAILY CEILING (QNEW-90 item 9) ───────────────────────────────────────────────────────────
# A cap that blocks is easy; a cap that blocks the right thing, records that it did, and still lets a
# person's click through is the whole difficulty. Every check below is a way this could go wrong while
# the suite stayed green: the ceiling failing a legitimate move, the refusal going unrecorded, a
# refusal spending the allowance it was refused for, one kind of action's ceiling holding down the
# others, or a busy day reporting itself as a broken flow.
#
# lock_record is the subject because its ceiling is the lowest (500 — every success puts an item in
# front of a human being), so the day can be filled with one INSERT instead of ten thousand.
capclean(){
  psql "delete from workflow_action_runs; delete from workflow_exceptions; delete from status_logs;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'CAP-%');
        delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'CAP-%'));
        delete from orders where rfq_id in (select id from rfqs where plate_number like 'CAP-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'CAP-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'CAP-%');
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'CAP-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from rfqs where plate_number like 'CAP-%'" > /dev/null
}
wfclean; capclean

# The database is the last line: a fifth outcome nothing knows how to render must not be storable.
ok t "$(psql "select pg_get_constraintdef(oid) like '%capped%' from pg_constraint
               where conname='workflow_action_runs_outcome_ck'")" \
  "the outcome column accepts 'capped' as a fourth value, not as a note inside 'skipped'"
ok 1 "$(psql "insert into workflow_action_runs (tenant_id, environment, entity_type, entity_id, action, outcome)
               select id, 'live', 'rfq_item', gen_random_uuid(), 'lock_record', 'invented' from tenants limit 1" 2>&1 \
        | /usr/bin/grep -c 'violates check constraint')" \
  "and still refuses a value the run log has no way to render"

CPF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-cap","nameAr":"سقف يومي","nameEn":"Daily cap","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$CPF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[
   {"from":"new_rfq","to":"priced","labelEn":"Price","actions":[{"action":"lock_record","params":{"reason":"the price needs a look"}}]},
   {"from":"priced","to":"confirmed","labelEn":"Confirm line"},
   {"from":"new_rfq","to":"confirmed","labelEn":"Confirm header","actions":[{"action":"set_field","params":{"field":"shipping_type","value":"express"}}]}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$CPF/activate"

# Spend the whole day's allowance for lock_record. 'ok' rows because those are the ones that count —
# a run that worked is exactly what the ceiling is counting.
psql "insert into workflow_action_runs (tenant_id, environment, entity_type, entity_id, transition_key,
        action, params, outcome, detail)
      select t.id, 'live', 'rfq_item', gen_random_uuid(), 'new_rfq>priced', 'lock_record', '{}'::jsonb,
             'ok', 'filler: the day is full' from tenants t, generate_series(1, 500) where t.slug='riyadh'" > /dev/null

CPR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"CAP-1","items":[{"partNumber":"CAP-P1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
CPTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$CPR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
CPIT=$(psql "select id from rfq_items where rfq_id='$CPR' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$CPTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$CPIT")"
CPQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$CPIT' limit 1")
CPMOVE=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$CPR/items/$CPIT/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$CPQI")")

# THE POINT OF THE WHOLE FEATURE, in two checks. A ceiling on follow-up work is not a reason to
# refuse somebody's correct click: the move was already judged legitimate before any action ran.
ok 0 "$(blocked "$CPMOVE")" "a workspace at its daily ceiling can still make the move"
ok priced "$(psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$CPIT'")" \
  "and the record arrives where it was going"
ok capped "$(psql "select outcome from workflow_action_runs where entity_id='$CPIT' and action='lock_record'")" \
  "while the action it would have run is blocked AND recorded, not silently dropped"
ok 1 "$(psql "select count(*) from workflow_action_runs
               where entity_id='$CPIT' and action='lock_record' and detail like '%500 of its 500%'")" \
  "with the count and the ceiling in the line, since the reader is asking why a rule stopped working"
ok 0 "$(psql "select count(*) from workflow_exceptions where entity_id='$CPIT'")" \
  "and nothing reached the queue a person works from — a blocked hold is not a quiet hold"

# A refusal that consumed the allowance it was refused for would make the log unable to reconstruct
# the number that was actually enforced, and would push the count up forever under a runaway flow.
ok 500 "$(psql "select count(*) from workflow_action_runs where action='lock_record'
                 and outcome in ('ok','failed') and environment='live'
                 and tenant_id=(select id from tenants where slug='riyadh')")" \
  "a capped attempt does not spend allowance — 500 spent, not 501"

# PER KIND, NOT PER WORKSPACE. set_field costs a write; lock_record costs somebody's attention. One
# shared ceiling would let the cheapest action in a flow switch off the most careful one.
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$CPR/confirm" -d '{}'
ok express "$(psql "select coalesce(shipping_type,'') from rfqs where id='$CPR'")" \
  "lock_record being at its ceiling does not stop set_field, which has its own"
ok ok "$(psql "select outcome from workflow_action_runs where entity_id='$CPR' and action='set_field'")" \
  "and that run is logged as having worked, on the same flow, in the same minute"

# The run log is where a capped action becomes visible. It must be findable, and it must NOT ring the
# failure alarm: a busy day is not a broken flow, and an operator who is paged for one stops reading.
ok "action|capped" "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?outcome=capped" \
  | $PY -c "import sys,json;d=json.load(sys.stdin)['rows'];print('|'.join(sorted({r['kind'] for r in d}))+'|'+'|'.join(sorted({r['outcome'] for r in d})))")" \
  "the run log can be asked what the ceiling refused"
ok 0 "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?limit=1" | $PY -c "import sys,json;print(json.load(sys.stdin)['failed'])")" \
  "and a capped action is not counted as a failure"

# ONE DAY, not all time. Counting every run ever would turn a containment cap into a lifetime quota:
# the flow would work for a fortnight and then stop for good, which is not what anybody configured.
psql "update workflow_action_runs set ran_at = now() - interval '2 days' where detail='filler: the day is full'" > /dev/null
CPR2=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"CAP-2","items":[{"partNumber":"CAP-P2","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
CPTOK2=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$CPR2/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
CPIT2=$(psql "select id from rfq_items where rfq_id='$CPR2' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$CPTOK2/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$CPIT2")"
CPQI2=$(psql "select id from rfq_vendor_items where rfq_item_id='$CPIT2' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$CPR2/items/$CPIT2/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$CPQI2")"
ok ok "$(psql "select outcome from workflow_action_runs where entity_id='$CPIT2' and action='lock_record'")" \
  "yesterday's runs do not hold today's ceiling down — the window is one day"
# Midnight in the workspace's business-calendar timezone, not UTC: 'Asia/Riyadh' is the column default
# and InfraService's own fallback, so for a Saudi product the day turns at 00:00 in Riyadh (21:00 UTC).
ok "21:00:00" "$(psql "select to_char((select date_trunc('day', now() at time zone z.name) at time zone z.name
                 from (select coalesce((select n.name from business_calendar_settings b
                                         join pg_timezone_names n on n.name = b.timezone
                                        where b.tenant_id=(select id from tenants where slug='riyadh')),
                                       'Asia/Riyadh') as name) z) at time zone 'UTC', 'HH24:MI:SS')")" \
  "and the day starts at midnight in the workspace's own timezone, not at midnight UTC"

wfclean; capclean

# ── the run log must not misattribute work (0059) ────────────────────────────────────────────────
# Every assertion here was a confirmed defect on the screen built for item 6, and every one of them
# was invisible to the person who built it, because they tested as a platform admin — the one reader
# for whom the broken join worked. The suite tests as the MANAGER for that reason.
wfclean
psql "delete from workflow_action_runs; delete from status_logs" > /dev/null
RLR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"RLOG-1","items":[{"partNumber":"P1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
RLTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$RLR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
RLIT=$(psql "select id from rfq_items where rfq_id='$RLR' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$RLTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$RLIT")"
RLQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$RLIT' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$RLR/items/$RLIT/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$RLQI")"

# A platform admin made those moves. The workspace manager must be told SOMETHING true about who —
# not the label the screen reserves for a vendor arriving with no session at all.
ok 0 "$(curl -s "${MR[@]}" "$B/api/workflow/run-log?limit=20" | $PY -c "
import sys, json
d = json.load(sys.stdin)
rows = d.get('rows', [])
# a row with an actor recorded but no label is what rendered as 'no signed-in user'
print(len([r for r in rows if r.get('has_actor') and not r.get('actor_name')]) if rows else 'no rows')")" \
  "a workspace reader is never told a named colleague's move had no signed-in user"
ok 1 "$(curl -s "${MR[@]}" "$B/api/workflow/run-log?limit=20" | $PY -c "
import sys, json
rows = json.load(sys.stdin).get('rows', [])
print(1 if any(r.get('actor_name') for r in rows) else 0)")" \
  "and does get a real label back — platform staff resolve to a role, not to nothing"

# Both source tables default their timestamp to now(), which is the TRANSACTION timestamp, so a move
# and everything it caused tie exactly. Ordering has to be deterministic anyway.
ok 1 "$(for i in 1 2 3; do curl -s "${MR[@]}" "$B/api/workflow/run-log?limit=20" | $PY -c "
import sys, json
print('|'.join(r['kind'] + ':' + str(r.get('group_key')) for r in json.load(sys.stdin).get('rows', [])))"; done | /usr/bin/sort -u | /usr/bin/wc -l | /usr/bin/tr -d ' ')" \
  "the same log read three times comes back in the same order"
ok 0 "$(curl -s "${MR[@]}" "$B/api/workflow/run-log?limit=20" | $PY -c "
import sys, json
from collections import defaultdict
pos = defaultdict(list)
for i, r in enumerate(json.load(sys.stdin).get('rows', [])):
    if r.get('group_key'): pos[r['group_key']].append(r['kind'])
bad = [k for k, v in pos.items() if 'move' in v and 'action' in v and v.index('move') > v.index('action')]
print(len(bad))")" \
  "and a move is listed above the actions it caused — subject before verb"

# An action the engine ran by itself has no actor BY DESIGN. Without the recorded flag the log said
# 'no signed-in user' for the engine's own work, one line under the move that said 'the workflow'.
ok t "$(psql "select count(*) > 0 from information_schema.columns
              where table_name='workflow_action_runs' and column_name='auto_advanced'")" \
  "an action run records whether the engine or a person triggered it"

# One failure a workspace had once must not light the alarm for the rest of the product's life.
psql "insert into workflow_action_runs
        (tenant_id, environment, entity_type, entity_id, transition_key, action, params, outcome, detail, ran_at)
      select t.id, 'live', 'rfq', '$RLR'::uuid, 'x>y', 'set_field', '{}'::jsonb, 'failed',
             'stale failure', now() - interval '1 year'
      from tenants t where t.slug='riyadh'" > /dev/null
ok 0 "$(curl -s "${MR[@]}" "$B/api/workflow/run-log?limit=5" | $PY -c "
import sys, json; print(json.load(sys.stdin).get('failed'))")" \
  "the failure alarm is bounded to a window, so a year-old failure does not light it forever"

psql "delete from workflow_action_runs; delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id='$RLR';
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id='$RLR');
      delete from rfq_vendors where rfq_id='$RLR'; delete from rfq_items where rfq_id='$RLR';
      delete from notification_log where template='vendor_rfq_invite'; delete from rfqs where id='$RLR'" > /dev/null
wfclean

# ── the action library: named and reusable, without unfreezing anything (0060) ───────────────────
# The reviewer asked for actions to be "reusable named entities in a shared library, associated to
# rules — not embedded copies". The same ticket calls our draft→active freeze the thing we do better
# than the tool it benchmarks against. Both are satisfiable only one way: the library is where a
# configuration is AUTHORED, a transition holds a COPY, and the receipt records where the copy came
# from. The engine never follows the receipt — which is what these assertions are really checking.
wfclean
psql "delete from workflow_actions; delete from workflow_action_runs; delete from status_logs" > /dev/null

LIBE=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/action-library" \
  -d '{"nameEn":"Express shipping","nameAr":"شحن سريع","action":"set_field","params":{"field":"shipping_type","value":"express"}}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$([ -n "$LIBE" ] && echo 1 || echo 0)" "a configuration can be saved under a name"
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/action-library" \
  -d '{"nameEn":"Bogus","nameAr":"مجهول","action":"not_a_real_action","params":{}}' \
  | $PY -c "import sys,json;print(1 if 'not an action this server knows' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "and an action key this server does not know is refused before it can be copied onto ten arrows"

LIBF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-lib","nameAr":"مكتبة","nameEn":"Library","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$LIBF/graph" -d "{\"selectionCondition\":{},
 \"steps\":[{\"status\":\"new_rfq\",\"isEntry\":true,\"x\":80,\"y\":100},
           {\"status\":\"priced\",\"x\":340,\"y\":100},
           {\"status\":\"confirmed\",\"isTerminal\":true,\"x\":600,\"y\":100}],
 \"transitions\":[{\"from\":\"new_rfq\",\"to\":\"priced\",\"labelEn\":\"Price\"},
   {\"from\":\"priced\",\"to\":\"confirmed\",\"labelEn\":\"Confirm line\"},
   {\"from\":\"new_rfq\",\"to\":\"confirmed\",\"labelEn\":\"Confirm header\",
    \"actions\":[{\"action\":\"set_field\",\"params\":{\"field\":\"shipping_type\",\"value\":\"express\"},
                 \"ref\":{\"id\":\"$LIBE\",\"name\":\"Express shipping\"}}]}]}"
# zod's z.object strips keys it does not declare, so the receipt is the exact kind of field that
# vanishes on the way in and takes the whole feature with it
ok 1 "$(psql "select count(*) from workflow_transitions t join workflow_flows f on f.id=t.flow_id
              where f.flow_key='smoke-lib'
                and t.actions @> jsonb_build_array(jsonb_build_object('ref', jsonb_build_object('id', '$LIBE')))")" \
  "the receipt survives the save instead of being stripped by the schema"
ok 1 "$(curl -s "${AR[@]}" "$B/api/admin/workflows/catalog" | $PY -c "
import sys, json
lib = json.load(sys.stdin).get('actionLibrary') or []
print(next((e.get('used_by_flows') for e in lib if e.get('id') == '$LIBE'), 'missing'))")" \
  "and the entry knows how many flows are built from it"

# THE ONE THAT MATTERS. Activate, then edit the saved action, then move a real record.
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$LIBF/activate"
ok active "$(psql "select status from workflow_flows where flow_key='smoke-lib'")" "the flow is live"
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/action-library/$LIBE" \
  -d '{"nameEn":"Express shipping","nameAr":"شحن سريع","action":"set_field","params":{"field":"shipping_type","value":"CHANGED"}}'
ok CHANGED "$(psql "select params->>'value' from workflow_actions where id='$LIBE'")" \
  "the saved action really was edited (or the next check proves nothing)"

LIBR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"LIB-1","items":[{"partNumber":"P1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
LIBTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$LIBR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
LIBIT=$(psql "select id from rfq_items where rfq_id='$LIBR' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$LIBTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$LIBIT")"
LIBQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$LIBIT' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$LIBR/items/$LIBIT/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$LIBQI")"
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$LIBR/confirm" -d '{}'
ok express "$(psql "select coalesce(shipping_type,'') from rfqs where id='$LIBR'")" \
  "an ACTIVE flow runs the copy it froze, not what the saved action says today"

# Deleting the entry is a library operation, not a flow operation.
curl -s -o /dev/null "${AR[@]}" -X DELETE "$B/api/admin/workflows/action-library/$LIBE"
ok 1 "$(psql "select count(*) from workflow_transitions t join workflow_flows f on f.id=t.flow_id
              where f.flow_key='smoke-lib' and jsonb_array_length(t.actions) > 0")" \
  "and deleting the saved action leaves the flows built from it working"

psql "delete from workflow_actions; delete from workflow_action_runs; delete from status_logs;
      update rfq_items set winning_vendor_quote_item_id=null where rfq_id='$LIBR';
      delete from order_items where order_id in (select id from orders where rfq_id='$LIBR');
      delete from orders where rfq_id='$LIBR';
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id='$LIBR');
      delete from rfq_vendors where rfq_id='$LIBR'; delete from rfq_items where rfq_id='$LIBR';
      delete from notification_log where template='vendor_rfq_invite'; delete from rfqs where id='$LIBR'" > /dev/null
wfclean

# ── in-app notification delivery (0061) ─────────────────────────────────────────────────────────
# The one notification channel with no provider missing behind it, and therefore the one this system
# is allowed to say it SENT. Everything asserted here is a way the feature could look finished and be
# a lie: the message never reaching its recipient, reaching the wrong person, or the badge counting
# something other than what the inbox shows.
#
# Driven through the APPROVALS engine rather than by inserting rows, because a delivery path nothing
# calls is exactly the theatre this codebase refuses. approvals.service.ts notifies the approver a
# decision has landed on — the gap the Approvals page's own header describes ("nothing tells an
# approver that a decision is sitting on them").
nclean(){
  psql "delete from in_app_notifications;
        delete from notification_log where channel='in_app';
        delete from approval_actions where request_id in (select id from approval_requests where entity_type='notify_probe');
        delete from approval_requests where entity_type='notify_probe';
        delete from approval_levels where policy_id in (select id from approval_policies where entity_type='notify_probe');
        delete from approval_policies where entity_type='notify_probe'" > /dev/null
}
nclean

NMGRID=$(psql "select id from users where email='manager@qparts.local'")
NMTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"manager@qparts.local","password":"manager1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
NM=(-H "Authorization: Bearer $NMTOK" -H "X-Tenant: riyadh" -H "Content-Type: application/json")
nunread(){ curl -s "$@" "$B/api/notifications/unread-count" | $PY -c "import sys,json;print(json.load(sys.stdin).get('unread'))"; }

ok 0 "$(nunread "${NM[@]}")" "the badge starts at zero — it counts rows, it does not invent a number"

# A policy whose only approver is the MANAGER, opened by the ADMIN: the notification is written in
# somebody else's transaction, which is the case a FOR ALL restrictive policy would have broken.
NPOL=$(curl -s "${AR[@]}" -X POST "$B/api/approvals/policies" \
  -d "$(printf '{"name":"Notify probe","entityType":"notify_probe","levels":[{"approverUserId":"%s"}]}' "$NMGRID")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$([ -n "$NPOL" ] && echo 1 || echo 0)" "an approval policy naming the manager as approver exists"
NENT=$($PY -c "import uuid;print(uuid.uuid4())")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/approvals/requests" \
  -d "$(printf '{"entityType":"notify_probe","entityId":"%s"}' "$NENT")"

# THE ONE THAT MATTERS: it arrived, at the person it was addressed to.
ok "An approval is waiting on you" "$(curl -s "${NM[@]}" "$B/api/notifications?limit=5" | $PY -c "
import sys, json
rows = json.load(sys.stdin).get('rows', [])
print(rows[0]['title'] if rows else 'NOTHING ARRIVED')")" \
  "a notification raised by one person REACHES the person it is addressed to"
ok /approvals "$(curl -s "${NM[@]}" "$B/api/notifications?limit=5" | $PY -c "
import sys, json
rows = json.load(sys.stdin).get('rows', [])
print(rows[0].get('link') if rows else '')")" \
  "and points at the screen that can act on it, rather than being a nag with no destination"
ok 1 "$(nunread "${NM[@]}")" "the unread count is the number of unread rows"

NID=$(psql "select id from in_app_notifications order by created_at desc limit 1")

# ADDRESSED TO A PERSON. The admin is a platform super_admin and break-glass everywhere else in this
# system by design — an inbox is where that has to stop. Asserted for the READ, the WRITE, and at the
# DATABASE, because the API filter and the RLS policy must each hold on their own: if only one does,
# the other is a hole waiting for the next endpoint that forgets it.
ok 0 "$(curl -s "${AR[@]}" "$B/api/notifications?limit=50" | $PY -c "
import sys, json; print(len(json.load(sys.stdin).get('rows', [])))")" \
  "another user — even a platform super admin — cannot read it"
ok 0 "$(nunread "${AR[@]}")" "and it is not counted in anybody else's badge"
ok 0 "$(curl -s "${AR[@]}" -X POST "$B/api/notifications/$NID/read" | $PY -c "
import sys, json; print(json.load(sys.stdin).get('updated'))")" \
  "nor can they mark somebody else's notification read"
ok 0 "$(curl -s "${AR[@]}" -X POST "$B/api/notifications/read-all" | $PY -c "
import sys, json; print(json.load(sys.stdin).get('updated'))")" \
  "and read-all empties only the caller's own inbox"
ok 1 "$(nunread "${NM[@]}")" "so after all of that the recipient's notification is STILL unread"

# The floor under the API. app_is_internal() is an OR-escape in the tenant policy, so without the
# RESTRICTIVE addressee policy this query returns the row and every future endpoint inherits the hole.
NTID=$(psql "select id from tenants where slug='riyadh'")
NAID=$(psql "select id from users where email='admin@qparts.local'")
ok 0 "$(docker exec -e PGPASSWORD=qvm_app_local_dev qvm_postgres psql -U qvm_app -d qvm_platform -tA -c "
  select set_config('app.tenant_id','$NTID',false), set_config('app.user_id','$NAID',false),
         set_config('app.is_internal','true',false), set_config('app.environment','live',false);
  select count(*) from in_app_notifications" | /usr/bin/tail -1)" \
  "RLS ITSELF refuses it — an internal session reads zero rows, not just a filtered endpoint"

# ADR-0012. A rehearsal in Sandbox must not appear in the Live inbox of the person who ran it.
ok 0 "$(nunread -H "Authorization: Bearer $NMTOK" -H 'X-Tenant: riyadh' -H 'X-Environment: sandbox')" \
  "and a Live notification is invisible from Sandbox"

# THE BADGE MUST BE ABLE TO REACH ZERO. A count that always shows a number is the demo constant this
# replaced, in a different font.
ok 1 "$(curl -s "${NM[@]}" -X POST "$B/api/notifications/$NID/read" | $PY -c "
import sys, json; print(json.load(sys.stdin).get('updated'))")" "the recipient can mark it read"
ok 0 "$(nunread "${NM[@]}")" "and the unread count drops to zero"
ok 1 "$(curl -s "${NM[@]}" "$B/api/notifications?limit=5" | $PY -c "
import sys, json; print(len(json.load(sys.stdin).get('rows', [])))")" \
  "the notification itself is still there — read is not deleted"
ok 0 "$(curl -s "${NM[@]}" -X POST "$B/api/notifications/$NID/read" | $PY -c "
import sys, json; print(json.load(sys.stdin).get('updated'))")" \
  "marking an already-read one read again changes nothing (the button is safe to press twice)"

# The unread index is PARTIAL. Without the WHERE clause the count degrades to a scan of a table that
# only ever grows, which is invisible in a test database and fatal in a workspace two years old.
# indpred rather than a LIKE over indexdef: pg_get_indexdef re-prints the predicate with its own
# parenthesisation, so a string match asserts the formatter's habits and not the property.
ok true "$(psql "select (indpred is not null)::text from pg_index
               where indexrelid='in_app_notifications_unread_idx'::regclass")" \
  "the unread count is served by a PARTIAL index, not a scan of the whole inbox"

# in_app is the ONLY channel allowed to record status='sent', because it is the only one that sends.
ok "in_app|sent" "$(psql "select channel||'|'||status from notification_log where channel='in_app' limit 1")" \
  "in-app delivery is recorded as SENT — the one channel where that is a true statement"
ok 0 "$(psql "select count(*) from notification_log where channel <> 'in_app' and status='sent'")" \
  "and no provider-backed channel claims to have sent anything, because none of them can"

nclean

# ── entry, child events, and removals (0062 / QNEW-90 item 7 + the third lever of item 5) ────────
# The taxonomy the benchmark offers is created / edited / created-or-edited / deleted, and the
# verdict was to adopt it MINIMALLY. What is asserted here is that minimum, and — more importantly —
# the two things it must never cost:
#   • creation must not become refusable. A workspace with a half-drawn flow still has to trade.
#   • the engine must not be able to reopen the rules on itself, or the depth cap never bites.
mkrfq(){ # $1 = plate -> echoes the new rfq id ('' if the API refused)
  curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"EP","quantity":1}]}' "$BR" "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))"
}
mkflow(){ # $1 = key suffix, $2 = graph json -> echoes the id of an ACTIVE default flow
  local F
  F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d "$(printf '{"flowKey":"smoke-%s","nameAr":"مسار","nameEn":"Entry","isDefault":true}' "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "$2"
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$F/activate"
  echo "$F"
}
rfqstatus(){ psql "select s.code from rfqs r join item_statuses s on s.id=r.status_id where r.id='$1'"; }
entryclean(){
  wfclean
  psql "delete from workflow_auto_fired; delete from workflow_action_runs; delete from status_logs;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%');
        delete from delivery_items where delivery_id in (select id from deliveries where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%')));
        delete from deliveries where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%'));
        delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%'));
        delete from orders where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%');
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'ENTRY-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from rfqs where plate_number like 'ENTRY-%';
        delete from workflow_record_removals" > /dev/null
}
entryclean

# 1) NO FLOW AT ALL. The rollout promise, now applied to the moment a record is born.
ENT1=$(mkrfq ENTRY-NOFLOW)
ok 1 "$([ -n "$ENT1" ] && echo 1 || echo 0)" "with no workflow at all an RFQ can still be raised"
ok "|new_rfq" "$(psql "select coalesce(f.code,'')||'|'||t.code from status_logs l
                       left join item_statuses f on f.id=l.from_status_id
                       join item_statuses t on t.id=l.to_status_id
                       where l.entity_type='rfq' and l.entity_id='$ENT1'")" \
  "and its arrival is a real event in the history: from nothing, to new_rfq"
ok 1 "$(psql "select count(*) from status_logs where entity_type='rfq_item'
               and entity_id in (select id from rfq_items where rfq_id='$ENT1')")" \
  "the lines record their arrival too, not just the header"
ok 1 "$(psql "select count(*) from status_logs where entity_type='rfq' and entity_id='$ENT1' and changed_by is not null")" \
  "credited to the person who raised it, taken from the JWT"
ok 0 "$(psql "select count(*) from workflow_record_state where entity_id='$ENT1'")" \
  "and bound to nothing, because there is nothing to bind it to"

# 2) A FLOW THAT DOES NOT DESCRIBE HOW REQUESTS BEGIN. The load-bearing negative: an entry is not a
# move along an arrow, so the absence of the arrival status cannot be read as a refusal.
FE1=$(mkflow entry-absent '{"selectionCondition":{},
 "steps":[{"status":"priced","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"confirmed","labelEn":"Confirm"}]}')
ok active "$(psql "select status from workflow_flows where id='$FE1'")" "a flow with no new_rfq step is live"
ENT2=$(mkrfq ENTRY-ABSENT)
ok 1 "$([ -n "$ENT2" ] && echo 1 || echo 0)" \
  "and it CANNOT stop an RFQ being raised — a half-drawn flow must not close the business"
ok 0 "$(psql "select count(*) from workflow_record_state where entity_id='$ENT2'")" \
  "the record is left unbound rather than pinned to a step it is not standing on"
ok 1 "$(psql "select count(*) from status_logs where entity_type='rfq' and entity_id='$ENT2'")" \
  "but the arrival is recorded either way"

# 3) A FLOW THAT DOES. The version pin now happens at birth instead of at the second status.
entryclean
FE2=$(mkflow entry-bound '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100,"ownerRoles":["company_admin"],"slaHours":4},
          {"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}')
ENT3=$(mkrfq ENTRY-BOUND)
ok "$FE2" "$(psql "select flow_id from workflow_record_state where entity_type='rfq' and entity_id='$ENT3'")" \
  "a record entering under an active flow is bound to THAT version from its first status"
ok company_admin "$(psql "select assignee_role from workflow_record_state where entity_type='rfq' and entity_id='$ENT3'")" \
  "and lands on the desk the entry step says owns it"
ok true "$(psql "select (due_at is not null)::text from workflow_record_state where entity_type='rfq' and entity_id='$ENT3'")" \
  "with the step's SLA clock already running, rather than starting on its second status"

# 4) CREATED IS A REAL TRIGGER. An arrow the flow marks automatic fires when the record ARRIVES.
entryclean
FE3=$(mkflow entry-auto '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"tendering","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"tendering","labelEn":"Tender","autoAdvance":true}]}')
ENT4=$(mkrfq ENTRY-AUTO)
ok tendering "$(rfqstatus "$ENT4")" \
  "an automatic arrow out of the entry step fires on arrival, not the next time somebody clicks"
ok 1 "$(psql "select count(*) from status_logs where entity_type='rfq' and entity_id='$ENT4' and auto_advanced")" \
  "and is recorded as the engine's move, with no actor"

# 5) AN ORDER IS BORN AT 'confirmed', which is the second place a first status used to appear from
# nowhere. Run with no flow so nothing else is being asserted at the same time.
entryclean
order_from(){ # $1 = plate -> echoes the new order id
  local rid tok it qi
  rid=$(mkrfq "$1")
  [ -z "$rid" ] && { echo ""; return; }
  echo "$rid" > /tmp/qvm_entry_rfq
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  it=$(psql "select id from rfq_items where rfq_id='$rid' limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$rid/items/$it/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
  curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/confirm" | $PY -c "import sys,json;print(json.load(sys.stdin).get('orderId',''))"
}
ORD1=$(order_from ENTRY-ORDER)
ok "|confirmed" "$(psql "select coalesce(f.code,'')||'|'||t.code from status_logs l
                         left join item_statuses f on f.id=l.from_status_id
                         join item_statuses t on t.id=l.to_status_id
                         where l.entity_type='order' and l.entity_id='$ORD1'")" \
  "an ORDER's arrival at confirmed is an event too, not a column written in an INSERT"
ok 1 "$(psql "select count(*) from status_logs where entity_type='order_item'
               and entity_id in (select id from order_items where order_id='$ORD1')")" \
  "and so is each of its lines'"

# 6) CHILD EVENT — A QUOTE LANDING. When, AND ONLY WHEN, the gate is satisfied.
# Nothing in the product used to re-examine a request when a vendor answered, so a rule that was
# already earned waited for somebody to open the screen and press the button.
entryclean
VID2=$(psql "select tv.vendor_id from tenant_vendors tv join vendors v on v.id = tv.vendor_id
             join tenants t on t.id = tv.tenant_id and t.slug='riyadh'
             where tv.status='active' and v.is_active and v.activation_status='active'
               and tv.vendor_id <> '$VID' limit 1")
FE4=$(mkflow quote-child '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","autoAdvance":true,
                 "gates":[{"gate":"min_quotes_per_item","params":{"n":2},"enforcement":"block"}]}]}')
CH=$(mkrfq ENTRY-CHILD)
CHIT=$(psql "select id from rfq_items where rfq_id='$CH' limit 1")
ok new_rfq "$(rfqstatus "$CH")" "a request short of quotes does not move when it is raised"
quote_from(){ # $1 = vendor id — sends the request to one vendor and has it answer
  local tok
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$CH/send" -d "$(printf '{"vendorIds":["%s"]}' "$1")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$CHIT")"
}
quote_from "$VID"
ok new_rfq "$(rfqstatus "$CH")" "nor when the FIRST quote lands — the gate is not satisfied yet"
quote_from "$VID2"
ok priced "$(rfqstatus "$CH")" \
  "and the SECOND one carries it forward by itself, with nobody in the product at all"
ok 1 "$(psql "select count(*) from status_logs where entity_type='rfq' and entity_id='$CH' and auto_advanced")" \
  "recorded as the engine's move — the vendor who satisfied the rule did not make it"

# 7) CHILD EVENT — A DELIVERY BEING RECORDED, against the gate a header actually carries.
#
# READ THE FIXTURE CAREFULLY. Both the order and its lines are born at 'confirmed', so BOTH see the
# automatic arrow out of it — and a gate over lines is meaningless ON a line, so runGates skips it
# and the lines take that arrow immediately while the header is held back by it. That is the engine
# being consistent rather than a quirk of this flow, so the fixture gives the lines the road back
# ('settled' -> 'delivered') and asserts on the HEADER, which is the record the gate governs.
entryclean
FE5=$(mkflow deliver-child '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","x":340,"y":100},
          {"status":"confirmed","x":600,"y":100},
          {"status":"settled","x":860,"y":100},
          {"status":"delivered","isTerminal":true,"x":1120,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"},
                {"from":"new_rfq","to":"confirmed","labelEn":"Confirm request"},
                {"from":"priced","to":"confirmed","labelEn":"Confirm line"},
                {"from":"confirmed","to":"settled","labelEn":"Settle","autoAdvance":true,
                 "gates":[{"gate":"all_items_at_status","params":{"status":"delivered"},"enforcement":"block"}]},
                {"from":"settled","to":"delivered","labelEn":"Deliver line"}]}')
ORD2=$(order_from ENTRY-DELIVER)
ok confirmed "$(psql "select s.code from orders o join item_statuses s on s.id=o.status_id where o.id='$ORD2'")" \
  "an order whose lines are not out yet stays where it is, gate unsatisfied"
OIT=$(psql "select id from order_items where order_id='$ORD2' limit 1")
OQTY=$(psql "select approved_qty from order_items where id='$OIT'")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/orders/$ORD2/deliveries" \
  -d "$(printf '{"items":[{"orderItemId":"%s","qty":%s}]}' "$OIT" "$OQTY")"
ok settled "$(psql "select s.code from orders o join item_statuses s on s.id=o.status_id where o.id='$ORD2'")" \
  "and recording the delivery carries it forward the moment the gate is met — no button, no cron"
ok 1 "$(psql "select count(*) from status_logs where entity_type='order' and entity_id='$ORD2' and auto_advanced")" \
  "as the engine's move, off the back of a fact that changed under it"

# 8) THE THIRD LEVER — an action's own write cannot reopen the rules. See the header of
# scripts/reevaluate-reentrancy.ts for why this is asserted by construction rather than over HTTP.
ok "looked refused" "$("$(cd "$(dirname "$0")/.." && pwd)/node_modules/.bin/tsx" \
    "$(cd "$(dirname "$0")" && pwd)/reevaluate-reentrancy.ts" 2>/dev/null)" \
  "a re-evaluation runs for a real-world event and is REFUSED inside an action run (no runaway)"

# 9) DELETED — recorded, and wired to nothing.
entryclean
FE6=$(mkflow removal '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"tendering","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"tendering","labelEn":"Tender","autoAdvance":true,
                 "actions":[{"action":"set_field","params":{"field":"model","value":"Recorded"}}]}]}')
DELR=$(mkrfq ENTRY-DELETE)
DELIT=$(psql "select id from rfq_items where rfq_id='$DELR' limit 1")
DELN=$(psql "select order_number from rfqs where id='$DELR'")
ok 1 "$(psql "select count(*) from workflow_action_runs where entity_id='$DELR'")" \
  "the flow really is armed — an action fired on this record while it existed"
RUNS=$(psql "select count(*) from workflow_action_runs")
LOGS=$(psql "select count(*) from status_logs")
psql "delete from rfq_items where rfq_id='$DELR'; delete from rfqs where id='$DELR'" > /dev/null
ok 0 "$(psql "select count(*) from rfqs where id='$DELR'")" "the record really is gone"
ok "rfq|$DELN" "$(psql "select entity_type||'|'||reference from workflow_record_removals where entity_id='$DELR'")" \
  "and a reader can still see WHAT left, by the number a person knew it as"
ok tendering "$(psql "select s.code from workflow_record_removals r join item_statuses s on s.id=r.last_status_id
                      where r.entity_id='$DELR'")" "and where it stood when it went"
ok 1 "$(psql "select count(*) from workflow_record_removals where entity_type='rfq_item' and entity_id='$DELIT'")" \
  "its lines are recorded as leaving too, not just the header"
ok "$RUNS" "$(psql "select count(*) from workflow_action_runs")" \
  "AUDIT ONLY: the delete fired no action, on a flow that demonstrably fires them"
ok "$LOGS" "$(psql "select count(*) from status_logs")" \
  "and no status event — there is no record left for a rule to act on"

entryclean

# ── the `notify` action (QNEW-90 item 3) ─────────────────────────────────────────────────────────
# The engine could already permit, refuse and act; what it could not do was TELL SOMEBODY. It was
# withheld deliberately while every channel recorded intentions and dispatched nothing, so the whole
# point of these checks is that the message now really arrives — and arrives at the right person,
# which is the part a "sends a notification" feature gets wrong silently.
#
# Everything here is a way this could look finished and be a lie: the message going to the desk the
# work has just LEFT, naming the status it has just left, being sent to the person who caused it, or
# being counted as sent while the ceiling had blocked it.
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
nfclean(){
  wfclean
  psql "delete from workflow_auto_fired; delete from workflow_action_runs; delete from status_logs;
        delete from in_app_notifications; delete from notification_log where channel='in_app';
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'NOTIFY-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'NOTIFY-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'NOTIFY-%');
        delete from workflow_record_state where entity_id in (select id from rfq_items where rfq_id in (select id from rfqs where plate_number like 'NOTIFY-%'));
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'NOTIFY-%');
        delete from workflow_record_state where entity_id in (select id from rfqs where plate_number like 'NOTIFY-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from rfqs where plate_number like 'NOTIFY-%'" > /dev/null
}
told(){ psql "select coalesce(string_agg(distinct u.email, ',' order by u.email), 'NOBODY')
              from in_app_notifications n join users u on u.id = n.recipient_user_id
              where n.kind = 'workflow'"; }
nfclean

ok "notify|assignee_and_step_owners" "$(curl -s "${AR[@]}" "$B/api/admin/workflows/catalog" | $PY -c "
import sys, json
a = [x for x in json.load(sys.stdin)['actions'] if x['key'] == 'notify']
print((a[0]['key'] + '|' + str([p for p in a[0]['params'] if p['key'] == 'to'][0]['default'])) if a else 'ABSENT')")" \
  "the catalog offers 'notify' now that one channel really delivers, addressed relatively by default"

# 1) THE DESK IT ARRIVES AT, NOT THE ONE IT LEAVES. The origin step is owned by service_advisor and
# is who is holding the record; the destination is owned by branch_manager. Custody is `keep`, so the
# holder does NOT change — which means an implementation reading the record's own step, or its
# assignee, would tell the wrong person and look entirely correct doing it.
nfclean
mkflow notify-owners '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100,"ownerRoles":["service_advisor"]},
          {"status":"priced","isTerminal":true,"x":340,"y":100,"ownerRoles":["branch_manager"]}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","handoff":"keep",
   "actions":[{"action":"notify","params":{"to":"step_owners","alsoTell":"nobody",
     "title":"{reference} needs pricing","message":"It is now {status}. {cost}"}}]}]}' > /dev/null
pick_winner NOTIFY-OWNERS > /dev/null
ok "multi@qparts.local" "$(told)" \
  "'the people responsible for this step' is the step it ARRIVES at, not the one it is leaving"
ok "staff@qparts.local" "$(psql "select u.email from workflow_record_state rs join users u on u.id=rs.assignee_user_id
                                 join rfq_items i on i.id = rs.entity_id join rfqs r on r.id = i.rfq_id
                                 where r.plate_number='NOTIFY-OWNERS'")" \
  "and the record is demonstrably still held by somebody else, so the two are not the same answer"
ok ok "$(psql "select outcome from workflow_action_runs where action='notify' limit 1")" \
  "the run log records the delivery as an action that worked"

# The message. A digest of one, in the only word that matters: a notification naming the status the
# record has just LEFT is wrong precisely when somebody is relying on it.
ok "It is now Priced. {cost}" "$(psql "select body from in_app_notifications where kind='workflow' limit 1")" \
  "it says where the record has ARRIVED — and leaves an unknown placeholder as literal text"
ok "/rfqs" "$(psql "select link from in_app_notifications where kind='workflow' limit 1")" \
  "and points at the screen the record is on, rather than being a nag with no destination"
ok 1 "$(psql "select count(*) from in_app_notifications n where kind='workflow' and n.title like '%needs pricing'")" \
  "the headline is the workspace's own words, with the record's number filled in"
ok "in_app|sent" "$(psql "select channel||'|'||status from notification_log where template='workflow' limit 1")" \
  "and it goes through the one delivery boundary, so the communications trail knows it happened"

# 2) NOBODY IS TOLD WHAT THEY JUST DID. An inbox that reports your own clicks back to you is an inbox
# people stop opening — the same rule the approvals inbox already applies, so the product has ONE
# answer to "why was I not told" rather than two.
nfclean
mkflow notify-self '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","handoff":"actor",
   "actions":[{"action":"notify","params":{"to":"assignee","title":"yours","message":"yours"}}]}]}' > /dev/null
pick_winner NOTIFY-SELF > /dev/null
ok skipped "$(psql "select outcome from workflow_action_runs where action='notify' limit 1")" \
  "a message whose only recipient is the person who made the move is not sent"
ok "NOBODY" "$(told)" "and nothing lands in anybody's inbox"
ok 1 "$(psql "select count(*) from workflow_action_runs where action='notify' and detail like '%the one who made the move%'")" \
  "with the run log saying why, so it does not read as a broken rule"

# 3) CREATED BY IS A REAL RELATIVE RECIPIENT. The review comment asks for recipients resolved from the
# record itself; this is the one that cannot be faked by reading custody, because the person who
# raised the request may be nowhere near the desk it is sitting on. The RFQ is raised by the admin
# and the move is made by SOMEBODY ELSE, or the self-suppression above would hide the whole leg.
nfclean
psql "insert into users (email, full_name, password_hash, is_active)
      values ('notifyactor@qparts.local','Notify Actor','$HASH',true)
      on conflict (email) do update set is_active=true" > /dev/null
psql "insert into platform_members (user_id, role, is_active)
      select id,'purchasing',true from users where email='notifyactor@qparts.local'
      on conflict do nothing" > /dev/null
NFTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"notifyactor@qparts.local","password":"admin1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
mkflow notify-creator '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","handoff":"keep",
   "actions":[{"action":"notify","params":{"to":"step_owners","alsoTell":"created_by",
     "title":"about {reference}","message":"raised by you"}}]}]}' > /dev/null
ACTOR=$NFTOK pick_winner NOTIFY-CREATOR > /dev/null
ok "admin@qparts.local" "$(told)" \
  "'also tell whoever raised it' reaches the record's creator, who is not the actor and holds nothing"
ok 1 "$(psql "select count(*) from workflow_action_runs where action='notify' and detail like '%raised it%'")" \
  "and the run log names WHY that person was told, not just how many were"

# 4) A BLOCKED NOTIFICATION IS NOT A SENT ONE. The ceiling is human-scaled for notify (500, email's
# number in the benchmark) because each success asks somebody for a moment of their day. If the cap
# were declared and not honoured, the runaway it exists to contain would be a flood of real messages.
nfclean
psql "insert into workflow_action_runs (tenant_id, environment, entity_type, entity_id, transition_key,
        action, params, outcome, detail)
      select t.id, 'live', 'rfq_item', gen_random_uuid(), 'new_rfq>priced', 'notify', '{}'::jsonb,
             'ok', 'filler: the day is full' from tenants t, generate_series(1, 500) where t.slug='riyadh'" > /dev/null
mkflow notify-capped '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","isTerminal":true,"x":340,"y":100,"ownerRoles":["branch_manager"]}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","handoff":"keep",
   "actions":[{"action":"notify","params":{"to":"step_owners","title":"over the line","message":"over the line"}}]}]}' > /dev/null
NFCAP=$(pick_winner NOTIFY-CAPPED)
ok 0 "$(blocked "$NFCAP")" "a workspace at its notification ceiling can still make the move"
ok capped "$(psql "select outcome from workflow_action_runs where action='notify' and detail like '%daily limit%'")" \
  "the message is refused for volume and RECORDED as refused"
ok "NOBODY" "$(told)" "and nothing was half-delivered on the way to being blocked"
nfclean
psql "delete from platform_members where user_id in (select id from users where email='notifyactor@qparts.local');
      delete from users where email='notifyactor@qparts.local'" > /dev/null

# ── the daily failure digest (QNEW-90 item 6) ────────────────────────────────────────────────────
# runActions() may never throw, so an action that breaks is SILENT everywhere except the run log —
# the flow looks configured and quietly is not. The digest is what tells somebody without their
# having to go and look, and the word doing the work is DIGEST: one message for the day, not one per
# failure, because a rule wired onto an arrow every order crosses would otherwise bury the rule that
# broke once.
#
# THE PROPERTY THAT IS EASY TO LOSE is not "does it send". It is "does it send TWICE". A window that
# is computed from the clock rather than from the last window re-reports everything in the overlap on
# every run, which is exactly the flood the digest replaced, wearing a daily label.
RIYADH=$(psql "select id from tenants where slug='riyadh'")
JEDDAH=$(psql "select id from tenants where slug='jeddah'")
rundigest(){ (cd "$API_DIR" && ./node_modules/.bin/tsx scripts/run-digest.ts 2>/dev/null | /usr/bin/grep '^SUMMARY'); }
dgclean(){
  psql "delete from workflow_failure_digests; delete from workflow_action_runs;
        delete from in_app_notifications; delete from notification_log where channel='in_app'" > /dev/null
}
# Failures placed one day back so they fall inside the window that closed at the workspace's last
# local midnight — which is what "yesterday" means to this job, and what a run today can report.
seedfail(){ # $1 = tenant id, $2 = environment, $3 = action, $4 = how many
  psql "insert into workflow_action_runs (tenant_id, environment, entity_type, entity_id, transition_key,
          action, params, outcome, detail, ran_at)
        select '$1'::uuid, '$2', 'rfq', gen_random_uuid(), 'a>b', '$3', '{}'::jsonb, 'failed',
               'the action could not complete', now() - interval '1 day'
        from generate_series(1, $4)" > /dev/null
}
digests(){ psql "select count(*) from in_app_notifications where kind='digest'"; }

# There was no scheduler in this repo at all — no @Cron, no interval, no @nestjs/schedule. A "daily"
# job with nothing to fire it is a method nobody calls, so the timer is asserted as a fact about the
# source rather than assumed from the feature working when a script runs it.
ok 1 "$(/usr/bin/grep -c "setInterval" "$API_DIR/src/modules/workflow/digest.service.ts")" \
  "there is a real timer behind the daily job, not a method waiting to be called by hand"
ok 1 "$(/usr/bin/grep -rl "WorkflowDigestService" "$API_DIR/src" | /usr/bin/grep -c "module\.ts$")" \
  "and exactly ONE module owns it — a second registration is a second timer sending the same digest"

# 1) A QUIET DAY. Nothing is delivered, and yet the window still closes: skipping quiet days would
# reopen them tomorrow and report a failure on a day it did not happen.
dgclean
rundigest > /dev/null
ok 0 "$(digests)" "a day with no failures tells nobody — a digest of nothing is an inbox people stop reading"
ok "$(psql "select count(*) * 2 from tenants where is_active")" "$(psql "select count(*) from workflow_failure_digests")" \
  "but every workspace still records that it looked — one window per workspace per environment"

# 2) FAILURES REACH THE WORKSPACE'S OWN MANAGERS, AS ONE MESSAGE.
dgclean
seedfail "$RIYADH" live set_field 2
seedfail "$RIYADH" live lock_record 1
rundigest > /dev/null
ok 1 "$(digests)" "three failures produce ONE message, not three"
ok "manager@qparts.local" "$(psql "select u.email from in_app_notifications n join users u on u.id=n.recipient_user_id
                                   where n.kind='digest'")" \
  "addressed to the workspace's own manager, resolved from membership rather than a configured list"
ok "3 workflow actions failed yesterday" "$(psql "select title from in_app_notifications where kind='digest'")" \
  "the headline is the day's total, which is the number somebody decides on"
ok 1 "$(psql "select count(*) from in_app_notifications where kind='digest' and body like 'Fill in a field — 2, Put it on hold — 1.%'")" \
  "and the body groups them by what broke, biggest first — a bare count is an alarm, not a diagnosis"
ok /status-logs "$(psql "select link from in_app_notifications where kind='digest'")" \
  "pointing at the screen that holds the detail, because an alarm with no map is a nag"

# 3) THE ONE THAT MATTERS: NO FAILURE IS REPORTED TWICE. Run it again, immediately.
rundigest > /dev/null
ok 1 "$(digests)" "running the job again reports nothing — a failure is reported once, however often it runs"
ok 1 "$(psql "select count(*) from workflow_failure_digests where tenant_id='$RIYADH' and environment='live'")" \
  "and the ledger still holds exactly one window for the day"

# 4) THE WINDOWS TILE THE TIMELINE. A digest sent yesterday must leave today's starting where it
# ended — not 24 hours before now, which would re-report the overlap, and not at today's midnight,
# which would drop whatever happened in between.
dgclean
seedfail "$RIYADH" live notify 1
psql "insert into workflow_failure_digests (tenant_id, environment, window_start, window_end, failures, recipients)
      select '$RIYADH'::uuid, 'live',
             (select date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh') - interval '2 days',
             (select date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh') - interval '1 day',
             0, 0" > /dev/null
rundigest > /dev/null
ok true "$(psql "select (min(window_end) = max(window_start))::text from workflow_failure_digests
                 where tenant_id='$RIYADH' and environment='live'")" \
  "the next window starts exactly where the last one ended — no gap to lose a failure in, no overlap"
ok 1 "$(digests)" "and the failure inside that window is reported, having never been reported before"

# The window stretching after an outage is the behaviour that stops failures being dropped. A message
# that then said "yesterday" would spend that correctness on a sentence sending the reader to the
# wrong day of the run log.
dgclean
seedfail "$RIYADH" live set_field 1
psql "insert into workflow_failure_digests (tenant_id, environment, window_start, window_end, failures, recipients)
      select '$RIYADH'::uuid, 'live',
             (select date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh') - interval '4 days',
             (select date_trunc('day', now() at time zone 'Asia/Riyadh') at time zone 'Asia/Riyadh') - interval '3 days',
             0, 0" > /dev/null
rundigest > /dev/null
ok "1 workflow action failed in the 3 days since the last digest" \
  "$(psql "select title from in_app_notifications where kind='digest'")" \
  "a digest after an outage says the window it really covers, not 'yesterday'"

# 5) MULTI-TENANCY AND ADR-0012. A digest that folded workspaces together would tell one workspace's
# manager about another's flows; one that folded environments together would report a rehearsal as a
# production incident. Both are asserted at once, with four different failure counts in play.
dgclean
seedfail "$RIYADH" live set_field 2
seedfail "$RIYADH" sandbox set_field 5
seedfail "$JEDDAH" live lock_record 1
rundigest > /dev/null
ok "2" "$(psql "select failures from workflow_failure_digests where tenant_id='$RIYADH' and environment='live'")" \
  "a workspace's Live digest counts its Live failures and nothing else"
ok "5" "$(psql "select failures from workflow_failure_digests where tenant_id='$RIYADH' and environment='sandbox'")" \
  "its Sandbox rehearsal is reported separately, which is what makes rehearsing worth doing"
ok "1" "$(psql "select failures from workflow_failure_digests where tenant_id='$JEDDAH' and environment='live'")" \
  "and another workspace's failures are its own"
ok 1 "$(psql "select count(*) from in_app_notifications n join users u on u.id=n.recipient_user_id
              where n.kind='digest' and u.email='manager@qparts.local' and n.environment='live'")" \
  "the Live digest lands once in the Live inbox of the one manager who should get it"
ok 0 "$(psql "select recipients from workflow_failure_digests where tenant_id='$JEDDAH' and environment='live'")" \
  "a workspace with no manager records that it had nowhere to send it, rather than failing silently"

# 6) A DIGEST OF FAILURES, NOT OF THINGS NOT DONE. 'capped' is the engine refusing on purpose and
# 'skipped' is an action declining itself; folding either in would make the headline number mean
# something much less alarming than it says, on the one message that exists to alarm.
dgclean
seedfail "$RIYADH" live set_field 1
psql "insert into workflow_action_runs (tenant_id, environment, entity_type, entity_id, transition_key,
        action, params, outcome, detail, ran_at)
      values ('$RIYADH'::uuid,'live','rfq',gen_random_uuid(),'a>b','notify','{}'::jsonb,'capped','over',now() - interval '1 day'),
             ('$RIYADH'::uuid,'live','rfq',gen_random_uuid(),'a>b','notify','{}'::jsonb,'skipped','n/a',now() - interval '1 day'),
             ('$RIYADH'::uuid,'live','rfq',gen_random_uuid(),'a>b','notify','{}'::jsonb,'ok','done',now() - interval '1 day')" > /dev/null
rundigest > /dev/null
ok "1 workflow action failed yesterday" "$(psql "select title from in_app_notifications where kind='digest'")" \
  "only what actually broke is counted — capped, skipped and successful runs are not failures"
dgclean

# ── insurance stops writing statuses behind the gateway's back ───────────────────────────────────
# InsuranceService was the last service in the system still doing `update rfqs set status_id = …` by
# hand. Everything below is a consequence that had no visible symptom: an insurance move appeared in
# no history, in no queue, and — the one that matters for a rules engine — under no rule. A workspace
# could draw a flow that governed every arrow except the two an insurer is involved in, and nothing
# anywhere would have said so.
insclean(){
  wfclean
  psql "delete from workflow_auto_fired; delete from workflow_action_runs; delete from status_logs;
        delete from workflow_record_state where entity_id in (select id from rfqs where plate_number like 'INS-%');
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'INS-%');
        delete from rfqs where plate_number like 'INS-%'" > /dev/null
}
insclean
INSCO=$(psql "select id from insurance_companies where tenant_id='$RIYADH' and name='Guard Insurer' limit 1")
[ -z "$INSCO" ] && INSCO=$(curl -s "${AR[@]}" -X POST "$B/api/insurance/companies" \
  -d '{"name":"Guard Insurer","suggestedDiscountPct":0}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
insured(){ # $1 = plate -> echoes the new rfq id, already set to an insurance payer
  local rid
  rid=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"INS-P","quantity":1}]}' "$BR" "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$rid/payer" \
    -d "$(printf '{"payerType":"insurance","insuranceCompanyId":"%s"}' "$INSCO")"
  echo "$rid"
}

# 1) WITH NO FLOW the behaviour is unchanged, which is the rollout promise: routing a service through
# the gateway must not make it refuse anything it used to allow.
INS1=$(insured INS-LOGGED)
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$INS1/insurance/send-for-approval")")" \
  "with no workflow drawn, an insurance move still happens exactly as before"
ok "new_rfq|sent_insurance_approval" "$(psql "select coalesce(f.code,'')||'|'||t.code from status_logs l
                                              left join item_statuses f on f.id=l.from_status_id
                                              join item_statuses t on t.id=l.to_status_id
                                              where l.entity_type='rfq' and l.entity_id='$INS1'
                                              order by l.created_at desc limit 1")" \
  "and it is now IN THE HISTORY — the move that used to leave no trace at all"
ok 1 "$(psql "select count(*) from status_logs where entity_type='rfq' and entity_id='$INS1'
               and to_status_id=(select id from item_statuses where code='sent_insurance_approval')
               and changed_by is not null")" \
  "credited to the person who made it, from the session rather than from the request body"

# Its own state machine is unchanged, and still the thing that says these two moves have an order.
ok 1 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$INS1/insurance/send-for-approval")")" \
  "the hand-written state machine still refuses a second send"
ok 0 "$(blocked "$(curl -s "${NM[@]}" -X POST "$B/api/rfqs/$INS1/insurance/approve")")" \
  "and approving from the state it does allow still works"
ok 2 "$(psql "select count(*) from status_logs where entity_type='rfq' and entity_id='$INS1'
               and to_status_id in (select id from item_statuses where code in ('sent_insurance_approval','insurance_approved'))")" \
  "so both insurance moves are events now, not silent column writes"

# 2) THE POINT: A WORKFLOW RULE NOW APPLIES TO THEM. A flow that does not draw the insurance arrow
# must refuse it, exactly as it refuses every other move off the drawn path. Before this change the
# rule was unenforceable on this one service, and nothing said so.
insclean
INS2=$(insured INS-GOVERNED)
mkflow ins-governed '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}' > /dev/null
ok 1 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$INS2/insurance/send-for-approval")")" \
  "an insurance move that the workspace's flow does not draw is REFUSED, like any other"
ok new_rfq "$(rfqstatus "$INS2")" "and the record does not move — the refusal is not cosmetic"

# 3) DRAWN, AND THEREFORE GOVERNED IN FULL: custody, the run log and an action all follow it.
insclean
INS3=$(insured INS-DRAWN)
mkflow ins-drawn '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"sent_insurance_approval","isTerminal":true,"x":340,"y":100,"ownerRoles":["company_admin"],"slaHours":6}],
 "transitions":[{"from":"new_rfq","to":"sent_insurance_approval","labelEn":"Send to insurer","handoff":"pool",
   "actions":[{"action":"set_field","params":{"field":"model","value":"seen by the engine"}}]}]}' > /dev/null
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$INS3/insurance/send-for-approval")")" \
  "an insurance move the flow DOES draw is allowed"
ok "manager@qparts.local" "$(psql "select u.email from workflow_record_state rs join users u on u.id=rs.assignee_user_id
                                   where rs.entity_type='rfq' and rs.entity_id='$INS3'")" \
  "custody follows it, so an insurer request lands on a desk instead of nowhere"
ok true "$(psql "select (due_at is not null)::text from workflow_record_state where entity_type='rfq' and entity_id='$INS3'")" \
  "the step's SLA clock runs on it like any other work"
ok "seen by the engine" "$(psql "select model from rfqs where id='$INS3'")" \
  "and an action configured on that arrow actually fires — the move is a workflow event now"
ok 1 "$(psql "select count(*) from workflow_action_runs where entity_id='$INS3'")" \
  "recorded in the run log, where every other consequence of a move already was"
insclean

# ── MY WORK REACHES THE PEOPLE IT IS FOR ─────────────────────────────────────────────────────────
# WorkflowController is @PlatformOnly() at class level because almost all of it is flow AUTHORING.
# Two of its routes are not: My Work and claiming. Custody assigns work to tenant_memberships roles,
# and the custody checks above already prove a pooled record lands on a workspace manager — who,
# until now, could neither see it nor take it. The screen existed for people who could not open it.
STFTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"staff@qparts.local","password":"staff1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
ST=(-H "Authorization: Bearer $STFTOK" -H "X-Tenant: riyadh" -H "Content-Type: application/json")
code(){ curl -s -o /dev/null -w '%{http_code}' "$@"; }

ok 200 "$(code "${NM[@]}" "$B/api/admin/workflows/my-work")" \
  "the workspace manager custody hands records to can finally open My Work"
ok 200 "$(code "${ST[@]}" "$B/api/admin/workflows/my-work")" \
  "and so can a service advisor — every role the engine may assign work to"

# The door is still a door. Cancelling @PlatformOnly() for a route without naming who may come
# through would have opened the workspace's internal queue to a vendor's session.
psql "insert into users (email, full_name, password_hash, is_active)
      values ('workvendor@qparts.local','Work Vendor','$HASH',true)
      on conflict (email) do update set is_active=true" > /dev/null
psql "insert into tenant_memberships (tenant_id, user_id, role, is_active)
      select '$RIYADH'::uuid, id, 'vendor_user', true from users where email='workvendor@qparts.local'
      on conflict do nothing" > /dev/null
VWTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"workvendor@qparts.local","password":"admin1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
ok 403 "$(code -H "Authorization: Bearer $VWTOK" -H "X-Tenant: riyadh" "$B/api/admin/workflows/my-work")" \
  "a role the engine never assigns work to is still refused — the route names who may come through"

# AUTHORING IS UNTOUCHED. The exception is per route, so a manager who can now read their own queue
# still cannot list, draw or publish a rule.
ok 403 "$(code "${NM[@]}" "$B/api/admin/workflows")" "a workspace manager still cannot list the flows"
ok 403 "$(code "${NM[@]}" "$B/api/admin/workflows/catalog")" "nor read the vocabulary they are built from"
ok 403 "$(code "${NM[@]}" -X PUT "$B/api/admin/workflows/00000000-0000-0000-0000-000000000000/graph" -d '{"steps":[],"transitions":[]}')" \
  "nor draw one — the authoring surface stays platform-only, which is the whole reason for the door"

# AND THEY CAN ACT ON IT. A queue you can see and cannot take from is a list, not a queue. The pooled
# record here is created the same way the custody section creates one: a step owned by a role, and a
# `pool` handoff on the arrow into it.
insclean
psql "delete from workflow_record_state" > /dev/null
mkflow work-pool '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","isTerminal":true,"x":340,"y":100,"ownerRoles":["branch_manager"]}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price","handoff":"pool"}]}' > /dev/null
psql "update tenant_memberships set is_active=false
      where tenant_id='$RIYADH' and user_id=(select id from users where email='multi@qparts.local')" > /dev/null
pick_winner WORK-POOL > /dev/null
psql "update tenant_memberships set is_active=true
      where tenant_id='$RIYADH' and user_id=(select id from users where email='multi@qparts.local')" > /dev/null
MBTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"multi@qparts.local","password":"multi1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
MB=(-H "Authorization: Bearer $MBTOK" -H "X-Tenant: riyadh" -H "Content-Type: application/json")
WKIT=$(psql "select i.id from rfq_items i join rfqs r on r.id=i.rfq_id where r.plate_number='WORK-POOL' limit 1")
ok 1 "$(curl -s "${MB[@]}" "$B/api/admin/workflows/my-work" | $PY -c "
import sys, json; d = json.load(sys.stdin); print(len(d['pool']))")" \
  "an unclaimed record owned by their role shows up in the branch manager's pool"
ok 201 "$(code "${MB[@]}" -X POST "$B/api/admin/workflows/records/rfq_item/$WKIT/claim" -d "{}")" \
  "and they can take it — the claim endpoint opens with the screen that offers the button"
ok "multi@qparts.local" "$(psql "select u.email from workflow_record_state rs join users u on u.id=rs.assignee_user_id
                                 where rs.entity_id='$WKIT'")" \
  "custody really moves to them, rather than the button reporting success and doing nothing"
ok 1 "$(curl -s "${MB[@]}" "$B/api/admin/workflows/my-work" | $PY -c "
import sys, json; d = json.load(sys.stdin); print(len(d['mine']))")" \
  "and it moves from the pool into what is theirs, which is the whole loop the screen exists for"

# The nav has to offer it, or the fix is an endpoint nobody can reach from the product.
ok 1 "$(/usr/bin/sed -n '/export const workspaceNav/,/^export const /p' "$API_DIR/../web/src/nav.tsx" \
        | /usr/bin/grep -c 'path: "/my-work"')" \
  "the WORKSPACE persona's nav carries the link, not only the platform one it already had"

insclean
psql "update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'WORK-%');
      delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'WORK-%'));
      delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'WORK-%');
      delete from workflow_record_state where entity_id in (select id from rfq_items where rfq_id in (select id from rfqs where plate_number like 'WORK-%'));
      delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'WORK-%');
      delete from workflow_record_state where entity_id in (select id from rfqs where plate_number like 'WORK-%');
      delete from notification_log where template='vendor_rfq_invite';
      delete from rfqs where plate_number like 'WORK-%';
      delete from tenant_memberships where user_id in (select id from users where email='workvendor@qparts.local');
      delete from users where email='workvendor@qparts.local';
      delete from in_app_notifications; delete from notification_log where channel='in_app';
      delete from workflow_action_runs; delete from status_logs" > /dev/null

# ── THE WEBHOOK ACTION: AN OUTBOX, A GUARD, AND A DISPATCHER (QNEW-90 item 3) ────────────────────
# `webhook` was held back through 0056 and 0061 while the other four actions shipped, for two
# objections that are both real and both about something other than "does it call the URL":
#
#   (a) IT IS THE FIRST OUTBOUND REQUEST IN THIS SYSTEM WHOSE DESTINATION A USER CHOOSES. There is
#       exactly one other outbound call in the whole codebase (common/ai.service.ts, to a hostname
#       written in the source). Unguarded, this action is a "fetch any URL for me" primitive issued
#       from a process that can reach the database, the other services on the box, and — on any
#       cloud host — the metadata endpoint that hands out credentials to whoever asks.
#   (b) A WEBHOOK SENT FROM INSIDE THE BUSINESS TRANSACTION CAN OUTLIVE IT. Tell the receiver, then
#       roll back, and the receiver has booked a shipment against an order that does not exist.
#
# The checks below are grouped by which objection they answer. The ones that matter most are the
# pair proving a refused move leaves NO delivery behind and a committed one leaves exactly one:
# that is objection (b) answered by construction rather than by care, and it is the property that
# silently stops being true the moment anybody moves the send out of the dispatcher.
whclean(){
  psql "delete from workflow_webhook_outbox;
        delete from workflow_action_runs; delete from workflow_exceptions; delete from status_logs;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'HOOK-%');
        delete from order_items where order_id in (select id from orders where rfq_id in (select id from rfqs where plate_number like 'HOOK-%'));
        delete from orders where rfq_id in (select id from rfqs where plate_number like 'HOOK-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'HOOK-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'HOOK-%');
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'HOOK-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from rfqs where plate_number like 'HOOK-%'" > /dev/null
}
runwebhooks(){ (cd "$API_DIR" && ./node_modules/.bin/tsx scripts/run-webhooks.ts 2>/dev/null | /usr/bin/grep '^SUMMARY'); }
outbox(){ psql "select count(*) from workflow_webhook_outbox"; }
wfclean; whclean

# ── (a) THE GUARD. Two proof files, folded in whole ──────────────────────────────────────────────
# The exhaustive table belongs in process, not in shell: forty-odd spellings of "this machine", each
# a single function call against the real exported guard, is affordable there and would be four
# checks here. Both files print this file's own PASS/FAIL shape, so their cases land in the totals.
#
# EACH IS FOLLOWED BY A CHECK THAT IT RAN. A tsx script that dies on an import error prints nothing,
# and nothing greps clean — a suite that counts lines would report a silently absent proof as zero
# failures, which is the shape of every green build that was not testing anything.
SSRFOUT=$(cd "$API_DIR" && ./node_modules/.bin/tsx scripts/prove-ssrf-guard.ts 2>&1)
echo "$SSRFOUT" | /usr/bin/grep -E '^  (PASS|FAIL)'
ok 1 "$([ "$(echo "$SSRFOUT" | /usr/bin/grep -c '^  PASS')" -ge 70 ] && echo 1 || echo 0)" \
  "the SSRF spelling table really executed — a proof that silently does not run counts as nothing"

DELOUT=$(cd "$API_DIR" && ./node_modules/.bin/tsx scripts/prove-webhook-delivery.ts 2>&1)
echo "$DELOUT" | /usr/bin/grep -E '^  (PASS|FAIL)'
ok 1 "$([ "$(echo "$DELOUT" | /usr/bin/grep -c '^  PASS')" -ge 20 ] && echo 1 || echo 0)" \
  "and so did the one that stands up a real listener and checks the signature on the wire"

# The loose AddressPolicy is what lets that listener be reached at all. It is a test-only value, and
# this is the check that keeps it one: an `if (process.env.ALLOW_INSECURE_WEBHOOKS)` would be three
# fewer lines and exactly the switch that gets set on a staging box and inherited by production.
# Comment lines are stripped before counting: webhook-url.ts DESCRIBES this very check in its own
# header, and a grep that cannot tell code from the prose about the code would fail on a file that
# is doing exactly the right thing — which teaches the next reader to loosen the assertion.
nocomment(){ /usr/bin/grep -vE ':[0-9]+: *(\*|//|#)'; }
ok 0 "$(/usr/bin/grep -rnE "allowLoopback: true|trustAnyCertificate: true" "$API_DIR/src" | nocomment | /usr/bin/wc -l | /usr/bin/tr -d ' ')" \
  "no shipped code path can select the policy that permits loopback — it exists only under scripts/"

# The dispatcher is a background job, and the digest's section above asserts the same two facts for
# the same reason: a "continuous" delivery loop with nothing to fire it is a method nobody calls, and
# a second registration is a second ticker.
ok 1 "$(/usr/bin/grep -nE "setInterval" "$API_DIR/src/modules/workflow/webhook-dispatch.service.ts" \
        | /usr/bin/grep -vE '^[0-9]+: *(\*|//)' | /usr/bin/wc -l | /usr/bin/tr -d ' ')" \
  "there is a real ticker behind the dispatcher, not a method waiting to be called by hand"
ok 1 "$(/usr/bin/grep -rl "WorkflowWebhookDispatchService" "$API_DIR/src" | /usr/bin/grep -c "module\.ts$")" \
  "and exactly ONE module owns it"

# The floor under the guard. validateWebhookUrl is the real check; this is what remains true after a
# hand-fix on a live database, which is the one path that never goes through TypeScript.
ok 1 "$(psql "insert into workflow_webhook_outbox (tenant_id, environment, entity_type, entity_id, url)
               select id, 'live', 'rfq', gen_random_uuid(), 'http://169.254.169.254/latest/meta-data/'
               from tenants where slug='riyadh'" 2>&1 | /usr/bin/grep -c 'violates check constraint')" \
  "the database itself refuses a non-https destination, not only the code that writes it"

# ── THE SIGNING KEY ──────────────────────────────────────────────────────────────────────────────
# A URL is not an authenticator: anyone who reads a flow definition or a proxy log learns it. The
# signature is how a receiver tells our call from theirs — and it is worth nothing if nobody can be
# told the key, which is why the endpoint exists at all.
ok 0 "$(psql "select count(*) from workflow_webhook_secrets where secret !~ '^[0-9a-f]{64,}$'")" \
  "every signing key is hex from the database's own CSPRNG — none was chosen by a person"
ok 1 "$(curl -s "${AR[@]}" "$B/api/admin/workflows/webhook-secret" | $PY -c "
import sys, json
d = json.load(sys.stdin)
print(1 if len(d.get('secret') or '') >= 64 and d.get('scheme', {}).get('algorithm') == 'HMAC-SHA256' else 0)")" \
  "whoever writes the receiving end can be told the key AND the scheme, or the signature is theatre"
ok 403 "$(code "${MR[@]}" "$B/api/admin/workflows/webhook-secret")" \
  "and a workspace manager cannot read it — it is a credential, not a setting"

# ── (b) THE OUTBOX: A REFUSED MOVE TELLS NOBODY ──────────────────────────────────────────────────
# The same composition the actions section uses, because it is the only path in the product where an
# action provably runs and is then rolled back: pricing the line files a hold, and the hold refuses
# the later confirm — after the header's actions have already run inside that transaction.
whclean
WHF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-hook","nameAr":"ويب هوك","nameEn":"Webhook","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$WHF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[
   {"from":"new_rfq","to":"priced","labelEn":"Price","actions":[{"action":"lock_record","params":{"reason":"the price needs a look"}}]},
   {"from":"priced","to":"confirmed","labelEn":"Confirm line"},
   {"from":"new_rfq","to":"confirmed","labelEn":"Confirm header",
    "actions":[{"action":"webhook","params":{"url":"https://hooks.qvm-guard.invalid/qvm"}}]}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$WHF/activate"

WHR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"HOOK-1","items":[{"partNumber":"HP1","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
WHTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$WHR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
WHIT=$(psql "select id from rfq_items where rfq_id='$WHR' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$WHTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$WHIT")"
WHQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$WHIT' limit 1")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$WHR/items/$WHIT/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$WHQI")"

WHCONF=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$WHR/confirm" -d '{}')
ok 1 "$(echo "$WHCONF" | $PY -c "import sys,json;print(1 if 'on hold' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a hold refuses the confirm, so the header's actions run and are then rolled back"
# THE CHECK THE WHOLE DESIGN EXISTS FOR. The webhook action ran — it validated the destination and
# inserted a row — and the transaction that carried it was refused. A dispatcher that sends from
# inside the move would already have told the receiver by now.
ok 0 "$(outbox)" \
  "and the delivery goes with it: a refused move leaves NO outbox row, so nobody was told"

WHEID=$(psql "select id from workflow_exceptions where entity_id='$WHIT'")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/workflow/exceptions/$WHEID/release" -d '{"note":"looked at"}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$WHR/confirm" -d '{}'
ok 1 "$(outbox)" "and the same move, once it really commits, leaves exactly ONE"
ok pending "$(psql "select status from workflow_webhook_outbox")" \
  "queued as pending — the action's job ends at the row"
# THE ACTION NEVER SENDS, asserted about the source rather than about the row. The obvious check —
# "attempts is still 0" — races the server's own ticker, which is armed during this suite and may
# legitimately have claimed the row in the millisecond since the confirm. That would make a true
# property flaky, and a suite people learn to re-run is a suite nobody trusts. This cannot race:
# there is no way to open a socket from a file that can neither import the sender nor reach https.
ok 0 "$(/usr/bin/grep -cE "postGuarded|https\.request|node:https" "$API_DIR/src/modules/workflow/actions.ts")" \
  "and it CANNOT send — nothing in actions.ts can open a socket at all"
ok ok "$(psql "select outcome from workflow_action_runs where action='webhook'")" \
  "the run log records the action as having queued a delivery"
ok 1 "$(psql "select count(*) from workflow_action_runs where action='webhook' and detail like 'queued a delivery%'")" \
  "and says QUEUED rather than sent, because at that moment nothing had dialled anything"

# What actually leaves the building. The delivery id is the row's own id and it is INSIDE the body,
# which is the copy the signature covers — a receiver de-duplicating on the header alone would be
# trusting a value nobody authenticated.
ok "true|new_rfq>confirmed|rfq" "$(psql "select ((payload->>'delivery') = id::text)::text ||'|'||
       (payload->'transition'->>'key') ||'|'|| (payload->'record'->>'type') from workflow_webhook_outbox")" \
  "the row's own id is the delivery id in the signed body, beside the move that caused it"

# ── THE DISPATCHER: RETRIED, THEN GIVEN UP ON, THEN VISIBLE ──────────────────────────────────────
# The destination is a name that cannot resolve, so no request leaves this machine and the failure is
# the same one a receiver that is simply down produces.
psql "update workflow_webhook_outbox set next_attempt_at = now()" > /dev/null
runwebhooks > /dev/null
ok pending "$(psql "select status from workflow_webhook_outbox")" \
  "a delivery that fails is kept for another try rather than thrown away"
ok true "$(psql "select (next_attempt_at > now())::text from workflow_webhook_outbox")" \
  "and is pushed into the future by the backoff, so a broken receiver is not hammered"
ok 1 "$(psql "select count(*) from workflow_webhook_outbox where last_error <> ''")" \
  "with the reason on the row, because 'it did not work' is not an answer"

# RETRIES END. A queue that retries forever is a queue that hides a permanent failure behind an
# infinite supply of hope. Driven by hand rather than by waiting out a schedule that spans 11 hours.
for _ in 1 2 3 4 5 6 7 8; do
  psql "update workflow_webhook_outbox set next_attempt_at = now() where status = 'pending'" > /dev/null
  runwebhooks > /dev/null
done
ok dead "$(psql "select status from workflow_webhook_outbox")" \
  "a delivery that cannot be made is eventually given up on, not retried for ever"
ok 6 "$(psql "select attempts from workflow_webhook_outbox")" \
  "after the attempt ceiling, which is the length of the backoff schedule and not a second constant"
# A terminal state that is not actually terminal is the worst of both worlds: it reads as "we gave
# up" on the screen and goes on generating load for ever. Make it due again and run a pass — the
# claim filters on status='pending', so nothing may move.
psql "update workflow_webhook_outbox set next_attempt_at = now()" > /dev/null
runwebhooks > /dev/null
ok "dead|6" "$(psql "select status||'|'||attempts from workflow_webhook_outbox")" \
  "and a dead row is never claimed again, however overdue it looks"

# A DEAD DELIVERY MUST BE VISIBLE, IN THE PLACES THAT ALREADY EXIST. The run log is where a failed
# action is found and the digest is what tells somebody without their going to look; a third screen
# would mean two answers to "where do I check" and no rule about which is authoritative.
ok 1 "$(psql "select count(*) from workflow_action_runs where action='webhook_delivery' and outcome='failed'")" \
  "giving up is written to the run log, under its own key — the flow queued it, the dispatcher lost it"
ok 1 "$(curl -s "${AR[@]}" "$B/api/workflow/run-log?outcome=failed" | $PY -c "
import sys, json
print(len([r for r in json.load(sys.stdin)['rows'] if r.get('action') == 'webhook_delivery']))")" \
  "and the screen a person opens really renders it"

dgclean
seedfail "$RIYADH" live webhook_delivery 1
rundigest > /dev/null
ok 1 "$(psql "select count(*) from in_app_notifications where kind='digest' and body like 'A call to another system%'")" \
  "and the daily digest names it in words, rather than leaking the raw key into the one legible message"
dgclean

# ── THE DESTINATION IS REFUSED BEFORE A ROW EXISTS ──────────────────────────────────────────────
# The end-to-end half of the SSRF table: not a function call, but a real flow an admin configured
# with the address that hands out this server's cloud credentials.
wfclean; whclean
WHF2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-hook2","nameAr":"وجهة مرفوضة","nameEn":"Refused","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
# Saved with a LEGITIMATE destination, then rewritten in the database to the forbidden one — because
# the save path now refuses this address outright and would not let the flow be created. That is not
# a way around the test, it IS the test: it reproduces a row that got in before the save gate existed,
# or one written by somebody with database access, and proves the dispatcher refuses it anyway. The
# save gate stops a mistake being authored; this asserts the layer that stops it being delivered.
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$WHF2/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price",
   "actions":[{"action":"webhook","params":{"url":"https://example.com/hook"}}]}]}'
psql "update workflow_transitions set actions = jsonb_build_array(jsonb_build_object(
        'action', 'webhook',
        'params', jsonb_build_object('url', 'https://169.254.169.254/latest/meta-data/iam/security-credentials/')))
      where flow_id = '$WHF2'::uuid" > /dev/null
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$WHF2/activate"
pick_winner HOOK-SSRF > /dev/null
ok failed "$(psql "select outcome from workflow_action_runs where action='webhook'")" \
  "a flow pointed at the cloud metadata endpoint fails the action"
ok 1 "$(psql "select count(*) from workflow_action_runs where action='webhook' and detail like '%metadata%'")" \
  "naming what was actually being attempted, not a CIDR the reader has to look up"
ok 0 "$(outbox)" \
  "and NOTHING is queued — a destination the dispatcher would refuse never becomes a row it retries"
ok 1 "$(psql "select count(*) from rfq_items i join item_statuses s on s.id=i.status_id
               join rfqs r on r.id=i.rfq_id where r.plate_number='HOOK-SSRF' and s.code='priced'")" \
  "while the move itself still happens — a bad destination is a broken rule, not a refused click"

# ── THE DAILY CEILING ────────────────────────────────────────────────────────────────────────────
# A webhook lands on a machine, not on somebody's attention, so it sits at the high end of the scale
# beside set_field. High is not absent: each one is a delivery a dispatcher will attempt and retry.
wfclean; whclean
WHF3=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-hook3","nameAr":"سقف","nameEn":"Ceiling","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$WHF3/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price",
   "actions":[{"action":"webhook","params":{"url":"https://hooks.qvm-guard.invalid/qvm"}}]}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$WHF3/activate"
psql "insert into workflow_action_runs (tenant_id, environment, entity_type, entity_id, transition_key,
        action, params, outcome, detail)
      select t.id, 'live', 'rfq_item', gen_random_uuid(), 'new_rfq>priced', 'webhook', '{}'::jsonb,
             'ok', 'filler: the day is full' from tenants t, generate_series(1, 10000) where t.slug='riyadh'" > /dev/null
pick_winner HOOK-CAP > /dev/null
ok capped "$(psql "select outcome from workflow_action_runs where action='webhook' and detail not like 'filler%'")" \
  "the ten-thousandth delivery in a day is the last one — the ceiling applies to webhook too"
ok 0 "$(outbox)" \
  "and a capped action queues nothing, so a runaway flow cannot fill the outbox it was refused from"
ok 1 "$(psql "select count(*) from rfq_items i join item_statuses s on s.id=i.status_id
               join rfqs r on r.id=i.rfq_id where r.plate_number='HOOK-CAP' and s.code='priced'")" \
  "while the move still goes through, because a ceiling on follow-up work is not a veto on the click"

wfclean; whclean
psql "delete from workflow_webhook_outbox; delete from workflow_action_runs; delete from status_logs;
      delete from in_app_notifications; delete from notification_log where channel='in_app';
      delete from workflow_failure_digests" > /dev/null

# ── a webhook destination is refused when it is TYPED, not only when it is dialled ───────────────
# The dial-time guard is the real defence and is asserted elsewhere: it resolves the name itself and
# hands the socket the address it judged, so nothing reaches a private network however the name
# behaves. But safe-later is not told-now. Before this, an admin could save a webhook pointing at
# 127.0.0.1, activate the flow, and find out weeks later from a run log nobody watches. Two gates,
# two different failures: this one stops the mistake being authored, the other stops a name that
# resolves somewhere else by the time we dial it.
wfclean
hookrefused(){ # $1 = url, $2 = label
  local F R
  F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d '{"flowKey":"smoke-hook","nameAr":"هوك","nameEn":"Hook","isDefault":false}' \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  R=$(curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "{\"selectionCondition\":{},
   \"steps\":[{\"status\":\"new_rfq\",\"isEntry\":true,\"x\":80,\"y\":100},{\"status\":\"priced\",\"isTerminal\":true,\"x\":340,\"y\":100}],
   \"transitions\":[{\"from\":\"new_rfq\",\"to\":\"priced\",\"labelEn\":\"P\",
     \"actions\":[{\"action\":\"webhook\",\"params\":{\"url\":\"$1\"}}]}]}")
  psql "delete from workflow_transitions where flow_id='$F'; delete from workflow_steps where flow_id='$F';
        delete from workflow_flows where id='$F'" > /dev/null
  ok 1 "$(echo "$R" | $PY -c "import sys,json;print(1 if 'message' in json.load(sys.stdin) else 0)")" \
    "a webhook to $2 is refused when the flow is saved"
}
hookrefused "http://example.com/hook"                  "plain http"
hookrefused "https://127.0.0.1/hook"                   "loopback"
hookrefused "https://localhost/hook"                   "the name localhost"
hookrefused "https://[::1]/hook"                       "IPv6 loopback"
hookrefused "https://2130706433/hook"                  "127.0.0.1 written as an integer"
hookrefused "https://169.254.169.254/latest/meta-data" "the cloud metadata service"
hookrefused "https://10.0.0.5/hook"                    "private 10/8"
hookrefused "https://192.168.1.1/hook"                 "private 192.168/16"
hookrefused "https://[fd00::1]/hook"                   "IPv6 unique-local"
hookrefused "https://user:pass@127.0.0.1/hook"         "credentials in the URL"
hookrefused "file:///etc/passwd"                       "a file:// URL"

# and a real destination still saves, or the guard is just a wall
HOKF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-hook","nameAr":"هوك","nameEn":"Hook","isDefault":false}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 0 "$(curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$HOKF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"P","actions":[{"action":"webhook","params":{"url":"https://example.com/hook"}}]}]}' \
  | $PY -c "import sys,json;print(1 if 'message' in json.load(sys.stdin) else 0)")" \
  "while an ordinary public https destination still saves"
wfclean

# ── MORE THAN ONE WORKFLOW PER WORKSPACE (0065) ─────────────────────────────────────────────────
#
# `selection_condition` was stored, validated at activation and frozen by a trigger since the engine
# was built, and read by NOTHING: the guard resolved the flow with `is_default limit 1`, so a second
# flow could be drawn and activated and would never govern a single record. This is the owner's own
# arrangement — an insurance flow and a cash flow side by side — driven for real.
#
# The two properties that matter more than the routing itself are asserted below and are easy to
# lose: the choice is made ONCE (editing a fact mid-flight must not swap the rulebook under the
# people working the record), and two flows that both match resolve the SAME WAY every time.
selclean(){
  wfclean
  psql "delete from status_logs;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'SEL-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'SEL-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'SEL-%');
        delete from workflow_record_state where entity_id in (select id from rfq_items where rfq_id in (select id from rfqs where plate_number like 'SEL-%'));
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'SEL-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from workflow_record_state where entity_id in (select id from rfqs where plate_number like 'SEL-%');
        delete from rfqs where plate_number like 'SEL-%'" > /dev/null
}
selflow(){ # $1 = key suffix, $2 = graph json -> echoes the flow id, activated
  local F
  F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d "$(printf '{"flowKey":"smoke-sel-%s","nameAr":"مسار","nameEn":"Sel %s","isDefault":%s}' "$1" "$1" "${3:-false}")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "$2"
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$F/activate"
  echo "$F"
}
selrfq(){ # $1 = plate, $2 = deliveryType, $3 = orderType -> echoes the rfq id
  curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","deliveryType":"%s","orderType":"%s","items":[{"partNumber":"SP","quantity":1}]}' "$BR" "$1" "$2" "$3")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))"
}
selkey(){ psql "select f.flow_key from workflow_record_state s join workflow_flows f on f.id=s.flow_id where s.entity_id='$1'"; }
# Drive the request to the winning quote — the move the flows below disagree about. The fallback
# draws new_rfq → priced and the conditional flows do not, so whether this is allowed says which
# rulebook the record is actually executing.
selprice(){ # $1 = rfq id -> echoes the winning-quote response
  local tok it qi
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$1/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  it=$(psql "select id from rfq_items where rfq_id='$1' limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  curl -s "${AR[@]}" -X POST "$B/api/rfqs/$1/items/$it/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
}

selclean
# The fallback: no condition to match, drawn new_rfq → priced like the rest of this file.
SELDEF=$(selflow def '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}' true)
# The alternative: a DIFFERENT rulebook, deliberately without a `priced` step, so which flow a record
# joined is observable in what it is allowed to do rather than only in a column.
SELPICK=$(selflow pickup '{"selectionCondition":{"all":[{"field":"delivery_type","op":"eq","value":"pickup"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"confirmed","labelEn":"Confirm"}]}')
ok active "$(psql "select status from workflow_flows where id='$SELPICK'")" \
  "a SECOND flow can be live in the same domain beside the fallback — that is no longer a collision"
ok 2 "$(psql "select count(*) from workflow_flows where flow_key like 'smoke-sel-%' and status='active'")" \
  "both are active at once, and only one of them is the default"

R_PICK=$(selrfq SEL-PICKUP pickup regular)
R_PLAIN=$(selrfq SEL-PLAIN delivery regular)
ok smoke-sel-pickup "$(selkey "$R_PICK")" \
  "a record whose facts match a flow's condition binds to THAT flow, not to the default"
ok smoke-sel-pickup "$(psql "select distinct f.flow_key from workflow_record_state s
                             join workflow_flows f on f.id=s.flow_id
                             where s.entity_id in (select id from rfq_items where rfq_id='$R_PICK')")" \
  "and so do its lines — a line is judged on the request's facts, exactly as a transition condition is"
ok smoke-sel-def "$(selkey "$R_PLAIN")" \
  "a record that matches no condition falls back to the default flow"
ok 1 "$(blocked "$(selprice "$R_PICK")")" \
  "and the flow it was matched to is the one that GOVERNS it: a move that flow does not draw is refused"
ok 0 "$(blocked "$(selprice "$R_PLAIN")")" \
  "while the fallback's record moves exactly as it did before any of this existed"

# ── determinism: two conditions, one record, and the same answer every time ──────────────────────
# A bulk pickup satisfies both flows. Something has to decide, it has to be written down, and it has
# to be the same decision on every run — otherwise the rulebook an order executes depends on the row
# order Postgres happened to return.
SELBULK=$(selflow bulk '{"selectionCondition":{"all":[{"field":"order_type","op":"eq","value":"bulk"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"cancelled","labelEn":"Cancel"}]}')
SELBOTH=""
for i in 1 2 3; do
  SELBOTH="$SELBOTH$(selkey "$(selrfq "SEL-BOTH$i" pickup bulk)") "
done
ok "smoke-sel-pickup smoke-sel-pickup smoke-sel-pickup " "$SELBOTH" \
  "two flows matching the same record resolve the same way on every run — equal priority, oldest first"

# and the tie-break is a real dial, not a description of an accident
SELFIRST=$(selflow first '{"selectionCondition":{"all":[{"field":"delivery_type","op":"eq","value":"pickup"}]},"selectionPriority":10,
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"settled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"settled","labelEn":"Settle"}]}')
ok smoke-sel-first "$(selkey "$(selrfq SEL-PRIORITY pickup bulk)")" \
  "a higher selection priority wins over an older flow with the same condition"
ok 10 "$(psql "select selection_priority from workflow_flows where id='$SELFIRST'")" \
  "the priority is stored, not merely accepted"

# ── the choice is made ONCE ──────────────────────────────────────────────────────────────────────
# payer_type, order_type and delivery_type are ordinary editable fields. If selection were re-run on
# every move, correcting one halfway through would hand the record a different rulebook — arrows that
# existed this morning gone, and nothing in the history recording the switch.
R_STICK=$(selrfq SEL-STICK pickup regular)
ok smoke-sel-first "$(selkey "$R_STICK")" "a pickup request binds to the pickup flow"
psql "update rfqs set delivery_type='delivery' where id='$R_STICK'" > /dev/null
ok smoke-sel-first "$(selkey "$R_STICK")" \
  "editing the fact it was matched on does NOT move it to another flow"
ok 1 "$(blocked "$(selprice "$R_STICK")")" \
  "and it is still judged by the flow it entered under, not by the one it would match today"

# ── one FALLBACK, however many flows ─────────────────────────────────────────────────────────────
# The partial unique index refused a second default before this and still does; what changed is that
# the refusal is now a sentence naming the flow holding the slot, instead of a 500 quoting the index.
SELDEF2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-sel-def2","nameAr":"ثان","nameEn":"Second fallback","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$SELDEF2/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}'
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$SELDEF2/activate" | $PY -c "
import sys,json;print(1 if 'already the fallback flow' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a second DEFAULT is refused in words — a record matching nothing must have exactly one answer"
ok draft "$(psql "select status from workflow_flows where id='$SELDEF2'")" \
  "and it stays a draft rather than half-activating"

# ── a routing rule nobody can evaluate is refused when it is WRITTEN ─────────────────────────────
# Both of these used to save: `selectionCondition` was `z.record(z.unknown())`. An unknown field
# fails closed at run time, so the flow would simply never be chosen — silently, with every record
# going to the fallback and nothing anywhere saying why.
SELBAD=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-sel-bad","nameAr":"خطأ","nameEn":"Bad","isDefault":false}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$(curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$SELBAD/graph" -d '{"selectionCondition":{"all":[{"field":"payer_typo","op":"eq","value":"insurance"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}' | $PY -c "
import sys,json;print(1 if 'unknown field' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a selection condition on a field that does not exist is refused at save"
ok 1 "$(curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$SELBAD/graph" -d '{"selectionCondition":{"any":true},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"}]}' | $PY -c "
import sys,json;print(1 if 'selectionCondition' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "and so is a shape that is not a condition at all, which would have matched EVERY record"

ok t "$(psql "select prosrc like '%NEW.selection_priority%' from pg_proc where proname='workflow_flow_freeze'")" \
  "the freeze covers the routing order too — it cannot be reordered under records already running"


# ── the screen can say all of this in words ──────────────────────────────────────────────────────
# The list is what an admin reads to answer "which flow gets this order", and the three states of
# selection_condition are not something a browser should be trusted to tell apart: null and {} look
# almost identical and mean opposite things.
ok "any record no other flow claims" "$(curl -s "${AR[@]}" "$B/api/admin/workflows" | $PY -c "
import sys,json
print(next(f['selection_summary'] for f in json.load(sys.stdin)['flows'] if f['flow_key']=='smoke-sel-def'))")" \
  "the list says the fallback takes any record no other flow claims"
ok "Delivery or pickup is pickup" "$(curl -s "${AR[@]}" "$B/api/admin/workflows" | $PY -c "
import sys,json
print(next(f['selection_summary'] for f in json.load(sys.stdin)['flows'] if f['flow_key']=='smoke-sel-pickup'))")" \
  "and renders a real condition as the sentence an admin wrote, not as jsonb"
ok "nothing — no routing set, so it is never chosen" "$(curl -s "${AR[@]}" "$B/api/admin/workflows" | $PY -c "
import sys,json
print(next(f['selection_summary'] for f in json.load(sys.stdin)['flows'] if f['flow_key']=='smoke-sel-bad'))")" \
  "and does not say 'always' for the flow that is never chosen at all"

# ── the fallback survives its own versioning ─────────────────────────────────────────────────────
# LAST in this block because it replaces smoke-sel-def with a v2, which every check above reads by
# key. newVersion() forces is_default=false on the clone — the predecessor is still live and two
# active defaults is a unique-index violation — so the flag has to be handed over at activation. It
# was not: publishing v2 of the workspace's own flow left the workspace with NO default at all, so
# every record raised afterwards matched nothing, bound to nothing and moved unchecked. Enforcement
# switched itself off on the one path the product offers for changing a live flow.
SELV2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$SELDEF/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok f "$(psql "select is_default from workflow_flows where id='$SELV2'")" \
  "a new version is cloned as NOT the fallback, because its predecessor still is"
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$SELV2/activate"
ok "active|true" "$(psql "select status||'|'||is_default from workflow_flows where id='$SELV2'")" \
  "and takes the fallback over when it goes live, instead of leaving the workspace without one"
ok "retired|false" "$(psql "select status||'|'||is_default from workflow_flows where id='$SELDEF'")" \
  "while the version it replaced keeps neither the flag nor the traffic"
ok "$SELV2" "$(psql "select flow_id from workflow_record_state where entity_type='rfq' and entity_id='$(selrfq SEL-V2 delivery regular)'")" \
  "so a record that matches nothing still lands on the fallback after a republish"

selclean

# ── A STEP HANDS THE RECORD TO ANOTHER FLOW, AND TAKES IT BACK (0066) ───────────────────────────
#
# 0065 decided which flow a record STARTS in. This is where it goes MID-LIFE: a request reaches the
# step where the insurer takes over, crosses into the insurance flow, is worked there by insurance's
# own people under insurance's own rules, and comes back at whichever status the outcome calls for.
#
# THE CROSSING IS AN ARROW, and everything below leans on that: it is drawn on the canvas at both
# ends, refused at activation if either end is missing, refused again at run time if either end has
# gone since, and frozen by the database while records are executing it. There is no frame table, no
# depth cap and no stored return address that MUST resolve — each of those fails by leaving a record
# somewhere nobody drew.
#
# The arrangement below is the owner's own, driven with moves the product already makes:
#   HOME   (smoke-x-home, the fallback)      new_rfq → priced   ← the border out
#                                            new_rfq → cancelled, priced → cancelled
#   INSURE (smoke-x-ins, entry_mode=handoff) priced  → cancelled ← the border home
# Crossing out is POST …/winning-quote. The way home is an approved cancellation exception, which
# moves ONLY the rfq_item — and that is what lets these tests damage a flow version the LINE is
# bound to without also breaking its request header.
xclean(){
  wfclean
  psql "delete from workflow_auto_fired; delete from workflow_action_runs; delete from status_logs;
        delete from workflow_exceptions;
        delete from approval_actions; delete from approval_requests;
        delete from approval_levels; delete from approval_policies;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'XF-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'XF-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'XF-%');
        delete from workflow_record_state where entity_id in (select id from rfq_items where rfq_id in (select id from rfqs where plate_number like 'XF-%'));
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'XF-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from workflow_record_state where entity_id in (select id from rfqs where plate_number like 'XF-%');
        delete from rfqs where plate_number like 'XF-%'" > /dev/null
}
# A flow, created and left a DRAFT: refusing to activate is half of what this feature does, so
# activation is always asserted rather than assumed.
xdraft(){ # $1 = key suffix, $2 = graph json, $3 = isDefault, $4 = entryMode -> flow id
  local F
  F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d "$(printf '{"flowKey":"smoke-x-%s","nameAr":"مسار","nameEn":"X %s","isDefault":%s,"entryMode":"%s"}' \
          "$1" "$1" "${3:-false}" "${4:-selected}")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "$2"
  echo "$F"
}
xitem(){ psql "select i.id from rfq_items i join rfqs r on r.id=i.rfq_id where r.plate_number='$1' limit 1"; }
xrfq(){ psql "select id from rfqs where plate_number='$1' limit 1"; }
# "which flow governs this record, and where did it come from" — the two columns the whole feature
# turns on, read as ONE string so a half-right answer cannot pass.
xwhere(){ psql "select coalesce(f.flow_key,'-')||'/v'||coalesce(f.version::text,'-')||'|'||coalesce(o.flow_key,'home')
                from workflow_record_state rs
                left join workflow_flows f on f.id=rs.flow_id
                left join workflow_flows o on o.id=rs.origin_flow_id
                where rs.entity_id='$1'"; }
xstatus(){ psql "select s.code from rfq_items i join item_statuses s on s.id=i.status_id where i.id='$1'"; }
# Raise the way home. Kept apart from taking it, because several checks below have to ATTEMPT the
# same return more than once: a refused resolve rolls back and leaves the exception open, so the
# same request can simply be decided again once the thing blocking it is gone.
xraise(){ curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions" \
    -d "$(printf '{"entityType":"rfq_item","entityId":"%s","kind":"cancellation","reason":"the insurer refused the claim"}' "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))"; }
# DECIDED BY THE SUB-FLOW'S OWN PEOPLE, and that is not a detail of the test — it is the feature.
# The sub-flow's `priced` step is owned by branch_manager, so the guard's step-owner check refuses
# the return to anybody else: an insurance claim is worked by whoever insurance says works it, not
# by whoever happened to own the same status back home. Raised by the admin and decided by the
# manager, so segregation of duties is satisfied the same way it is everywhere else.
xdecide(){ curl -s -H "Authorization: Bearer $XMBTOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' \
    -X POST "$B/api/workflow/exceptions/$1/resolve" -d '{"decision":"approve"}'; }
xhome(){ # $1 = rfq_item id -> echoes the resolve response
  local eid; eid=$(xraise "$1")
  [ -z "$eid" ] && { echo '{"message":"the exception could not be raised"}'; return; }
  xdecide "$eid"
}

# The branch manager: the person the sub-flow's own step belongs to, and therefore the only one who
# can take a record out of it. Read before the fixture is built, because every return below is theirs.
XMBTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"multi@qparts.local","password":"multi1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")

xclean
XHOME_G='{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","x":340,"y":100,"ownerRoles":["service_advisor"]},
          {"status":"cancelled","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Pick winner"},
                {"from":"new_rfq","to":"cancelled","labelEn":"Cancel"},
                {"from":"priced","to":"cancelled","labelEn":"Cancel"}]}'
XHOME1=$(xdraft home "$XHOME_G" true)
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$XHOME1/activate"
ok active "$(psql "select status from workflow_flows where id='$XHOME1'")" \
  "the home flow is live before anything crosses into anything"

# THE SUB-FLOW. Its `priced` step is owned by a DIFFERENT role from the home flow's, which is how
# "its own people take over" is proved below rather than merely claimed.
XINS=$(xdraft ins '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100,"ownerRoles":["branch_manager"]},
          {"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"cancelled","labelEn":"Claim refused","toFlowKey":"smoke-x-home"}]}' false handoff)
XINSACT=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XINS/activate")
ok active "$(echo "$XINSACT" | $PY -c "import sys,json;print(json.load(sys.stdin).get('status',''))")" \
  "a HANDOFF flow activates with no selection condition — records reach it by being handed one"
ok handoff "$(psql "select entry_mode from workflow_flows where id='$XINS'")" \
  "and says so in a column, rather than storing '{}' — which this codebase defines as 'matches EVERY record'"
# NOT WARNED ABOUT, and that is the correction. 'cancelled' here is where the RETURN arrow lands —
# the record leaves at the moment of that move and never occupies the step inside this flow. The
# warning counted only the steps a crossing departs FROM, so it fired on the correctly drawn
# hand-back arrow and told the admin to draw the very thing they had just drawn.
ok 0 "$(echo "$XINSACT" | $PY -c "
import sys,json;print(1 if any('stay in this workflow for good' in w for w in json.load(sys.stdin).get('warnings',[])) else 0)")" \
  "a terminal that is where the hand-back arrow LANDS is not called a dead end"

# The warning still has to fire where it means something: a terminal with no crossing at either end
# really is somewhere records stop for good, and a sub-flow whose way home was never drawn looks
# exactly like one that ends records on purpose. Said, not enforced — intent is not a property of a
# graph, so the admin decides.
XDEAD=$(xdraft deadend '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},
          {"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"cancelled","labelEn":"Ends here"}]}' false handoff)
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XDEAD/activate" | $PY -c "
import sys,json;print(1 if any('stay in this workflow for good' in w for w in json.load(sys.stdin).get('warnings',[])) else 0)")" \
  "…while a terminal with no crossing at either end still is — and it activates anyway"

# The border is added in a NEW VERSION of the home flow, the only supported way to change a live
# one. The order this has to happen in is itself the point: the destination must already be
# published, or activation refuses the border.
XHOME_B='{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","x":340,"y":100,"ownerRoles":["service_advisor"]},
          {"status":"cancelled","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Send to the insurer","toFlowKey":"smoke-x-ins"},
                {"from":"new_rfq","to":"cancelled","labelEn":"Cancel"},
                {"from":"priced","to":"cancelled","labelEn":"Cancel"}]}'
xrepublish(){ # $1 = the active home flow id -> echoes the new active id, border and all
  local N
  N=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$1/new-version" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$N/graph" -d "$XHOME_B"
  curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$N/activate"
  echo "$N"
}
XHOME2=$(xrepublish "$XHOME1")
ok active "$(psql "select status from workflow_flows where id='$XHOME2'")" \
  "the border activates once both ends exist — the destination flow, and its step for the landing status"
ok smoke-x-ins "$(psql "select t.to_flow_key from workflow_transitions t join workflow_steps s on s.id=t.to_step_id
                        join item_statuses i on i.id=s.item_status_id
                        where t.flow_id='$XHOME2' and i.code='priced'")" \
  "and the arrow really carries its destination through save, clone and republish"

# ── THE CROSSING OUT ────────────────────────────────────────────────────────────────────────────
pick_winner XF-OUT > /dev/null
XIT1=$(xitem XF-OUT)
ok priced "$(xstatus "$XIT1")" "the record takes the border arrow and the status moves, as any other move would"
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT1")" \
  "and it is now governed by the sub-flow, remembering the flow it left"
ok smoke-x-ins "$(psql "select f.flow_key from status_logs l join workflow_flows f on f.id=l.flow_id
                        join item_statuses t on t.id=l.to_status_id
                        where l.entity_id='$XIT1' and t.code='priced'")" \
  "the history records WHICH RULEBOOK judged the move, which no later republish can rewrite"
ok 1 "$(psql "select count(*) from status_logs l join item_statuses t on t.id=l.to_status_id
              where l.entity_id='$XIT1' and t.code='priced'")" \
  "a crossing is ONE move: one log row, not a phantom second one that reads as going backwards"
ok "multi@qparts.local" "$(psql "select coalesce((select email from users where id=rs.assignee_user_id),'POOL')
                                 from workflow_record_state rs where rs.entity_id='$XIT1'")" \
  "custody lands on the SUB-FLOW's owner, not on whoever owns the same status back home"
ok "smoke-x-home/v2|home" "$(xwhere "$(xrfq XF-OUT)")" \
  "while the request the line belongs to stays exactly where it was — only the line crossed"

# MY WORK has to say the record is a visitor, or a manager watches work leave their pool with no
# explanation and a clerk watches it arrive with no idea whose it is.
ok "X ins|X home" "$(curl -s -H "Authorization: Bearer $XMBTOK" -H 'X-Tenant: riyadh' "$B/api/admin/workflows/my-work" | $PY -c "
import sys, json
d = json.load(sys.stdin)
r = next((x for x in d['mine'] + d['pool'] if x['entity_id'] == '$XIT1'), None)
print((r['flow'] + '|' + (r['origin_flow'] or '-')) if r else 'missing')")" \
  "My Work names the workflow holding it AND the one it came from — 'Insurance, from Standard'"

# ── THE CROSSING HOME ───────────────────────────────────────────────────────────────────────────
ok 0 "$(blocked "$(xhome "$XIT1")")" "the sub-flow hands the record back along an arrow somebody drew"
ok cancelled "$(xstatus "$XIT1")" "…landing on the status that outcome calls for"
ok "smoke-x-home/v2|home" "$(xwhere "$XIT1")" \
  "…bound to the home flow again, with nothing left saying it is still away"
ok smoke-x-home "$(psql "select f.flow_key from status_logs l join workflow_flows f on f.id=l.flow_id
                         join item_statuses t on t.id=l.to_status_id
                         where l.entity_id='$XIT1' and t.code='cancelled'")" \
  "and the return is recorded under the flow that judged it, which is the one it came home to"

# ── THE WAY HOME IS THE VERSION IT LEFT ─────────────────────────────────────────────────────────
# A record does not change rulebooks mid-flight because somebody republished while it was away.
pick_winner XF-PIN > /dev/null
XIT2=$(xitem XF-PIN)
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT2")" "a second record crosses out while home is on v2"
XHOME3=$(xrepublish "$XHOME2")
ok active "$(psql "select status from workflow_flows where id='$XHOME3'")" "home is republished while it is away"
ok 0 "$(blocked "$(xhome "$XIT2")")" "…and it still comes home"
ok "$XHOME2" "$(psql "select flow_id from workflow_record_state where entity_id='$XIT2'")" \
  "to the version it LEFT, not to the one published while it was gone"

# ── AND WHEN THAT VERSION CANNOT TAKE IT, THE LIVE ONE DOES ─────────────────────────────────────
# The version pin is a HINT, never a pointer. Null, stale or unusable, the crossing still completes
# against the live graph — which is exactly what a load-bearing return address cannot promise.
pick_winner XF-FALLBACK > /dev/null
XIT3=$(xitem XF-FALLBACK)
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT3")" "a third record crosses out, bound home to v3"
XHOME4=$(xrepublish "$XHOME3")
# The damage is done behind the API deliberately: the product refuses to publish a version that
# drops a status something crosses back into (asserted further down), so the only way to reach this
# state is the one the run-time fallback exists for — a graph changed by something that is not the
# product.
psql "alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
      delete from workflow_transitions t using workflow_steps s, item_statuses i
        where t.flow_id='$XHOME3' and s.id in (t.from_step_id, t.to_step_id)
          and i.id = s.item_status_id and i.code='cancelled';
      delete from workflow_steps s using item_statuses i
        where s.flow_id='$XHOME3' and i.id = s.item_status_id and i.code='cancelled';
      alter table workflow_steps enable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null
ok 0 "$(blocked "$(xhome "$XIT3")")" "with the version it left no longer able to receive it, the return still happens"
ok "$XHOME4" "$(psql "select flow_id from workflow_record_state where entity_id='$XIT3'")" \
  "…against the LIVE version instead: the hint fails soft, it does not strand the record"
ok cancelled "$(xstatus "$XIT3")" "…and the record is home, which is the only outcome the shop cares about"

# ── BREAK GLASS ─────────────────────────────────────────────────────────────────────────────────
# For the one case the ordinary return cannot cover: the arrow home exists, and the people allowed
# to take it cannot. It performs EXACTLY the ordinary return — same arrow, same guard, one log row —
# so it cannot produce a state an ordinary return could not.
pick_winner XF-GLASS > /dev/null
XIT4=$(xitem XF-GLASS)
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT4")" "a fourth record is away in the sub-flow"
XGLASS=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/records/rfq_item/$XIT4/return" -d '{}')
ok cancelled "$(echo "$XGLASS" | $PY -c "import sys,json;print(json.load(sys.stdin).get('at',''))")" \
  "a super admin can bring it home along the arrow the author drew, without inventing a destination"
ok "smoke-x-home/v4|home" "$(xwhere "$XIT4")" "…producing the state an ordinary return produces, and no other"
ok "admin@qparts.local" "$(psql "select u.email from status_logs l join users u on u.id=l.changed_by
                                 join item_statuses t on t.id=l.to_status_id
                                 where l.entity_id='$XIT4' and t.code='cancelled'")" \
  "…and the history says a PERSON did it, which is the only thing that makes a break-glass lever auditable"
ok 1 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/records/rfq_item/$XIT4/return" -d '{}')")" \
  "while a record that is not away has nothing to be brought back from"

# Parked here, away in the sub-flow's FIRST version, for the run-time refusal at the end of this
# block: it has to predate the version published below, whose return arrow needs a signature.
pick_winner XF-NOSTEP > /dev/null
XIT7=$(xitem XF-NOSTEP)
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT7")" "a fifth record is parked in the sub-flow for later"
# And a sixth, for the invariant the parent asked to be proved hardest: the SUB-FLOW is republished
# below while this record is inside it, and it must still have a way back.
pick_winner XF-SUBPUB > /dev/null
XIT9=$(xitem XF-SUBPUB)
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT9")" "…and a sixth, which will be inside it when it is republished"

# ── ROUTING IS KEYED BY STATUS CODE, ACROSS EVERY ACTIVE FLOW ───────────────────────────────────
# A gap no design caught, captured here as a test rather than discovered in production:
# queuePredicate builds routedAnywhere/routedHere over EVERY active flow with no per-record filter,
# so a sub-flow's page placements apply to records that never crossed. The safety rule keeps it
# harmless — routed nowhere means shows everywhere, so the worst case is appearing on MORE pages,
# never fewer — but whoever authors the first sub-flow has to be told, and this is where.
psql "alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      update workflow_steps set pages='[{\"page\":\"orders\",\"mode\":\"action\"}]'::jsonb
       where flow_id='$XINS' and item_status_id=(select id from item_statuses where code='cancelled');
      alter table workflow_steps enable trigger trg_workflow_steps_freeze" > /dev/null
xseen(){ curl -s "${AR[@]}" "$B/api/rfqs?queue=$1" | $PY -c "
import sys,json;print(sum(1 for r in json.load(sys.stdin)['rfqs'] if r.get('plate_number')=='$2'))"; }
XR6=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"XF-HOMEBODY","items":[{"partNumber":"GP","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
XE6=$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions" \
  -d "$(printf '{"entityType":"rfq","entityId":"%s","kind":"cancellation","reason":"the workshop changed its mind"}' "$XR6")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${MR[@]}" -X POST "$B/api/workflow/exceptions/$XE6/resolve" -d '{"decision":"approve"}'
ok "smoke-x-home/v4|home" "$(xwhere "$XR6")" "a request that NEVER crossed is cancelled on the home flow"
ok 1 "$(xseen orders XF-HOMEBODY)" \
  "and the SUB-FLOW's placement routes it — authoring a sub-flow changes routing for records that stay home"
ok 0 "$(xseen rfqs XF-HOMEBODY)" \
  "…which is a real surprise, and the reason it is asserted here rather than found in a queue that emptied"
ok 1 "$(xseen rfqs XF-OUT)" "a status routed nowhere still appears on every page — the safety rule holds"
ok 1 "$(xseen orders XF-OUT)" "…including the page the sub-flow routed something else to"

# ── BOTH ENDS OF A BORDER ARE CHECKED WHEN IT IS PUBLISHED ──────────────────────────────────────
# The run-time refusal is safe, but the person who meets it is a clerk with a live order, and the
# person who could have prevented it was an admin pressing Activate.
XFWD=$(xdraft forward '{"selectionCondition":{"all":[{"field":"order_type","op":"eq","value":"bulk"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Hand over","toFlowKey":"smoke-x-nowhere"}]}')
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XFWD/activate" | $PY -c "
import sys,json;print(1 if 'no such workflow' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "FORWARD: a border naming a workflow that does not exist is refused — that is a typo, not a sequence"
ok draft "$(psql "select status from workflow_flows where id='$XFWD'")" "…and the flow stays a draft rather than half-activating"

# A DRAFT TARGET IS A WARNING, NOT A REFUSAL, AND THAT DISTINCTION IS THE WHOLE FEATURE.
# Requiring the target to be ACTIVE deadlocked the only arrangement anybody actually wants: an order
# flow and the flow it detours through both name each other, so A would not publish until B was live
# and B would not publish until A was. There was no order in which the pair could go up, which meant
# the round trip could not be configured at all. Naming a flow that does NOT EXIST is still refused —
# no amount of publishing resolves a typo.
# A returns to whatever step B hands back to, so A must contain it — that is a SEPARATE check and it
# still bites; the point here is only that neither flow has to be live before the other.
XPAIRA=$(xdraft pair-a '{"selectionCondition":{"all":[{"field":"order_type","op":"eq","value":"bulk"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Out","toFlowKey":"smoke-x-pair-b"},
   {"from":"priced","to":"confirmed","labelEn":"Finish"}]}')
# entryMode is xdraft's FOURTH argument, not a graph field — a sub-flow created without it is an
# ordinary 'selected' flow with no routing, and activation refuses it for a reason that has nothing
# to do with what this section is testing.
XPAIRB=$(xdraft pair-b '{"selectionCondition":null,
 "steps":[{"status":"priced","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"confirmed","labelEn":"Back","toFlowKey":"smoke-x-pair-a"}]}' false handoff)
XPAIRAR=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XPAIRA/activate")
ok active "$(echo "$XPAIRAR" | $PY -c "
import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "one of a mutually-referencing pair publishes while the other is still a draft"
ok 1 "$(echo "$XPAIRAR" | $PY -c "
import sys, json
# the warning has to have been SAID. A silent allow is how an admin ends up with half a pair live
# and no idea the other half is what is holding their records.
print(1 if any('still a draft' in w for w in (json.load(sys.stdin).get('warnings') or [])) else 0)")" \
  "…having been told the other half is not published yet"
ok active "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XPAIRB/activate" | $PY -c "
import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "and the second then publishes too — the pair is up, which was impossible before"

XREV=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XHOME4/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$XREV/graph" \
  -d '{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Send to the insurer","toFlowKey":"smoke-x-ins"}]}'
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XREV/activate" | $PY -c "
import sys,json;print(1 if 'hands records back to this one' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "REVERSE: republishing the parent without the status the sub-flow returns to is refused"
ok draft "$(psql "select status from workflow_flows where id='$XREV'")" \
  "…so a record sitting inside the sub-flow cannot have its way home deleted from underneath it"
curl -s -o /dev/null "${AR[@]}" -X DELETE "$B/api/admin/workflows/$XREV"

# ── AND A STEP THAT CAN NEVER REACH AN ENDING ───────────────────────────────────────────────────
# Latent before this feature and dangerous because of it. A terminal exists, every non-terminal has
# an outgoing edge, and every step is reachable from entry — all three older checks pass, and a
# record that lands in the cycle orbits it for ever with nothing anywhere reporting it.
XCYC=$(xdraft cycle '{"selectionCondition":{"all":[{"field":"order_type","op":"eq","value":"bulk"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","x":600,"y":100},{"status":"cancelled","isTerminal":true,"x":860,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"A"},{"from":"priced","to":"confirmed","labelEn":"B"},
                {"from":"confirmed","to":"priced","labelEn":"C"},{"from":"new_rfq","to":"cancelled","labelEn":"D"}]}')
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XCYC/activate" | $PY -c "
import sys,json;print(1 if 'can never reach a terminal step' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a step with no path to any ending is refused — 'a record that gets there would never come back'"

# ── AND THE FLOW ON THE OTHER SIDE CANNOT SIMPLY BE RETIRED ─────────────────────────────────────
# retire() was a bare UPDATE with no checks at all, which was defensible while a flow stood alone.
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XINS/retire" | $PY -c "
import sys,json;print(1 if 'hands records to this' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "retiring a flow an ACTIVE flow crosses into is refused — a drawn border must not become a dead end"
ok active "$(psql "select status from workflow_flows where id='$XINS'")" "…and it stays live"

# ── THE FREEZE ──────────────────────────────────────────────────────────────────────────────────
# An admin able to re-aim a live border would send orders already crossing it into a different
# rulebook, with no version change and nothing in the audit trail.
ok 1 "$(psql "update workflow_transitions set to_flow_key='smoke-x-home'
              where flow_id='$XHOME4' and to_flow_key='smoke-x-ins'" 2>&1 \
        | /usr/bin/grep -c "publish a new version")" \
  "re-aiming a border on an ACTIVE flow is refused by the database, not merely by the API"
ok 12 "$(psql "select count(*) from (select unnest(array['from_step_id','to_step_id','condition','requires_approval',
                'allowed_roles','priority','handoff','gates','auto_advance','auto_once','actions','to_flow_key']) c) x
              where (select prosrc from pg_proc where proname='workflow_child_freeze') like '%NEW.'||x.c||'%'
                and (select prosrc from pg_proc where proname='workflow_child_freeze') like '%OLD.'||x.c||'%'")" \
  "and the whole transition tuple survived the rewrite — CREATE OR REPLACE replaces the entire body"
ok 6 "$(psql "select count(*) from (select unnest(array['item_status_id','vendor_status_id','status_domain',
                'is_entry','is_terminal','owner_roles']) c) x
              where (select prosrc from pg_proc where proname='workflow_child_freeze') like '%NEW.'||x.c||'%'")" \
  "…including the six columns of the STEP tuple, which this migration had no business changing"

# ── A HANDOFF CANNOT PING-PONG FOR EVER ─────────────────────────────────────────────────────────
# The dangerous case is the one nothing could see: a crossing that changes NO status, which no
# status_logs write, no auto_once and no MAX_AUTO_DEPTH would ever notice. It is unrepresentable
# here, and not by a new instrument — a border is an arrow, and an arrow cannot start and end on the
# same step, so every crossing moves the record. A status-CHANGING loop across the border is still
# drawable and is bounded by exactly what bounds a same-flow 2-cycle today.
ok 1 "$(psql "select count(*) from pg_constraint where conname='workflow_transitions_no_self_loop'")" \
  "an arrow cannot start and end on the same step, so a crossing always changes status"
XSELF=$(xdraft self '{"selectionCondition":{"all":[{"field":"order_type","op":"eq","value":"bulk"}]},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Nowhere"}]}')
ok 1 "$(curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$XSELF/graph" -d '{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Nowhere","toFlowKey":"smoke-x-self"}]}' | $PY -c "
import sys,json;print(1 if 'which is this flow' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "and a border aimed at its OWN flow is refused at save — a move that claims to be a handoff and is not"
ok 0 "$(psql "select count(*) from workflow_transitions where flow_id='$XSELF' and to_flow_key is not null")" \
  "…and the refused save left nothing behind: PUT graph is a full replace, so a rejected one applies none of it"
curl -s -o /dev/null "${AR[@]}" -X DELETE "$B/api/admin/workflows/$XSELF"

# ── THE COLLISION: `transition_key` HAS NO FLOW IN IT ───────────────────────────────────────────
# `priced>cancelled` is an arrow in BOTH flows — the home flow's ordinary cancel and the sub-flow's
# way back. That string keys the open-request index, the granted lookup and workflow_auto_fired, so
# before 0066 one record executing two flows could spend a signature given for one flow's arrow on
# the other's. An approval crossing a governance boundary is a correctness bug, not a nuisance.
MGRX=$(psql "select id from users where email='manager@qparts.local'")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/approvals/policies" \
  -d "$(printf '{"name":"Crossing sign-off","entityType":"rfq_item","levels":[{"approverUserId":"%s"}]}' "$MGRX")"
XINS2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XINS/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$XINS2/graph" \
  -d '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100,"ownerRoles":["branch_manager"]},
          {"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"cancelled","labelEn":"Claim refused","toFlowKey":"smoke-x-home","requiresApproval":true}]}'
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$XINS2/activate"
ok active "$(psql "select status from workflow_flows where id='$XINS2'")" "the sub-flow now needs a signature to hand a record back"

# A RECORD IS NEVER STRANDED BY A REPUBLISH OF THE FLOW IT IS INSIDE. XIT9 has been sitting in v1
# the whole time. It executes v1 — the version it entered — so the padlock added in v2 is not its
# rule, and the way home it was handed is still the way home it has.
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT9")" "a record inside the sub-flow stays on the version it entered"
ok 0 "$(blocked "$(xhome "$XIT9")")" "…and comes home under THAT version's rules, not the ones published around it"
ok "smoke-x-home/v4|home" "$(xwhere "$XIT9")" "…arriving home exactly as it would have before the republish"

pick_winner XF-COLLIDE > /dev/null
XIT5=$(xitem XF-COLLIDE)
XE5=$(xraise "$XIT5")
ok 1 "$(echo "$(xdecide "$XE5")" | $PY -c "
import sys,json;print(1 if json.load(sys.stdin).get('needsApproval') else 0)")" \
  "the way home is padlocked, so the return waits for a signature like any other guarded move"
# THE ROW IS PLACED, NOT EARNED, and the reason is worth stating: the product's own approval path
# performs the move in the very transaction that grants it, so a granted-and-unspent signature is
# not reachable through the API. The predicate the migration changed therefore has to be driven
# directly — the row is what the database would hold if the record had been signed off at home and
# then crossed, and everything after it is the real guard deciding what to do with it.
XHOMEACT=$(psql "select id from workflow_flows where flow_key='smoke-x-home' and status='active'")
psql "insert into approval_requests (tenant_id, environment, policy_id, entity_type, entity_id,
        requested_by, current_level, overall_status, transition_key, flow_id)
      select '$RIYADH','live',p.id,'rfq_item','$XIT5'::uuid,'$MGRX'::uuid,1,'approved','priced>cancelled','$XHOMEACT'
        from approval_policies p where p.entity_type='rfq_item' and p.is_active limit 1" > /dev/null
ok 1 "$(echo "$(xdecide "$XE5")" | $PY -c "
import sys,json;print(1 if json.load(sys.stdin).get('needsApproval') else 0)")" \
  "a signature given under the HOME flow cannot be spent on the sub-flow's identically-named arrow"
ok priced "$(xstatus "$XIT5")" "…and the record does not move on the strength of it"
psql "update approval_requests set flow_id='$XINS2'
      where entity_id='$XIT5' and transition_key='priced>cancelled' and overall_status='approved'" > /dev/null
ok 0 "$(blocked "$(xdecide "$XE5")")" "while the same signature, given for THIS flow's arrow, lets it home at once"
ok "smoke-x-home/v4|home" "$(xwhere "$XIT5")" "…which is the ordinary return, reached the ordinary way"
ok 1 "$(psql "select count(*) from approval_requests where entity_id='$XIT5' and consumed_at is not null")" \
  "…and the grant is spent, so it cannot authorise the same move twice"

# The same collision, in the ledger that stops an automatic move re-firing. Same reasoning about the
# placed row: `auto_once` writes one row per (record, arrow) and there is no API that writes another.
psql "insert into workflow_auto_fired (tenant_id, environment, entity_type, entity_id, transition_key, flow_id)
      values ('$RIYADH','live','rfq_item','$XIT5'::uuid,'priced>cancelled','$XHOMEACT'),
             ('$RIYADH','live','rfq_item','$XIT5'::uuid,'legacy>row',null)" > /dev/null
ok 0 "$(psql "select count(*) from workflow_auto_fired
              where entity_id='$XIT5' and transition_key='priced>cancelled'
                and (flow_id='$XINS2' or flow_id is null)")" \
  "an auto_once that fired under one flow does not suppress the identically-named arrow of the other"
ok 1 "$(psql "select count(*) from workflow_auto_fired
              where entity_id='$XIT5' and transition_key='priced>cancelled'
                and (flow_id='$XHOMEACT' or flow_id is null)")" \
  "…while still suppressing its own, which is the whole job of the ledger"
ok 1 "$(psql "select count(*) from workflow_auto_fired
              where entity_id='$XIT5' and transition_key='legacy>row' and (flow_id='$XINS2' or flow_id is null)")" \
  "and a row written before this migration suppresses under every flow, so no historical move re-fires"
ok "true|true" "$(psql "select (i1.indexdef like '%flow_id%')::text||'|'||(i2.indexdef like '%flow_id%')::text
                  from pg_indexes i1, pg_indexes i2
                  where i1.indexname='workflow_auto_fired_uq' and i2.indexname='approval_requests_open_uq'")" \
  "both uniqueness keys really carry the flow, rather than the read predicate compensating for them"

# ── THE RUN-TIME REFUSALS, AND WHAT THEY LEAVE BEHIND ───────────────────────────────────────────
# Both are checked after every rule that can still say no and before anything at all is written, so
# the record does not move, stays on a flow that still governs it, and keeps every other arrow.
psql "update workflow_flows set status='retired' where flow_key='smoke-x-ins' and status='active'" > /dev/null
XNOFLOW=$(pick_winner XF-GONE)
ok 1 "$(echo "$XNOFLOW" | $PY -c "
import sys,json;print(1 if 'no active version' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a border whose destination has since been retired refuses the move in words a clerk can act on"
XIT8=$(xitem XF-GONE)
ok new_rfq "$(xstatus "$XIT8")" "…the record does not move"
ok "smoke-x-home/v4|home" "$(xwhere "$XIT8")" "…it is still on the flow that governs it"
ok 0 "$(blocked "$(xhome "$XIT8")")" \
  "…and every OTHER arrow out of where it stands still works, which is the whole stranding story"

# Now the other half: the destination flow is there, and no longer has the step the arrow lands on.
# XIT7 is still away in the sub-flow's FIRST version, whose way back needs no signature.
psql "alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
      delete from workflow_transitions t using workflow_steps s, item_statuses i
        where t.flow_id='$XHOMEACT' and s.id in (t.from_step_id, t.to_step_id)
          and i.id = s.item_status_id and i.code='cancelled';
      delete from workflow_steps s using item_statuses i
        where s.flow_id='$XHOMEACT' and i.id = s.item_status_id and i.code='cancelled';
      alter table workflow_steps enable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null
ok 1 "$(echo "$(xhome "$XIT7")" | $PY -c "
import sys,json;print(1 if 'has no step for' in str(json.load(sys.stdin).get('message','')) else 0)")" \
  "a record handed somewhere with nowhere to stand is refused, rather than bound to a step that is not there"
ok priced "$(xstatus "$XIT7")" "…and it is exactly where it was"
ok "smoke-x-ins/v1|smoke-x-home" "$(xwhere "$XIT7")" \
  "…still inside the sub-flow that governs it, still remembering the way home for when it is drawn again"

# ── A REMOVED RECORD IS NOT "AWAY" ──────────────────────────────────────────────────────────────
# 0062's audit trigger deliberately leaves workflow_record_state alone, because a deleted record's
# history must still resolve. That was harmless while the row said only "which flow is this
# executing"; with origin_flow_id it also says "this one is away in a sub-flow and owes a return",
# which a record that no longer exists does not.
psql "update rfq_items set winning_vendor_quote_item_id=null where id='$XIT7';
      delete from workflow_exceptions where entity_id='$XIT7';
      delete from rfq_vendor_items where rfq_item_id='$XIT7';
      delete from rfq_items where id='$XIT7'" > /dev/null
ok "smoke-x-ins/v1|home" "$(xwhere "$XIT7")" \
  "deleting a record that was away clears the origin — the row stops claiming a return it can never make"
ok 1 "$(psql "select count(*) from workflow_record_removals where entity_id='$XIT7'")" \
  "…while the removal itself is still recorded, which is what 0062 exists for"

xclean
psql "delete from approval_actions; delete from approval_requests;
      delete from approval_levels; delete from approval_policies" > /dev/null

# ── ROUTING AN ADMIN CAN ACTUALLY SET (QNEW-64) ─────────────────────────────────────────────────
#
# Everything above this line was configured with curl, and that is not a convenience of the test —
# it is how it HAD to be configured. `isDefault` and `entryMode` were settable only at creation, and
# `selectionCondition` only as a field of the whole-graph save the canvas does not send. So a second
# workflow made in the product carried no routing at all, Activate refused exactly that flow, and
# the three things its message told the admin to do were three things the product offered no way to
# do. Everything underneath was unreachable behind that one gap: no second flow could go live, so
# the canvas never had another flow to offer, so the crossing picker never rendered, so `to_flow_key`
# could only ever be set by hand.
#
# These drive the endpoint the Routing tab calls, in the order a person meets it.
rtclean(){
  wfclean
  psql "delete from workflow_exceptions; delete from status_logs;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in (select id from rfqs where plate_number like 'RT-%');
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'RT-%'));
        delete from rfq_vendors where rfq_id in (select id from rfqs where plate_number like 'RT-%');
        delete from workflow_record_state where entity_id in (select id from rfq_items where rfq_id in (select id from rfqs where plate_number like 'RT-%'));
        delete from rfq_items where rfq_id in (select id from rfqs where plate_number like 'RT-%');
        delete from notification_log where template='vendor_rfq_invite';
        delete from workflow_record_state where entity_id in (select id from rfqs where plate_number like 'RT-%');
        delete from rfqs where plate_number like 'RT-%'" > /dev/null
}
# EXACTLY the body Workflows.tsx posts when somebody presses "New workflow" beside an existing one:
# a key, two names, and isDefault false because the workspace already has a fallback. No routing of
# any kind, because that form has never had anywhere to put one.
rtnew(){ # $1 = key suffix, $2 = graph json -> flow id, graph saved, still a draft
  local F
  F=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
    -d "$(printf '{"flowKey":"smoke-%s","nameAr":"مسار","nameEn":"RT %s","isDefault":false}' "$1" "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/graph" -d "$2"
  echo "$F"
}
rtroute(){ curl -s "${AR[@]}" -X PUT "$B/api/admin/workflows/$1/routing" -d "$2"; }
rtactivate(){ curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$1/activate"; }
# Is this refusal the one we meant? Needles are matched against `message`, so a check cannot pass on
# a DIFFERENT refusal that happens to arrive with the right status code.
rthas(){ echo "$2" | $PY -c "
import sys, json
print(1 if '$1' in str(json.load(sys.stdin).get('message','')) else 0)"; }
# What the Workflows screen reads for one flow. Deliberately through the LIST endpoint rather than
# the database: the defect being fixed was that the screen could not see a column, not that the
# column was wrong.
rtlist(){ curl -s "${AR[@]}" "$B/api/admin/workflows" | $PY -c "
import sys, json
print(next((str(f.get('$2','MISSING')) for f in json.load(sys.stdin)['flows'] if f['flow_key']=='$1'), 'MISSING'))"; }
# The same read, addressed by id. Two versions of one flow share a key, and the draft is the row
# that has to be asked about when the question is what publishing it will do.
rtlistid(){ curl -s "${AR[@]}" "$B/api/admin/workflows" | $PY -c "
import sys, json
print(next((str(f.get('$2','MISSING')) for f in json.load(sys.stdin)['flows'] if f['id']=='$1'), 'MISSING'))"; }

rtclean
RTG='{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"confirmed","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"},
                {"from":"priced","to":"confirmed","labelEn":"Confirm"}]}'
RTDEF=$(rtnew rt-def "$RTG")
ok 1 "$(rthas "routing is not set" "$(rtactivate "$RTDEF")")" \
  "a flow made the way the product makes one has NO routing, and Activate refuses it"
ok "nothing — no routing set, so it is never chosen" "$(rtlist smoke-rt-def selection_summary)" \
  "…and the list says so where somebody is actually looking, not only in that refusal"
ok active "$(rtroute "$RTDEF" '{"mode":"fallback"}' > /dev/null; rtactivate "$RTDEF" | $PY -c "
import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "answering the question makes it publishable — which is the whole of what was missing"
ok "any record no other flow claims" "$(rtlist smoke-rt-def selection_summary)" \
  "…and the fallback now says what it takes"

# ── THE CONDITION, CHOSEN FROM THE CATALOG ──────────────────────────────────────────────────────
RTC=$(rtnew rt-cond "$RTG")
ok 1 "$(rthas "matches every record" "$(rtroute "$RTC" '{"mode":"condition","condition":{}}')")" \
  "a condition with no tests is refused: it would match EVERY record, which is what the fallback is"
ok 1 "$(rthas "unknown field" "$(rtroute "$RTC" '{"mode":"condition","condition":{"all":[{"field":"payer_typo","op":"eq","value":"insurance"}]}}')")" \
  "and a field this server does not know is refused at the moment it is written, not silently at run time"
ok "Who pays is insurance" "$(rtroute "$RTC" '{"mode":"condition","condition":{"all":[{"field":"payer_type","op":"eq","value":"insurance"}]},"priority":7}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('selectionSummary',''))")" \
  "a real condition is accepted and read back as the sentence the list will print"
ok "false|selected|7" "$(psql "select is_default||'|'||entry_mode||'|'||selection_priority from workflow_flows where id='$RTC'")" \
  "…stored as one answer: not the fallback, not a handoff, and carrying the tie-break beside it"
ok active "$(rtactivate "$RTC" | $PY -c "import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "…and a SECOND flow now goes live from the product, which is what nothing could do before"
ok 1 "$(rthas "records are executing it" "$(rtroute "$RTC" '{"mode":"handoff"}')")" \
  "routing is frozen once it is live — a record must not change rulebooks because somebody re-aimed one"

# ── THE THIRD ANSWER, AND THE PAIR THAT MUST NOT BE STORED ──────────────────────────────────────
RTH=$(rtnew rt-hand '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"confirmed","labelEn":"Hand back","toFlowKey":"smoke-rt-def"}]}')
ok handoff "$(rtroute "$RTH" '{"mode":"handoff"}' > /dev/null; psql "select entry_mode from workflow_flows where id='$RTH'")" \
  "a sub-flow says so in a column rather than storing an empty condition, which means EVERY record"
ok active "$(rtactivate "$RTH" | $PY -c "import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "…and publishes with no selection condition at all, because nothing selects it"
ok 1 "$(rthas "cannot also be the fallback" "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-rt-both","nameAr":"مسار","nameEn":"Both","isDefault":true,"entryMode":"handoff"}')")" \
  "the fallback and a handoff are two answers to ONE question, and the pair is refused at the door"
ok 0 "$(psql "select count(*) from workflow_flows where flow_key='smoke-rt-both'")" \
  "…leaving nothing behind — the pair is what makes a sub-flow capture records at birth"

# ── HONEST LABELS FOR A LIVE SUB-FLOW ───────────────────────────────────────────────────────────
# The Workflows screen listed an ACTIVE handoff flow among the flows "checked before the fallback,
# in this order" and printed "takes nothing — no routing set, so it is never chosen" beside it. Both
# false: it is not in that race at any position, and not being in it IS its routing. The screen
# could not know better — list() did not select entry_mode and describeSelection had no parameter
# for it — so both halves are asserted through the endpoint the screen reads.
ok "only records another workflow hands to it" "$(rtlist smoke-rt-hand selection_summary)" \
  "a live sub-flow is described by how it is really reached, not as a flow that is never chosen"
ok handoff "$(rtlist smoke-rt-hand entry_mode)" \
  "…and the list carries the column the screen groups on, so it is not printed inside a numbered order"
ok selected "$(rtlist smoke-rt-cond entry_mode)" \
  "…while a conditional flow still says it is one, which is what keeps it IN that order"

# ── AND THE CROSSING CONTROL HAS SOMETHING TO OFFER ─────────────────────────────────────────────
# WorkflowCanvas hides "Hand it to another workflow" unless this list is non-empty: active, same
# status domain, not this flow. It was empty in every workspace, for ever, because no second flow
# could be published — so the control could not render and `to_flow_key` was unreachable.
ok 2 "$(curl -s "${AR[@]}" "$B/api/admin/workflows" | $PY -c "
import sys, json
d = json.load(sys.stdin)['flows']
me = next(f for f in d if f['flow_key'] == 'smoke-rt-def')
print(sum(1 for f in d
          if f['status'] == 'active' and f['status_domain'] == me['status_domain']
          and f['flow_key'] != me['flow_key']))")" \
  "the canvas now has other workflows to hand a record to, which is what renders the border control"

# ── A NEW VERSION OF THE FALLBACK IS STILL THE FALLBACK ─────────────────────────────────────────
# activate() hands is_default over from the version it retires — without that, republishing a
# workspace's own flow left it with NO fallback and every record raised afterwards moved unchecked.
# So the routing choice is genuinely not open on such a draft, and storing a different answer would
# be storing one activation overrules — arriving at is_default AND entry_mode='handoff' together,
# which is the exact pair refused above.
RTV2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$RTDEF/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok True "$(rtlistid "$RTV2" inherits_default)" \
  "the list says a draft will take the fallback over when it is published"
ok 1 "$(rthas "makes it the fallback again" "$(rtroute "$RTV2" '{"mode":"handoff"}')")" \
  "…so it cannot be routed to anything else, in words rather than by having the answer overruled later"
ok "false|selected" "$(psql "select is_default||'|'||entry_mode from workflow_flows where id='$RTV2'")" \
  "…and the refused write changed nothing"
curl -s -o /dev/null "${AR[@]}" -X DELETE "$B/api/admin/workflows/$RTV2"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# A → B → C → A: WHERE IS HOME WHEN A RECORD HAS CROSSED MORE THAN ONCE
# ══════════════════════════════════════════════════════════════════════════════════════════════════
#
# `origin_flow_id` was written on EVERY outbound crossing with the flow being left. Fine for one hop.
# On the second the memory of home was overwritten, so the arrow back into A no longer matched the
# origin, was judged an OUTBOUND crossing, and set origin = C — leaving a record standing in its own
# home flow permanently flagged as away from it: counted for ever in workflow_record_state_away_idx,
# labelled "from C" in My Work while it sits on A, and handed to the break-glass lever, which then
# reports bringing it back from C to B about a record already home.
#
# The rule is that HOME IS WHERE THE RECORD STARTED — written once, on the first crossing out, and
# cleared only by arriving back there. The three hops below are all real product moves: the winning
# quote, an approved cancellation, and the break-glass return, which is the one that could not
# possibly work before because it looks up the way home by the origin's key.
mhclean(){ rtclean; }
mhflow(){ # $1 = key suffix, $2 = graph, $3 = routing json -> flow id, ROUTED, still a draft
  local F; F=$(rtnew "$1" "$2")
  curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$F/routing" -d "$3"
  echo "$F"
}
# Create, send and quote — but do NOT pick the winner. Several checks below need a record sitting on
# its entry step, bound to a flow, with the crossing still ahead of it.
rtquote(){ # $1 = plate -> echoes the rfq id
  local rid tok it
  rid=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
    -d "$(printf '{"workshopBranchId":"%s","plateNumber":"%s","items":[{"partNumber":"GP","quantity":1}]}' "$BR" "$1")" \
    | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
  tok=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$rid/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
    | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
  it=$(psql "select id from rfq_items where rfq_id='$rid' limit 1")
  curl -s -o /dev/null -X POST "$B/api/quote-access/$tok/quote" -H 'Content-Type: application/json' \
    -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$it")"
  echo "$rid"
}
rtpick(){ # $1 = rfq id -> echoes the winning-quote response
  local it qi
  it=$(psql "select id from rfq_items where rfq_id='$1' limit 1")
  qi=$(psql "select id from rfq_vendor_items where rfq_item_id='$it' limit 1")
  curl -s "${AR[@]}" -X POST "$B/api/rfqs/$1/items/$it/winning-quote" -d "$(printf '{"quoteItemId":"%s"}' "$qi")"
}

mhclean
# A — home. Nothing crosses back into it at 'cancelled', so it does not need that step; C hands
# records back at 'settled', which it does.
MHA=$(mhflow mh-a '{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},
          {"status":"priced","x":340,"y":100},{"status":"settled","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"To the insurer","toFlowKey":"smoke-mh-b"},
                {"from":"priced","to":"settled","labelEn":"Settle"}]}' '{"mode":"fallback"}')
MHB=$(mhflow mh-b '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},
          {"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"cancelled","labelEn":"On to returns","toFlowKey":"smoke-mh-c"}]}' '{"mode":"handoff"}')
MHC=$(mhflow mh-c '{"steps":[{"status":"cancelled","isEntry":true,"x":80,"y":100},
          {"status":"settled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"cancelled","to":"settled","labelEn":"Home","toFlowKey":"smoke-mh-a"}]}' '{"mode":"handoff"}')
# Published in the order the checks at both ends allow: a border may name a DRAFT (that is only a
# warning, or a mutually-referencing pair could never go up) but the flow it names must exist.
ok "active|active|active" "$(rtactivate "$MHA" > /dev/null; rtactivate "$MHC" > /dev/null; rtactivate "$MHB" > /dev/null
  psql "select string_agg(status::text, '|' order by flow_key) from workflow_flows where flow_key like 'smoke-mh-%'")" \
  "three workflows, each handing on to the next and the last handing back — all live"

MHR=$(rtquote RT-HOP)
MHIT=$(psql "select id from rfq_items where rfq_id='$MHR' limit 1")
ok "smoke-mh-a/v1|home" "$(xwhere "$MHIT")" "a record is raised at home, away from nothing"
ok 0 "$(blocked "$(rtpick "$MHR")")" "HOP ONE: the winning quote hands it to B"
ok "smoke-mh-b/v1|smoke-mh-a" "$(xwhere "$MHIT")" "…and home is recorded as A, the flow it left"
MHE=$(xraise "$MHIT")
ok 0 "$(blocked "$(xdecide "$MHE")")" "HOP TWO: an approved cancellation hands it on again, B to C"
ok cancelled "$(xstatus "$MHIT")" "…the status really moved, so this is a second crossing and not a re-run of the first"
ok "smoke-mh-c/v1|smoke-mh-a" "$(xwhere "$MHIT")" \
  "…and home is STILL A. It was overwritten with B here, which is what made the way back unrecognisable"

# THE BREAK-GLASS LEVER IS THE PROOF, because it does nothing of its own: it finds the arrow whose
# to_flow_key is the record's origin and takes it through the ordinary guard. With home overwritten
# to B it looked for a way back to B from inside C, found none, and refused with a sentence that was
# false in both halves — the record was not away from B, and the flow it was away from had an arrow
# home drawn all along.
MHG=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/records/rfq_item/$MHIT/return" -d '{}')
ok "settled" "$(echo "$MHG" | $PY -c "import sys,json;print(json.load(sys.stdin).get('at',''))")" \
  "HOP THREE: the way home is found from two hops away, and it is the arrow the author drew"
ok "RT mh-a" "$(echo "$MHG" | $PY -c "import sys,json;print(json.load(sys.stdin).get('returnedTo',''))")" \
  "…and it names A, the flow the record actually came from"
ok "smoke-mh-a/v1|home" "$(xwhere "$MHIT")" \
  "…so the record is home AND is no longer flagged as away, which it was for ever before"
ok 0 "$(psql "select count(*) from workflow_record_state where entity_id='$MHIT' and origin_flow_id is not null")" \
  "…and it has left the index of records that owe somebody a return"
ok 1 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/records/rfq_item/$MHIT/return" -d '{}')")" \
  "…which a record standing in its own home flow must be: there is nothing to bring it back from"
# NOTHING IS LOST BY REMEMBERING ONLY WHERE HOME IS. The hops themselves are in status_logs, which
# carries the flow every move was judged under since 0066 — so "where has this record been" is
# answered by the history rather than by a column that can only hold one value at a time.
ok "smoke-mh-a|smoke-mh-b|smoke-mh-c|smoke-mh-a" "$(psql "select string_agg(f.flow_key, '|' order by l.created_at)
      from status_logs l join workflow_flows f on f.id=l.flow_id where l.entity_id='$MHIT'")" \
  "the full itinerary is in the history: born at A, judged by B, then C, then home again"

# ══════════════════════════════════════════════════════════════════════════════════════════════════
# THE POPULATION THE BORDER CHECKS PROTECT IS NOT THE ACTIVE FLOWS
# ══════════════════════════════════════════════════════════════════════════════════════════════════
#
# A record executes the flow VERSION it was bound to and goes on executing it after that version is
# retired — that is the whole point of the binding. So the versions holding records with a way home
# to defend are exactly the ones `f.status = 'active'` cannot see. Both border checks joined on it.
rtclean
RVH_G='{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"cancelled","isTerminal":true,"x":600,"y":100},{"status":"settled","isTerminal":true,"x":600,"y":260}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Out","toFlowKey":"smoke-rv-sub"},
                {"from":"priced","to":"cancelled","labelEn":"Cancel"},{"from":"priced","to":"settled","labelEn":"Settle"}]}'
RVH=$(mhflow rv-home "$RVH_G" '{"mode":"fallback"}')
# v1 of the sub-flow hands records back at 'cancelled'.
RVS=$(mhflow rv-sub '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},
          {"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"cancelled","labelEn":"Refused","toFlowKey":"smoke-rv-home"}]}' '{"mode":"handoff"}')
ok "active|active" "$(rtactivate "$RVH" > /dev/null; rtactivate "$RVS" > /dev/null
  psql "select string_agg(status::text, '|' order by flow_key) from workflow_flows where flow_key like 'smoke-rv-%'")" \
  "a home flow and the sub-flow it hands records to are both live"
RVR=$(rtquote RT-REVERSE)
RVIT=$(psql "select id from rfq_items where rfq_id='$RVR' limit 1")
rtpick "$RVR" > /dev/null
ok "smoke-rv-sub/v1|smoke-rv-home" "$(xwhere "$RVIT")" "a record crosses into v1 of the sub-flow and stays there"

# v2 of the SUB-FLOW hands records back somewhere else. v1 is retired by that publish and keeps the
# record — and keeps its own arrow home, to 'cancelled', which nothing active mentions any more.
RVS2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$RVS/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$RVS2/graph" \
  -d '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},{"status":"settled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"settled","labelEn":"Settled","toFlowKey":"smoke-rv-home"}]}'
ok active "$(rtactivate "$RVS2" | $PY -c "import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "the sub-flow is republished, returning at a different status this time"
ok "retired|1" "$(psql "select f.status||'|'||(select count(*) from workflow_record_state rs where rs.flow_id=f.id)
                        from workflow_flows f where f.id='$RVS'")" \
  "…so v1 is retired with a record still inside it, still carrying the only way that record can leave"

# Republishing the PARENT without 'cancelled' is the ordinary act that breaks it, done by somebody
# who may never have opened the sub-flow. Reading only the ACTIVE sub-flow, this was accepted with
# no warning: v2 returns at 'settled', which the new parent has.
RVH2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$RVH/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
RVH_DROP='{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"settled","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Out","toFlowKey":"smoke-rv-sub"},
                {"from":"priced","to":"settled","labelEn":"Settle"}]}'
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$RVH2/graph" -d "$RVH_DROP"
RVREF=$(rtactivate "$RVH2")
ok 1 "$(rthas "hands records back to this one" "$RVREF")" \
  "REVERSE: dropping the status a RETIRED sub-flow version returns to is refused — that version is what is running"
ok 1 "$(rthas "records still moving in it" "$RVREF")" \
  "…and the refusal says which version and why, because the admin's screen shows that flow live on a later one"
ok draft "$(psql "select status from workflow_flows where id='$RVH2'")" \
  "…so the record inside it cannot have its way home deleted from underneath it"
ok 0 "$(blocked "$(xhome "$RVIT")")" "and the record does come home along that arrow, which is what was being defended"
ok "smoke-rv-home/v1|home" "$(xwhere "$RVIT")" "…to the version it left, no longer away in anything"

# THE CHECK IS NOT A BLANKET REFUSAL. With nothing left executing that retired version, the status it
# used to return to may be dropped like any other — the rule is about records, not about history.
# The draft still holds the graph that was refused: a refused activation writes nothing.
ok active "$(rtactivate "$RVH2" | $PY -c "import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "once nothing is executing that version any more, the same publish goes through"

# ── AND THE SAME HOLE IN retire() ───────────────────────────────────────────────────────────────
# Retiring a flow that something crosses INTO turns a drawn border into a refusal every record hits.
# The check read active flows only, so a retired PARENT still carrying records that have not crossed
# yet was invisible — and those are precisely the records whose next move is the border.
rtclean
RRH_G='{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"cancelled","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Out","toFlowKey":"smoke-rr-sub"},
                {"from":"priced","to":"cancelled","labelEn":"Cancel"}]}'
RRH=$(mhflow rr-home "$RRH_G" '{"mode":"fallback"}')
RRS=$(mhflow rr-sub '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},
          {"status":"cancelled","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"cancelled","labelEn":"Refused","toFlowKey":"smoke-rr-home"}]}' '{"mode":"handoff"}')
ok "active|active" "$(rtactivate "$RRH" > /dev/null; rtactivate "$RRS" > /dev/null
  psql "select string_agg(status::text, '|' order by flow_key) from workflow_flows where flow_key like 'smoke-rr-%'")" \
  "a home flow and the sub-flow it hands records to are both live"
RRR=$(rtquote RT-RETIRE)
RRIT=$(psql "select id from rfq_items where rfq_id='$RRR' limit 1")
ok "smoke-rr-home/v1|home" "$(xwhere "$RRIT")" "a record is raised under v1 of the parent, with the border still ahead of it"
# The parent is republished WITHOUT the border. Nothing active crosses into the sub-flow any more —
# but v1 is retired holding a record that will.
RRH2=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$RRH/new-version" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$RRH2/graph" \
  -d '{"steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"priced","x":340,"y":100},
          {"status":"cancelled","isTerminal":true,"x":600,"y":100}],
 "transitions":[{"from":"new_rfq","to":"priced","labelEn":"Price"},{"from":"priced","to":"cancelled","labelEn":"Cancel"}]}'
ok active "$(rtactivate "$RRH2" | $PY -c "import sys,json;print(json.load(sys.stdin).get('status') or 'REFUSED')")" \
  "the parent is republished without the border, so no LIVE flow crosses into the sub-flow at all"
RRREF=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$RRS/retire")
ok 1 "$(rthas "hands records to this" "$RRREF")" \
  "retiring the sub-flow is still refused — a retired parent with records in it crosses this border too"
ok 1 "$(rthas "records still moving in it" "$RRREF")" "…and the refusal names the version doing it"
ok active "$(psql "select status from workflow_flows where id='$RRS'")" "…so the destination stays live"
ok 0 "$(blocked "$(rtpick "$RRR")")" "and the record whose only next move is that border still takes it"
ok "smoke-rr-sub/v1|smoke-rr-home" "$(xwhere "$RRIT")" "…arriving where it was always going to"

rtclean
psql "delete from approval_actions; delete from approval_requests;
      delete from approval_levels; delete from approval_policies" > /dev/null

# ════════════════════════════════════════════════════════════════════════════════════════════════
# THE STANDARD FLOW — every workspace arrives with one, and can put it back
# ════════════════════════════════════════════════════════════════════════════════════════════════
#
# Everything above this line tests the engine with flows written by hand for the occasion. This
# section tests the flow the product SHIPS: the transcription in template.ts that is provisioned,
# active, into every workspace. The load-bearing check is the business chain — turning enforcement
# on is only safe if nothing the product does is refused, and that is not a claim to be reasoned
# about, it is a claim to be driven end to end.
wfrestore
# This section is the only one that drives the chain past the order, so it is the only one that has
# to take deliveries, invoices, returns and credit notes back out. `psql -c` runs the whole list as
# ONE transaction, so a single wrong column name silently reverts the lot and the next run inherits
# the leftovers — which is why the record-state sweep at the end is written as "a binding whose
# record no longer exists" rather than as another list of ids to keep in step.
STDLIKE="(select id from rfqs where plate_number like 'STD-%')"
STDORD="(select id from orders where rfq_id in $STDLIKE)"
stdclean(){
  psql "delete from workflow_auto_fired; delete from workflow_action_runs; delete from status_logs;
        delete from workflow_exceptions;
        update rfq_items set winning_vendor_quote_item_id=null where rfq_id in $STDLIKE;
        delete from credit_note_items where credit_note_id in (select id from credit_notes where order_id in $STDORD);
        delete from return_items where return_id in (select id from returns where order_id in $STDORD);
        delete from credit_notes where order_id in $STDORD;
        delete from returns where order_id in $STDORD;
        delete from return_issues where order_item_id in (select id from order_items where order_id in $STDORD);
        delete from invoice_items where invoice_id in (select id from invoices where order_id in $STDORD);
        delete from delivery_items where delivery_id in (select id from deliveries where order_id in $STDORD);
        delete from invoices where order_id in $STDORD;
        delete from deliveries where order_id in $STDORD;
        delete from order_items where order_id in $STDORD;
        delete from orders where rfq_id in $STDLIKE;
        delete from rfq_vendor_items where rfq_vendor_id in (select id from rfq_vendors where rfq_id in $STDLIKE);
        delete from rfq_vendors where rfq_id in $STDLIKE;
        delete from rfq_items where rfq_id in $STDLIKE;
        delete from notification_log where template='vendor_rfq_invite';
        delete from rfqs where plate_number like 'STD-%';
        delete from workflow_record_state rs
         where not exists (select 1 from rfqs        x where x.id = rs.entity_id)
           and not exists (select 1 from rfq_items   x where x.id = rs.entity_id)
           and not exists (select 1 from rfq_vendors x where x.id = rs.entity_id)
           and not exists (select 1 from orders      x where x.id = rs.entity_id)
           and not exists (select 1 from order_items x where x.id = rs.entity_id)
           and not exists (select 1 from returns     x where x.id = rs.entity_id)" > /dev/null
}
stdclean

STDF=$(psql "select f.id from workflow_flows f join tenants t on t.id=f.tenant_id
             where t.slug='riyadh' and f.status_domain='item' and f.status='active' and f.is_default")
ok 1 "$([ -n "$STDF" ] && echo 1 || echo 0)" \
  "the workspace ALREADY HAS an item workflow — nobody had to draw one"
ok active "$(psql "select f.status from workflow_flows f join tenants t on t.id=f.tenant_id
                   where t.slug='riyadh' and f.status_domain='vendor' and f.is_default and f.status='active'")" \
  "and a VENDOR one too, or every rfq_vendor move would still be ungoverned"

# ── THE LOAD-BEARING CHECK ───────────────────────────────────────────────────────────────────────
# The complete business chain, with the standard flow ACTIVE and enforcing. Every one of these must
# SUCCEED. A single refusal here means the template claims something the product does not do, and
# the whole feature is a way to break a workspace on the day it is created.
STDR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"STD-CHAIN","items":[{"partNumber":"GP","quantity":4}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok 1 "$([ -n "$STDR" ] && echo 1 || echo 0)" "with the standard flow live, a request can still be raised"

STDTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
ok 1 "$([ -n "$STDTOK" ] && echo 1 || echo 0)" "…sent to a vendor"

STDIT=$(psql "select id from rfq_items where rfq_id='$STDR' limit 1")
ok 0 "$(blocked "$(curl -s -X POST "$B/api/quote-access/$STDTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$STDIT")")")" \
  "…quoted by that vendor (rfq_vendor rfq → priced, on the standard VENDOR flow)"

STDQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$STDIT' limit 1")
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDR/items/$STDIT/winning-quote" \
  -d "$(printf '{"quoteItemId":"%s"}' "$STDQI")")")" \
  "…a winner picked (rfq_item new_rfq → priced, the arrow the seeded demo flow got wrong)"

ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDR/confirm" -d '{}')")" \
  "…confirmed into an order"
STDO=$(psql "select id from orders where rfq_id='$STDR'")
STDOI=$(psql "select id from order_items where order_id='$STDO' limit 1")

# A PARTIAL delivery deliberately moves nothing, so this proves the arrow is not fired early…
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/orders/$STDO/deliveries" \
  -d "$(printf '{"items":[{"orderItemId":"%s","qty":2}]}' "$STDOI")")")" \
  "…delivered in part, which is allowed and moves nothing"
ok confirmed "$(psql "select s.code from order_items i join item_statuses s on s.id=i.status_id where i.id='$STDOI'")" \
  "…and the line is still 'confirmed', exactly as it was before the flow was enforcing"

# …and this proves it fires when the line is complete.
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/orders/$STDO/deliveries" \
  -d "$(printf '{"items":[{"orderItemId":"%s","qty":2}]}' "$STDOI")")")" \
  "…delivered in full"
ok delivered "$(psql "select s.code from order_items i join item_statuses s on s.id=i.status_id where i.id='$STDOI'")" \
  "…which really does take the line to 'delivered'"

# Asserted HERE, while the line is genuinely at 'delivered' and before the return below moves it:
# the product already answers "raise a return instead", and the template must not have quietly turned
# that refusal into a permission by drawing an arrow the product never takes.
ok 1 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions" \
  -d "$(printf '{"entityType":"order_item","entityId":"%s","kind":"cancellation","reason":"too late"}' "$STDOI")")")" \
  "a delivered line still refuses a cancellation — the template drew no delivered → cancelled arrow"

ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/orders/$STDO/invoice" -d '{}')")" \
  "…invoiced (confirmed → invoice_issued: the order header never reaches 'delivered')"

STDRET=$(curl -s "${AR[@]}" -X POST "$B/api/orders/$STDO/returns" \
  -d "$(printf '{"items":[{"orderItemId":"%s","qty":1}]}' "$STDOI")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('returnId',''))")
ok 1 "$([ -n "$STDRET" ] && echo 1 || echo 0)" "…returned"
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/returns/$STDRET/credit-note" -d '{}')")" \
  "…and credited — the one arrow return → credit_note_issued serving both the line and the document"

# The whole chain, read back off the audit trail rather than off the responses: eleven moves, none
# of them refused, every one of them an arrow the template draws.
ok 0 "$(psql "select count(*) from status_logs l
              left join item_statuses fi on fi.id=l.from_status_id
              left join vendor_statuses fv on fv.id=l.from_status_id
              left join item_statuses ti on ti.id=l.to_status_id
              left join vendor_statuses tv on tv.id=l.to_status_id
              where coalesce(ti.code, tv.code) is null")" \
  "and every move it made resolved to a real status, start to finish"

# ── AND THE WHOLE CHAIN AGAIN, WITH A HANDOFF FLOW CONFIGURED (0066) ─────────────────────────────
# The load-bearing check above is what makes enforcement safe to turn on. This is the same claim for
# the feature that lets a workspace run a second flow beside the standard one: publishing a sub-flow
# must not change what happens to a record that never goes near it.
#
# The sub-flow below is real — active, in the item domain, crossing back into 'standard' — and it is
# entry_mode 'handoff', so nothing selects it: `selectableFlows` only ever considers a non-default
# flow with a selection condition, and this one has none. The chain that follows is therefore the
# ORDINARY case, driven end to end with the extra flow live.
XSIDE=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"smoke-x-side","nameAr":"مسار جانبي","nameEn":"Side","isDefault":false,"entryMode":"handoff"}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X PUT "$B/api/admin/workflows/$XSIDE/graph" \
  -d '{"steps":[{"status":"priced","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"priced","to":"confirmed","labelEn":"Hand back","toFlowKey":"standard"}]}'
ok active "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/$XSIDE/activate" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('status',''))")" \
  "a handoff flow can be published beside the workspace's own, crossing back into it"

XCR=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"STD-XCHAIN","items":[{"partNumber":"GP","quantity":4}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok standard "$(psql "select f.flow_key from workflow_record_state rs join workflow_flows f on f.id=rs.flow_id
                     where rs.entity_type='rfq' and rs.entity_id='$XCR'")" \
  "…and a new request still binds to the workspace's own flow, not to the one nothing selects"
XCTOK=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$XCR/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
ok 1 "$([ -n "$XCTOK" ] && echo 1 || echo 0)" "…sent to a vendor"
XCIT=$(psql "select id from rfq_items where rfq_id='$XCR' limit 1")
ok 0 "$(blocked "$(curl -s -X POST "$B/api/quote-access/$XCTOK/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$XCIT")")")" "…quoted"
XCQI=$(psql "select id from rfq_vendor_items where rfq_item_id='$XCIT' limit 1")
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$XCR/items/$XCIT/winning-quote" \
  -d "$(printf '{"quoteItemId":"%s"}' "$XCQI")")")" "…a winner picked, and NOT diverted into the sub-flow"
ok standard "$(psql "select f.flow_key from workflow_record_state rs join workflow_flows f on f.id=rs.flow_id
                     where rs.entity_id='$XCIT'")" \
  "…the line is still governed by the standard flow, because no arrow in it names the other one"
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$XCR/confirm" -d '{}')")" "…confirmed into an order"
XCO=$(psql "select id from orders where rfq_id='$XCR'")
XCOI=$(psql "select id from order_items where order_id='$XCO' limit 1")
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/orders/$XCO/deliveries" \
  -d "$(printf '{"items":[{"orderItemId":"%s","qty":4}]}' "$XCOI")")")" "…delivered in full"
ok delivered "$(psql "select s.code from order_items i join item_statuses s on s.id=i.status_id where i.id='$XCOI'")" \
  "…which really does take the line to 'delivered'"
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/orders/$XCO/invoice" -d '{}')")" "…and invoiced"
ok 0 "$(psql "select count(*) from workflow_record_state where entity_id in ('$XCR','$XCIT','$XCOI') and origin_flow_id is not null")" \
  "and nothing on that chain was ever 'away' — a sub-flow nobody crosses into changes nothing"
# Retire it the supported way: nothing crosses INTO it, so retire() has nothing to refuse.
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/admin/workflows/$XSIDE/retire"
psql "delete from workflow_record_state where entity_id in ('$XCR','$XCIT','$XCOI');
      alter table workflow_flows disable trigger trg_workflow_flows_freeze;
      alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
      delete from workflow_transitions where flow_id='$XSIDE';
      delete from workflow_steps where flow_id='$XSIDE';
      delete from workflow_flows where id='$XSIDE';
      alter table workflow_flows enable trigger trg_workflow_flows_freeze;
      alter table workflow_steps enable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null

# ── THE ARROWS THE HAPPY PATH DOES NOT WALK ──────────────────────────────────────────────────────
# Insurance, and a cancellation approved on a confirmed order. Both were verified against the live
# product before the template was drawn; here they are asserted against the template enforcing.
STDINS=$(psql "select id from insurance_companies where tenant_id='$RIYADH' limit 1")
[ -z "$STDINS" ] && STDINS=$(curl -s "${AR[@]}" -X POST "$B/api/insurance/companies" \
  -d '{"name":"Standard Insurer"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
STDI=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"STD-INS","items":[{"partNumber":"GP","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${AR[@]}" -X POST "$B/api/rfqs/$STDI/payer" \
  -d "$(printf '{"payerType":"insurance","insuranceCompanyId":"%s"}' "$STDINS")"
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDI/insurance/send-for-approval")")" \
  "an insurance request can still be sent to the insurer"
ok 0 "$(blocked "$(curl -s "${MR[@]}" -X POST "$B/api/rfqs/$STDI/insurance/approve")")" \
  "and the insurer's approval can still be recorded"

STDC=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"STD-CANCEL","items":[{"partNumber":"GP","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
STDCE=$(curl -s "${AR[@]}" -X POST "$B/api/workflow/exceptions" \
  -d "$(printf '{"entityType":"rfq","entityId":"%s","kind":"cancellation","reason":"customer changed their mind"}' "$STDC")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok cancelled "$(curl -s "${MR[@]}" -X POST "$B/api/workflow/exceptions/$STDCE/resolve" -d '{"decision":"approve"}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('movedTo'))")" \
  "and an approved cancellation still lands on 'cancelled' rather than being refused by the flow"

# The other refusal the product ALREADY makes must survive the template too, or drawing it changed
# the product instead of describing it.
ok 1 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDR/confirm" -d '{}')")" \
  "and a request already confirmed still refuses a second confirm"

# ── PROVISIONING IS IDEMPOTENT, AND NEVER OVERWRITES ─────────────────────────────────────────────
STDFB=$(psql "select count(*) from workflow_flows f join tenants t on t.id=f.tenant_id where t.slug='riyadh'")
PROV=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/provision")
ok "kept|kept" "$(echo "$PROV" | $PY -c "import sys,json;print('|'.join(r['outcome'] for r in json.load(sys.stdin)))")" \
  "running provisioning again KEEPS what is there — it does not draw a second copy"
ok "$STDFB" "$(psql "select count(*) from workflow_flows f join tenants t on t.id=f.tenant_id where t.slug='riyadh'")" \
  "and the workspace still has exactly the same number of flows"
ok "$STDF" "$(echo "$PROV" | $PY -c "
import sys, json
print(next(r['flowId'] for r in json.load(sys.stdin) if r['statusDomain'] == 'item'))")" \
  "pointing at the SAME flow, not a replacement with the same drawing"

# A WORKSPACE THAT DREW ITS OWN IS LEFT ALONE. Proved on a workspace created for the purpose, both
# because the assertion needs a workspace whose only flow is hand-drawn, and because "a new
# workspace arrives with one" is the other half of the same promise.
psql "delete from tenants where slug='guard-provision'" > /dev/null 2>&1
NEWWS=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workspaces" \
  -d '{"name":"Guard Provisioning","slug":"guard-provision"}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok "item|vendor" "$(psql "select string_agg(status_domain::text, '|' order by status_domain)
                          from workflow_flows where tenant_id='$NEWWS' and status='active' and is_default")" \
  "a workspace created 30 seconds ago already has BOTH standard flows, active"

# now give it one of its own instead, and ask provisioning to run again
psql "alter table workflow_flows disable trigger trg_workflow_flows_freeze;
      alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
      delete from workflow_transitions where flow_id in (select id from workflow_flows where tenant_id='$NEWWS' and status_domain='item');
      delete from workflow_steps where flow_id in (select id from workflow_flows where tenant_id='$NEWWS' and status_domain='item');
      delete from workflow_flows where tenant_id='$NEWWS' and status_domain='item';
      alter table workflow_flows enable trigger trg_workflow_flows_freeze;
      alter table workflow_steps enable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null
NR=(-H "Authorization: Bearer $ATOK" -H "X-Tenant: guard-provision" -H "Content-Type: application/json")
OWNF=$(curl -s "${NR[@]}" -X POST "$B/api/admin/workflows" \
  -d '{"flowKey":"their-own","nameAr":"مسارهم","nameEn":"Their own flow","isDefault":true}' \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
curl -s -o /dev/null "${NR[@]}" -X PUT "$B/api/admin/workflows/$OWNF/graph" -d '{"selectionCondition":{},
 "steps":[{"status":"new_rfq","isEntry":true,"x":80,"y":100},{"status":"confirmed","isTerminal":true,"x":340,"y":100}],
 "transitions":[{"from":"new_rfq","to":"confirmed","labelEn":"Confirm"}]}'
curl -s -o /dev/null "${NR[@]}" -X POST "$B/api/admin/workflows/$OWNF/activate"
ok "$OWNF" "$(curl -s "${NR[@]}" -X POST "$B/api/admin/workflows/provision" | $PY -c "
import sys, json
print(next(r['flowId'] for r in json.load(sys.stdin) if r['statusDomain'] == 'item'))")" \
  "a workspace that drew its OWN flow is left alone — provisioning returns theirs, untouched"
ok 0 "$(psql "select count(*) from workflow_flows where tenant_id='$NEWWS' and flow_key='standard'")" \
  "and no standard flow is dropped in beside it"

# Reset republishes the rulebook a whole workspace runs on, so it sits behind the same door as every
# other write to a flow: platform staff may look, only a super admin may change. Needs a NON-super
# platform member, minted here — the seeded admin is super_admin and would pass the check while
# proving nothing, and the one the role tests used earlier in this file was deleted with them.
psql "insert into users (email, full_name, password_hash, is_active)
      values ('resetcheck@qparts.local','Reset Check','$HASH',true)
      on conflict (email) do update set is_active=true;
      insert into platform_members (user_id, role, is_active)
      select id,'purchasing',true from users where email='resetcheck@qparts.local'
      on conflict do nothing" > /dev/null
RTOK=$(curl -s -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"resetcheck@qparts.local","password":"admin1234"}' | $PY -c "import sys,json;print(json.load(sys.stdin).get('token',''))")
ok 403 "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/api/admin/workflows/reset" \
  -H "Authorization: Bearer $RTOK" -H 'X-Tenant: riyadh' -H 'Content-Type: application/json' \
  -d '{"statusDomain":"item"}')" \
  "platform staff below super admin cannot reset a workspace's workflow"
psql "delete from platform_members where user_id in (select id from users where email='resetcheck@qparts.local');
      delete from users where email='resetcheck@qparts.local'" > /dev/null

# ── RESET PUBLISHES A NEW VERSION; IT DOES NOT EDIT THE LIVE ONE ─────────────────────────────────
# The whole reason reset is not a button that redraws the active flow: an order halfway through must
# not have its rules rewritten underneath it.
STDV1=$(psql "select version from workflow_flows where id='$STDF'")
INFLIGHT=$(psql "select flow_id from workflow_record_state rs
                 join rfqs r on r.id = rs.entity_id
                 where rs.entity_type='rfq' and r.plate_number='STD-CHAIN'")
ok "$STDF" "$INFLIGHT" "a record raised under the standard flow is bound to the version it entered under"

RES=$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/reset" -d '{"statusDomain":"item"}')
STDF2=$(echo "$RES" | $PY -c "import sys,json;print(json.load(sys.stdin).get('flowId',''))")
ok $((STDV1 + 1)) "$(echo "$RES" | $PY -c "import sys,json;print(json.load(sys.stdin).get('version'))")" \
  "reset publishes the NEXT VERSION of the flow"
ok 1 "$([ "$STDF2" != "$STDF" ] && echo 1 || echo 0)" \
  "as a different flow row — the active one was not edited"
ok retired "$(psql "select status from workflow_flows where id='$STDF'")" \
  "the version it replaced is retired rather than deleted"
ok active "$(psql "select status from workflow_flows where id='$STDF2'")" "and the new one is live"
ok 10 "$(psql "select count(*) from workflow_steps where flow_id='$STDF'")" \
  "the retired version keeps its whole graph, because records are still executing it"

ok "$STDF" "$(psql "select flow_id from workflow_record_state rs
                    join rfqs r on r.id = rs.entity_id
                    where rs.entity_type='rfq' and r.plate_number='STD-CHAIN'")" \
  "and a record already in flight STAYS on the version it started under, not the new one"
ok 1 "$(echo "$RES" | $PY -c "
import sys, json
print(1 if json.load(sys.stdin).get('inFlightKeepingOldRules', 0) > 0 else 0)")" \
  "which the reset itself reports, so the screen can say it rather than imply otherwise"

# The workspace is still workable after a reset — the new version is the same drawing, so the same
# move that succeeded before it must succeed after it.
STDR2=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs" \
  -d "$(printf '{"workshopBranchId":"%s","plateNumber":"STD-AFTER","items":[{"partNumber":"GP","quantity":1}]}' "$BR")" \
  | $PY -c "import sys,json;print(json.load(sys.stdin).get('id',''))")
ok "$STDF2" "$(psql "select flow_id from workflow_record_state rs join rfqs r on r.id=rs.entity_id
                     where rs.entity_type='rfq' and r.plate_number='STD-AFTER'")" \
  "while a record raised AFTER the reset binds to the new version"
STDTOK2=$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDR2/send" -d "$(printf '{"vendorIds":["%s"]}' "$VID")" \
  | $PY -c "import sys,json;d=json.load(sys.stdin);print(d['results'][0]['token'] if d.get('results') else '')")
STDIT2=$(psql "select id from rfq_items where rfq_id='$STDR2' limit 1")
curl -s -o /dev/null -X POST "$B/api/quote-access/$STDTOK2/quote" -H 'Content-Type: application/json' \
  -d "$(printf '{"items":[{"rfqItemId":"%s","offeredCost":50}]}' "$STDIT2")"
STDQI2=$(psql "select id from rfq_vendor_items where rfq_item_id='$STDIT2' limit 1")
ok 0 "$(blocked "$(curl -s "${AR[@]}" -X POST "$B/api/rfqs/$STDR2/items/$STDIT2/winning-quote" \
  -d "$(printf '{"quoteItemId":"%s"}' "$STDQI2")")")" \
  "and it can be worked exactly as before — a reset restores the drawing, it does not stop the shop"

# ── put the workspace back the way provisioning left it ──────────────────────────────────────────
# The reset test necessarily leaves a v2 behind. Removing it and un-retiring v1 keeps a repeated run
# of this suite from stacking versions for ever. The records go FIRST, in their own statement: psql
# runs a multi-statement -c as one transaction, so a foreign key that bites halfway rolls the whole
# thing back and leaves the workspace holding the test's leftovers.
stdclean
psql "delete from workflow_record_state where flow_id in
        (select id from workflow_flows where flow_key in ($STD_KEYS) and version > 1);
      alter table workflow_flows disable trigger trg_workflow_flows_freeze;
      alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
      delete from workflow_transitions where flow_id in
        (select id from workflow_flows where flow_key in ($STD_KEYS) and version > 1);
      delete from workflow_steps where flow_id in
        (select id from workflow_flows where flow_key in ($STD_KEYS) and version > 1);
      delete from workflow_flows where flow_key in ($STD_KEYS) and version > 1;
      -- is_default comes back with it. Retiring a flow now CLEARS the flag (activate() and the
      -- template reset both hand it to the successor, so exactly one row per domain claims to be
      -- the fallback), which means un-retiring v1 without it left the workspace with an active
      -- standard flow that was nobody's fallback — the suite's own leftover, and the state where a
      -- record matching no condition binds to nothing.
      update workflow_flows set status='active', is_default=true
        where flow_key in ($STD_KEYS) and version = 1 and status = 'retired';
      delete from workflow_transitions where flow_id in (select id from workflow_flows where tenant_id='$NEWWS');
      delete from workflow_steps where flow_id in (select id from workflow_flows where tenant_id='$NEWWS');
      delete from workflow_record_state where tenant_id='$NEWWS';
      delete from workflow_flows where tenant_id='$NEWWS';
      alter table workflow_flows enable trigger trg_workflow_flows_freeze;
      alter table workflow_steps enable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions enable trigger trg_workflow_transitions_freeze;
      delete from tenants where id='$NEWWS'" > /dev/null
stdclean
ok "1|1|1" "$(psql "select count(*)||'|'||count(*) filter (where status='active')
                             ||'|'||count(*) filter (where is_default and status='active')
                    from workflow_flows f join tenants t on t.id=f.tenant_id
                    where t.slug='riyadh' and f.flow_key='standard'")" \
  "and the suite leaves the workspace with exactly one standard item flow, active AND the fallback"

# ── a draft does not count as "this workspace already has a workflow" ────────────────────────────
# The untouchability rule protects a workspace that answered "what is the workflow here" for itself.
# A DRAFT has not answered it — a draft enforces nothing — so a workspace holding an abandoned one
# was skipped by provisioning and left with no working flow at all, which is the exact situation
# this feature exists to remove. Found on production: both workspaces took the vendor default and
# neither took the item one, because each was carrying a test draft left behind months earlier.
psql "delete from workflow_flows where flow_key='smoke-leftover-draft'" > /dev/null
DRAFTT=$(psql "select id from tenants where slug='riyadh'")
psql "insert into workflow_flows (tenant_id, environment, flow_key, version, name_en, name_ar,
        status_domain, status, is_default)
      values ('$DRAFTT'::uuid, 'sandbox', 'smoke-leftover-draft', 1, 'Left behind', 'مهملة',
              'item', 'draft', false)" > /dev/null
ok 1 "$(curl -s "${AR[@]}" -X POST "$B/api/admin/workflows/provision" -H 'X-Environment: sandbox' -d '{}' \
  > /dev/null 2>&1; psql "select count(*) from workflow_flows
     where tenant_id='$DRAFTT'::uuid and environment='sandbox' and status_domain='item'
       and status='active' and is_default")" \
  "an abandoned draft does not stop a workspace getting its default flow"
ok 1 "$(psql "select count(*) from workflow_flows where flow_key='smoke-leftover-draft' and status='draft'")" \
  "and the draft it was carrying is left exactly where it was"
# Children before parents, and record_state before either: workflow_record_state carries a composite
# FK to the flow, so deleting the flow first fails on the constraint — silently, behind > /dev/null —
# and leaves an ACTIVE sandbox flow that makes the next run's routing counts wrong.
psql "alter table workflow_flows disable trigger trg_workflow_flows_freeze;
      alter table workflow_steps disable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions disable trigger trg_workflow_transitions_freeze;
      delete from workflow_record_state where environment='sandbox';
      delete from workflow_transitions where flow_id in (select id from workflow_flows where environment='sandbox');
      delete from workflow_steps       where flow_id in (select id from workflow_flows where environment='sandbox');
      delete from workflow_flows where environment='sandbox';
      alter table workflow_flows enable trigger trg_workflow_flows_freeze;
      alter table workflow_steps enable trigger trg_workflow_steps_freeze;
      alter table workflow_transitions enable trigger trg_workflow_transitions_freeze" > /dev/null
ok 0 "$(psql "select count(*) from workflow_flows where environment='sandbox'")" \
  "and this block leaves no sandbox flow behind to skew the next run" 
