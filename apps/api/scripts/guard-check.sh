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

# routing still resolves through the new shape
ok 3 "$(psql "select count(*) from workflow_steps ws
              where exists (select 1 from jsonb_array_elements(ws.pages) e where e->>'page'='rfqs')")" \
  "routing resolves a page key out of the new {page,mode} shape"

# A status can now be an `action` station on several screens, so two people pressing two buttons on
# the same record is ordinary use. Without the row lock both reads see the same status, both pass the
# guard, and the loser writes a status_logs row claiming a move from a state it was never in.
ok 1 "$(/usr/bin/grep -c "order by id for update" "$(cd "$(dirname "$0")/.." && pwd)/src/common/status.service.ts")" \
  "the status gateway locks the rows it is about to move"

# §3.4 — the canonical case: ONE status, two stations, two different roles
WFI=$(psql "select id from workflow_flows where flow_key='insurance' limit 1")
if [ -n "$WFI" ]; then
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
fi

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
