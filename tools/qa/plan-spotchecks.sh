#!/usr/bin/env bash
# Live spot-check battery for the fourth-audit plan: §1 bugs 6-7 and the §2
# backend matrix rows the named harnesses do not press directly. Every line is
# a real request against the running API. Self-cleaning: incidents it creates
# are cancelled and any capacity/unit it toggles is restored at the end.
# Run: bash tools/qa/plan-spotchecks.sh   (API must be up on :8000)
set -u
API=http://127.0.0.1:8000/api/v1
pass=0; fail=0; CREATED=(); TOGGLED_UNIT=""; KGCH_RESTORE=0
ck() { # ck <name> <expected> <actual> [detail]
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "  ok   $1 ($3)";
  else fail=$((fail+1)); echo "  FAIL $1 — expected $2 got $3 ${4:-}"; fi
}
code() { curl -s -o /tmp/body -w "%{http_code}" "$@"; }
tok() { curl -s -X POST $API/auth/login -H 'content-type: application/json' \
        -d "{\"email\":\"$1\",\"password\":\"$2\"}" | python3 -c "import json,sys; print(json.load(sys.stdin)['access_token'])"; }
jqp() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }
mk_incident() { # mk_incident <json-body> -> echoes id, remembers for cleanup
  local id; id=$(curl -s -X POST $API/incidents -H "Authorization: Bearer $DISP" \
    -H 'content-type: application/json' -d "$1" | jqp "d['id']")
  CREATED+=("$id"); echo "$id"
}
cleanup() {
  for I in "${CREATED[@]:-}"; do
    [ -n "$I" ] && curl -s -X POST $API/incidents/$I/status -H "Authorization: Bearer $DISP" \
      -H 'content-type: application/json' -d '{"status":"cancelled"}' -o /dev/null
  done
  if [ -n "$TOGGLED_UNIT" ]; then
    curl -s -X POST $API/ambulances/$TOGGLED_UNIT/status -H "Authorization: Bearer $ADMIN" \
      -H 'content-type: application/json' -d '{"status":"available"}' -o /dev/null
  fi
  if [ "$KGCH_RESTORE" -gt 0 ]; then
    curl -s -X POST $API/hospitals/1/capacity/quick -H "Authorization: Bearer $KGCH" \
      -H 'content-type: application/json' -d "{\"deltas\":{\"beds_available\":$KGCH_RESTORE}}" -o /dev/null
  fi
}
trap cleanup EXIT

DISP=$(tok dispatch@medmesh.in Dispatch@108)
ADMIN=$(tok admin@medmesh.in MedMesh@2026)
KGCH=$(tok admin@kgch.medmesh.in Hospital@2026)
CREW=$(tok crew@medmesh.in Crew@108)
GOV=$(tok gov@medmesh.in District@2026)

echo "== authentication =="
ck "wrong password refused"          401 "$(code -X POST $API/auth/login -H 'content-type: application/json' -d '{"email":"dispatch@medmesh.in","password":"WrongPass@123"}')"
ck "garbage bearer token"            401 "$(code $API/incidents -H 'Authorization: Bearer not.a.token')"
ck "expired-shaped token"            401 "$(code $API/incidents -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZXhwIjoxNTAwMDAwMDAwfQ.Garbage')"
ck "missing token on protected read" 401 "$(code $API/incidents)"
ck "valid session identifies role"   200 "$(code $API/auth/me -H "Authorization: Bearer $DISP")"
ME=$(curl -s $API/auth/me -H "Authorization: Bearer $DISP" | jqp "d['role']")
ck "me reports dispatcher role"      "dispatcher" "$ME"

