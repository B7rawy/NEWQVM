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
