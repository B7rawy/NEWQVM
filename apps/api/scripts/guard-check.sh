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