echo "== role and resource scope =="
ck "ward cannot write another facility"   403 "$(code -X POST $API/hospitals/2/capacity/quick -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d '{"deltas":{"beds_available":1}}')"
ck "ward cannot hold at another facility" 403 "$(code -X POST $API/hospitals/2/hold -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d '{"resource":"bed","incident_id":1}')"
ck "dispatcher cannot read audit trail"   403 "$(code $API/governance/audit -H "Authorization: Bearer $DISP")"
ck "ward cannot read audit trail"         403 "$(code $API/governance/audit -H "Authorization: Bearer $KGCH")"
ck "gov CAN read audit trail (oversight role, by design)" 200 "$(code $API/governance/audit -H "Authorization: Bearer $GOV")"
ck "anonymous cannot read the queue"      401 "$(code $API/incidents)"
ck "gov cannot create incidents"          403 "$(code -X POST $API/incidents -H "Authorization: Bearer $GOV" -H 'content-type: application/json' -d '{"category":"trauma_fall","urgency":"P2","lat":11.0,"lng":76.9,"district_id":1}')"
ck "driver cannot read the audit trail"   403 "$(code $API/governance/audit -H "Authorization: Bearer $CREW")"
# driver REST scope: an incident with no crew assignment is not theirs to progress
INCX=$(mk_incident '{"category":"trauma_fall","urgency":"P3","lat":11.0168,"lng":76.9558,"landmark":"spotcheck-driver","district_id":1}')
D1=$(code -X POST $API/incidents/$INCX/status -H "Authorization: Bearer $CREW" -H 'content-type: application/json' -d '{"status":"en_route"}')
if [ "$D1" = 403 ] || [ "$D1" = 404 ]; then pass=$((pass+1)); echo "  ok   driver cannot progress an unassigned incident ($D1)"; else fail=$((fail+1)); echo "  FAIL driver progressed an unassigned incident ($D1)"; fi
# ...and neither is one dispatched to a different unit
OTHER=$(curl -s "$API/ambulances?limit=200" -H "Authorization: Bearer $ADMIN" | jqp "next(u['id'] for u in d['results'] if u['status']=='available' and u['id']!=1)")
curl -s -X POST $API/incidents/$INCX/dispatch -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d "{\"hospital_id\":2,\"ambulance_id\":$OTHER}" -o /dev/null
D2=$(code -X POST $API/incidents/$INCX/status -H "Authorization: Bearer $CREW" -H 'content-type: application/json' -d '{"status":"at_scene"}')
if [ "$D2" = 403 ] || [ "$D2" = 404 ]; then pass=$((pass+1)); echo "  ok   driver cannot progress another unit's incident ($D2)"; else fail=$((fail+1)); echo "  FAIL driver progressed another unit's incident ($D2)"; fi

echo "== input validation (bug 6) =="
ck "lat 95 rejected"      422 "$(code -X POST $API/incidents -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d '{"category":"trauma_fall","urgency":"P2","lat":95,"lng":76.9,"district_id":1}')"
ck "lng -200 rejected"    422 "$(code -X POST $API/incidents -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d '{"category":"trauma_fall","urgency":"P2","lat":11.0,"lng":-200,"district_id":1}')"
ck "empty quick-adjust rejected" 422 "$(code -X POST $API/hospitals/1/capacity/quick -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d '{"deltas":{}}')"
# an overdraw clamps at zero instead of writing negative capacity
BEDS=$(curl -s $API/hospitals/1 -H "Authorization: Bearer $KGCH" | jqp "d['capacity']['beds_available']")
ck "overdraw quick-adjust accepted" 200 "$(code -X POST $API/hospitals/1/capacity/quick -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d "{\"deltas\":{\"beds_available\":-$((BEDS+25))}}")"
# read the clamp from the written record in the response — a later GET can be
# overtaken by the demo simulator's own ingest tick
CLAMP=$(cat /tmp/body | jqp "d['changed']['beds_available']['to']")
ck "overdraw clamped at zero, never negative" "0" "$CLAMP"
# restore the beds right away — later checks dispatch to this same facility,
# and a zero-bed KGCH would (correctly) block them
curl -s -X POST $API/hospitals/1/capacity/quick -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d "{\"deltas\":{\"beds_available\":$BEDS}}" -o /dev/null
KGCH_RESTORE=0
OPEN=$(mk_incident '{"category":"trauma_fall","urgency":"P3","lat":11.0168,"lng":76.9558,"landmark":"spotcheck","district_id":1}')
ck "illegal stage transition refused" 409 "$(code -X POST $API/incidents/$OPEN/status -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d '{"status":"handed_over"}')"
grep -q "allowed" /tmp/body && { pass=$((pass+1)); echo "  ok   refusal lists the legal transitions"; } || { fail=$((fail+1)); echo "  FAIL refusal gave no legal transitions"; }
# decline without a structured reason, on a real inbound alert
DISP_INC=$(mk_incident '{"category":"trauma_fall","urgency":"P2","lat":11.0168,"lng":76.9558,"landmark":"spotcheck-decline","district_id":1}')
ck "precondition: dispatch to KGCH committed" 200 "$(code -X POST $API/incidents/$DISP_INC/dispatch -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d '{"hospital_id":1,"hold_resource":"bed"}')"
ck "decline without reason rejected"   422 "$(code -X POST $API/incidents/$DISP_INC/facility-response -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d '{"response":"declined"}')"
ck "free-text decline reason rejected" 422 "$(code -X POST $API/incidents/$DISP_INC/facility-response -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d '{"response":"declined","reason":"beds full sorry"}')"
ck "structured decline accepted"       200 "$(code -X POST $API/incidents/$DISP_INC/facility-response -H "Authorization: Bearer $KGCH" -H 'content-type: application/json' -d '{"response":"declined","reason":"no_icu"}')"
ST=$(curl -s $API/incidents/$DISP_INC -H "Authorization: Bearer $DISP" | jqp "len(d['active_holds']), d['declined_hospital_ids']")
ck "decline released hold + marked ineligible" "0 [1]" "$ST"
SHORT=$(curl -s $API/incidents/$DISP_INC/shortlist -H "Authorization: Bearer $DISP" | jqp "[r['hospital_id'] for r in d['results']]")
echo "$SHORT" | grep -qw 1 && { fail=$((fail+1)); echo "  FAIL declined hospital still shortlisted ($SHORT)"; } || { pass=$((pass+1)); echo "  ok   declined hospital dropped from the shortlist"; }

echo "== dispatch guards =="
UNIT=$(curl -s "$API/ambulances?limit=200" -H "Authorization: Bearer $ADMIN" | jqp "next(u['id'] for u in d['results'] if u['status']=='available')")
curl -s -X POST $API/ambulances/$UNIT/status -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"status":"out_of_service"}' -o /dev/null
TOGGLED_UNIT=$UNIT
INC2=$(mk_incident '{"category":"trauma_fall","urgency":"P2","lat":11.0168,"lng":76.9558,"landmark":"spotcheck-unit","district_id":1}')
ck "out-of-service unit refused" 409 "$(code -X POST $API/incidents/$INC2/dispatch -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d "{\"hospital_id\":1,\"ambulance_id\":$UNIT}")"
curl -s -X POST $API/ambulances/$UNIT/status -H "Authorization: Bearer $ADMIN" -H 'content-type: application/json' -d '{"status":"available"}' -o /dev/null
TOGGLED_UNIT=""
NICU=$(curl -s "$API/ambulances?limit=200" -H "Authorization: Bearer $ADMIN" | jqp "next((u['id'] for u in d['results'] if u['status']=='available' and u['capability']=='nicu'), 0)")
INC3=$(mk_incident '{"category":"cardiac","urgency":"P1","lat":11.0168,"lng":76.9558,"landmark":"spotcheck-cap","district_id":1}')
# A hand-picked unit that carries the wrong capability is NOT hard-blocked --
# by design the override path commits with recorded accountability (matched:
# false + warnings naming both capabilities) instead of surprising anyone.
# Hard 409s are reserved for units that are not free at all.
if [ "$NICU" = 0 ]; then
  echo "  skip manual capability mismatch (no free NICU unit right now — pytest covers it)"
else
  ck "manual mismatch commits with accountability" 200 "$(code -X POST $API/incidents/$INC3/dispatch -H "Authorization: Bearer $DISP" -H 'content-type: application/json' -d "{\"hospital_id\":1,\"ambulance_id\":$NICU}")"
  MATCHED=$(cat /tmp/body | jqp "d['crew_notes']['matched']")
  WARNED=$(cat /tmp/body | jqp "any('carries' in w and 'asks for' in w for w in d['crew_notes']['warnings'])")
  ck "mismatch recorded as unmatched" "False" "$MATCHED"
  ck "warning names what unit carries vs what incident asks" "True" "$WARNED"
fi
echo "== state after a failed dispatch (bug 7) =="
ST2=$(curl -s $API/incidents/$INC2 -H "Authorization: Bearer $DISP" | jqp "d['status'], d['assigned_ambulance_id'], len(d['active_holds'])")
ck "refused out-of-service dispatch left no half-state" "open None 0" "$ST2"

echo "== exports =="
ct() { grep -i '^content-type:' "$1" | tr -d '\r' | awk '{print $2}' | cut -d';' -f1; }
C1=$(curl -s -D /tmp/hdr1 -o /tmp/cap.csv -w "%{http_code}" $API/analytics/export/capacity.csv -H "Authorization: Bearer $GOV")
ck "gov capacity export"            200 "$C1"
ck "capacity export content-type"   "text/csv" "$(ct /tmp/hdr1)"
ck "capacity export has rows"       "yes" "$([ "$(wc -l < /tmp/cap.csv)" -gt 100 ] && echo yes || echo no)"
C2=$(curl -s -D /tmp/hdr2 -o /tmp/inc.csv -w "%{http_code}" $API/analytics/export/incidents.csv -H "Authorization: Bearer $GOV")
ck "gov incident export"            200 "$C2"
ck "incident export content-type"   "text/csv" "$(ct /tmp/hdr2)"
ck "incident export names destinations" "yes" "$(head -1 /tmp/inc.csv | grep -qc assigned_hospital && echo yes || echo no)"
# cross-district rows (bug 4): any incident outside the exporter's home district
# must still carry a resolved hospital name, never a blank
XDIST=$(python3 - <<'PY'
import csv
rows = list(csv.DictReader(open('/tmp/inc.csv')))
bad = [r for r in rows if r.get('assigned_hospital_id') and not r.get('assigned_hospital')]
cross = [r for r in rows if r.get('district_id') and r['district_id'] != rows[0].get('district_id')]
print(f"{len(bad)}|{len(cross)}|{len(rows)}")
PY
)
BAD=$(echo "$XDIST" | cut -d'|' -f1); CROSS=$(echo "$XDIST" | cut -d'|' -f2); TOTAL=$(echo "$XDIST" | cut -d'|' -f3)
ck "no row lost its hospital name" "0" "$BAD"
echo "  info incident export: $TOTAL rows, $CROSS outside the first row's district"
ck "ward blocked from incident export" 403 "$(code $API/analytics/export/incidents.csv -H "Authorization: Bearer $KGCH" -o /dev/null)"
ck "ward blocked from capacity export" 403 "$(code $API/analytics/export/capacity.csv -H "Authorization: Bearer $KGCH" -o /dev/null)"
ck "driver blocked from exports"       403 "$(code $API/analytics/export/incidents.csv -H "Authorization: Bearer $CREW" -o /dev/null)"
ck "expired token blocked from export" 401 "$(code $API/analytics/export/capacity.csv -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIiwiZXhwIjoxNTAwMDAwMDAwfQ.Garbage' -o /dev/null)"

echo
echo "spotchecks: $pass passed, $fail failed"
[ "$fail" = 0 ]
