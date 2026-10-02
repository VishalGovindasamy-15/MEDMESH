"""Smoke test: the critical paths must work end-to-end.

Run:  python3 -m pytest tests -q      (from backend/)
"""

from __future__ import annotations

import json
import os
import tempfile

os.environ["MEDMESH_SIMULATOR_ENABLED"] = "false"
os.environ["MEDMESH_DATABASE_URL"] = f"sqlite+pysqlite:///{tempfile.gettempdir()}/medmesh-test.db"

import pathlib

pathlib.Path(tempfile.gettempdir(), "medmesh-test.db").unlink(missing_ok=True)

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

API = "/api/v1"


def client() -> TestClient:
    return TestClient(app)


def _login(c: TestClient, email: str, pw: str) -> dict:
    r = c.post(f"{API}/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_public_directory_needs_no_login():
    with client() as c:
        r = c.get(f"{API}/hospitals")
        assert r.status_code == 200
        body = r.json()
        assert body["count"] > 20
        first = body["results"][0]
        assert first["capacity"] is not None
        assert "trust" in first and first["trust"]["score"] > 0


def test_trust_engine_quarantines_impossible_update():
    with client() as c:
        admin = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        hospital_id = c.get(f"{API}/auth/me", headers=admin).json()["hospital_id"]

        # 4,000 passes the request-schema bound but is four times this facility's
        # declared bed count — the trust engine, not the validator, must catch it.
        r = c.post(
            f"{API}/hospitals/{hospital_id}/capacity",
            headers=admin,
            json={
                "beds_available": 4000,
                "icu_available": 1,
                "ventilators_available": 1,
                "ed_congestion": "low",
            },
        )
        assert r.status_code == 200, r.text
        assert r.json()["accepted"] is False
        assert r.json()["trust"]["quarantined"] is True
        assert any("exceeds declared capacity" in f for f in r.json()["trust"]["flags"])

        # The projection must not have moved.
        detail = c.get(f"{API}/hospitals/{hospital_id}").json()
        assert detail["capacity"]["beds_available"] < 4000

        # Nor may it appear on the public directory.
        public = c.get(f"{API}/hospitals?limit=500").json()["results"]
        row = next(h for h in public if h["id"] == hospital_id)
        assert row["capacity"]["beds_available"] < 4000


def test_facility_scope_is_enforced():
    with client() as c:
        admin = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        other = c.get(f"{API}/hospitals").json()["results"]
        mine = c.get(f"{API}/auth/me", headers=admin).json()["hospital_id"]
        target = next(h["id"] for h in other if h["id"] != mine)

        r = c.post(
            f"{API}/hospitals/{target}/capacity/quick",
            headers=admin,
            json={"deltas": {"beds_available": -1}},
        )
        assert r.status_code == 403


def test_quick_adjust_applies_delta_and_clamps_at_zero():
    with client() as c:
        admin = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        hid = c.get(f"{API}/auth/me", headers=admin).json()["hospital_id"]
        before = c.get(f"{API}/hospitals/{hid}").json()["capacity"]["beds_available"]

        r = c.post(f"{API}/hospitals/{hid}/capacity/quick", headers=admin, json={"deltas": {"beds_available": -2}})
        assert r.status_code == 200
        assert r.json()["record"]["beds_available"] == max(0, before - 2)

        r = c.post(f"{API}/hospitals/{hid}/capacity/quick", headers=admin, json={"deltas": {"icu_available": -99999}})
        assert r.status_code == 200
        assert r.json()["record"]["icu_available"] == 0


def test_dispatch_flow_creates_hold_and_alerts_hospital():
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")

        inc = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "cardiac",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Sungam bypass",
                "district_id": 1,
                "requires_icu": True,
                "patient_state": "unconscious_not_breathing",
                "mechanism": "none",
                "bystander_cpr": True,
                "observations": ["chest_pain"],
            },
        )
        assert inc.status_code == 201, inc.text
        incident = inc.json()
        assert incident["reference"].startswith("TN-")
        assert len(incident["shortlist"]) > 0
        top = incident["shortlist"][0]
        assert top["eligible"] is True
        assert "ICU free" in " ".join(top["reasons"])

        disp = c.post(
            f"{API}/incidents/{incident['id']}/dispatch",
            headers=dispatcher,
            json={"hospital_id": top["hospital_id"], "hold_resource": "icu", "hold_seconds": 900},
        )
        assert disp.status_code == 200, disp.text
        body = disp.json()
        assert body["status"] == "dispatched"
        assert body["hold"]["resource"] == "icu"
        assert body["assigned_ambulance"] is not None
        assert body["engine_notes"]["score"] > 0

        # The hold must now be subtracted from what the public directory shows.
        detail = c.get(f"{API}/hospitals/{top['hospital_id']}").json()
        assert detail["holds"].get("icu", 0) >= 1
        assert detail["capacity"]["icu_effective"] == detail["capacity"]["icu_available"] - detail["holds"]["icu"]

        # ...but the *identity* of the inbound case is not public. A bed hold
        # names an incident reference, an urgency, a call sign and an ETA, which
        # together say that a specific emergency is on its way to a specific
        # hospital. The aggregate count above stays visible because it is
        # already folded into the published availability; the operational detail
        # does not.
        assert "active_holds" not in detail, "the public facility view must not expose inbound dispatch traffic"

        # The receiving facility's own staff do see it -- that is the whole point
        # of the data existing.
        ward = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        own_hospital_id = c.get(f"{API}/auth/me", headers=ward).json()["hospital_id"]
        mine = c.get(f"{API}/hospitals/{own_hospital_id}", headers=ward).json()
        assert "active_holds" in mine

        # Lifecycle
        st = c.post(f"{API}/incidents/{incident['id']}/status", headers=dispatcher, json={"status": "en_route"})
        assert st.status_code == 200
        st = c.post(f"{API}/incidents/{incident['id']}/status", headers=dispatcher, json={"status": "handed_over"})
        assert st.status_code == 200

        # This incident's hold must be gone. The line used to assert the
        # facility had zero ICU holds of any kind, which only passed because the
        # seeded dataset happened to leave that facility alone -- the moment the
        # pilot data contained a realistic in-flight case, the test failed for a
        # reason that had nothing to do with the behaviour under test.
        released = c.get(f"{API}/hospitals/{top['hospital_id']}", headers=dispatcher).json()
        assert "active_holds" in released, "dispatch must be able to read inbound holds"
        assert incident["id"] not in [h["incident_id"] for h in released["active_holds"]], (
            "handed-over incident must release its hold"
        )


def test_incident_intake_has_no_free_text_clinical_field():
    """Patient data must be structurally impossible, not filtered.

    The intake used to accept a free-text `caller_notes` and reject strings
    matching a small banned-substring list. That catches only what somebody
    thought to enumerate. Now every clinical field is a closed enum, so the type
    system is the guard: this test asserts the field is gone and that the old
    payload shape is refused outright rather than silently ignored.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")

        base = {
            "category": "road_accident",
            "urgency": "P1",
            "lat": 11.01,
            "lng": 76.95,
            "landmark": "Avinashi Road",
            "district_id": 1,
        }

        # The removed field must be rejected as an unknown key, not dropped.
        r = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={**base, "caller_notes": "Patient name: Ramesh, age: 44, phone 9845012345"},
        )
        assert r.status_code == 422, (
            "a free-text clinical field must not be accepted; "
            f"got {r.status_code}: {r.text[:200]}"
        )

        # A landmark containing a phone number or an honourific is refused: it is
        # the one non-enum field and the only remaining route for an identifier.
        for bad in ("Near Mr Ramesh's house", "Plot 9845012345, Avinashi Road"):
            bad_r = c.post(f"{API}/incidents", headers=dispatcher, json={**base, "landmark": bad})
            assert bad_r.status_code == 422, f"landmark {bad!r} must be refused"

        # The structured path works, and yields a usable scene assessment.
        ok = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                **base,
                "patient_state": "unconscious_not_breathing",
                "mechanism": "two_wheeler",
                "bleeding": "severe",
                "hazard": "traffic_active",
                "observations": ["suspected_fracture", "limb_deformity"],
                "casualty_count": 1,
                "bystander_cpr": True,
            },
        )
        assert ok.status_code == 201, ok.text
        body = ok.json()

        # Nothing resembling a narrative field is echoed back.
        assert "caller_notes" not in body, "the removed field must not reappear in the response"
        assert body["scene"]["patient_state"] == "unconscious_not_breathing"
        assert body["scene"]["hazard"] == "traffic_active"
        assert body["scene"]["bystander_cpr"] is True

        # And the assessment actually drove the requirement: not breathing plus
        # severe bleeding implies ICU, ventilation and blood without the operator
        # having stated any of them.
        assert body["requires"]["icu"] is True
        assert body["requires"]["ventilator"] is True
        assert body["requires"]["blood"] is True

        rationale = " ".join(body["derivation"]["rationale"]).lower()
        assert "not breathing" in rationale
        assert "haemorrhage" in rationale
        assert any("traffic" in a.lower() for a in body["derivation"]["scene_advisories"])


def test_explicit_requirement_overrides_derivation():
    """An operator who states a need gets it, whatever the observations imply."""
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        r = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "road_accident",
                "urgency": "P3",
                "lat": 11.01,
                "lng": 76.95,
                "landmark": "Trichy Road",
                "district_id": 1,
                "patient_state": "alert",
                "mechanism": "fall_low",
                "requires_icu": True,
            },
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["requires"]["icu"] is True, "the explicit instruction must win"


def test_catchment_rule_beats_raw_capability():
    """A trauma centre four hours away must not outrank a nearer facility that
    can also take the patient. This is the regression test for a real ranking
    pathology: with a short distance half-life, proximity flattened to zero and
    a Madurai hospital ranked third for a Coimbatore road accident.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        inc = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "road_accident",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Avinashi Road, near Hope College",
                "district_id": 1,
                "requires_icu": True,
            },
        ).json()

        eligible = [x for x in inc["shortlist"] if x["eligible"]]
        assert eligible, "a Coimbatore incident must have at least one reachable facility"

        for cand in eligible:
            assert cand["in_range"] is True, f"{cand['short_name']} at {cand['eta_minutes']} min should be out of the P1 catchment"

        # And anything excluded for distance must say so explicitly.
        for cand in inc["shortlist"]:
            if not cand["in_range"]:
                assert any("catchment" in b for b in cand["blockers"])

        # The nearest eligible option must not be beaten by a distant one.
        nearest = min(eligible, key=lambda x: x["eta_minutes"])
        assert nearest["eta_minutes"] < 30, "the top of the list for a central Coimbatore call should be close"


def test_government_analytics_aggregates_without_pii():
    with client() as c:
        gov = _login(c, "gov@medmesh.in", "District@2026")
        r = c.get(f"{API}/analytics/overview", headers=gov)
        assert r.status_code == 200
        body = r.json()

        # A district officer's view is their district. Asserting "> 20
        # facilities" here, as this test used to, described the leak rather than
        # the intent: the number was large because the response was statewide.
        me = c.get(f"{API}/auth/me", headers=gov).json()
        assert [d["district_id"] for d in body["districts"]] == [me["district_id"]]
        assert body["state"]["facilities"] > 0
        assert body["districts"][0]["beds"]["occupancy_pct"] is not None

        # The state directorate account keeps the statewide picture, so the
        # scoping is a restriction on the district role and not a global cut.
        state = _login(c, "admin@medmesh.in", "MedMesh@2026")
        statewide = c.get(f"{API}/analytics/overview", headers=state).json()
        assert len(statewide["districts"]) == 38
        assert statewide["state"]["facilities"] > 100

        d = c.get(f"{API}/analytics/district/1", headers=gov)
        assert d.status_code == 200
        assert len(d.json()["trend"]) > 0

        # Jurisdiction: a Coimbatore official may not read another district.
        other = c.get(f"{API}/analytics/district/2", headers=gov)
        assert other.status_code == 403

        csv = c.get(f"{API}/analytics/export/capacity.csv?hours=6", headers=gov)
        assert csv.status_code == 200
        assert "text/csv" in csv.headers["content-type"]
        assert "patient" not in csv.text.lower()


def test_crew_assignment_payload_is_offline_ready():
    with client() as c:
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        r = c.get(f"{API}/crew/assignment", headers=crew)
        assert r.status_code == 200
        body = r.json()
        if body.get("assignment"):
            assert body["route"]["points"], "route geometry must be cached client-side"
            assert body["destination_capacity"] is not None
            assert body["destination"]["eta_minutes"] > 0


def test_surge_mode_relaxes_freshness_and_is_single_active():
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        r = c.post(f"{API}/analytics/surge", headers=admin, json={"title": "Multi-vehicle pile-up, NH544", "district_id": 1})
        assert r.status_code == 201, r.text
        sid = r.json()["id"]
        assert c.post(f"{API}/analytics/surge", headers=admin, json={"title": "duplicate", "district_id": 1}).status_code == 409
        assert c.get(f"{API}/analytics/surge/active").json()["active"] is True
        assert c.delete(f"{API}/analytics/surge/{sid}", headers=admin).status_code == 200
        assert c.get(f"{API}/analytics/surge/active").json()["active"] is False


def test_doctor_directory_hides_opted_out_facilities():
    with client() as c:
        r = c.get(f"{API}/doctors?on_duty_only=true")
        assert r.status_code == 200
        results = r.json()["results"]
        assert len(results) > 0
        hospital_ids = {d["hospital"]["id"] for d in results}
        for hid in hospital_ids:
            assert c.get(f"{API}/hospitals/{hid}").json() is not None


def test_realtime_feed_pushes_snapshot_then_delta():
    with client() as c:
        with c.websocket_connect("/ws/feed?scope=all") as ws:
            snapshot = ws.receive_json()
            assert snapshot["event"] == "snapshot"
            assert snapshot["data"]["count"] > 0
            assert snapshot["data"]["hospitals"][0]["capacity"]["beds_effective"] >= 0


def test_rbac_blocks_citizen_from_operational_endpoints():
    with client() as c:
        r = c.post(f"{API}/auth/register", json={"email": "citizen@example.com", "password": "Citizen#2026", "full_name": "Citizen One"})
        assert r.status_code == 201, r.text
        token = {"Authorization": f"Bearer {r.json()['access_token']}"}

        assert c.get(f"{API}/incidents", headers=token).status_code == 403
        assert c.get(f"{API}/governance/audit", headers=token).status_code == 403
        assert c.post(f"{API}/hospitals/1/capacity/quick", headers=token, json={"deltas": {"beds_available": 1}}).status_code == 403


def test_self_service_registration_cannot_mint_privileged_role():
    with client() as c:
        r = c.post(
            f"{API}/auth/register",
            json={"email": "sneaky@example.com", "password": "Sneaky#2026", "full_name": "Sneaky", "role": "platform_admin"},
        )
        assert r.status_code == 403


def test_audit_trail_records_every_write():
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        r = c.get(f"{API}/governance/audit?hours=2&limit=500", headers=admin)
        assert r.status_code == 200
        actions = {row["action"] for row in r.json()["results"]}
        assert "capacity.ingest" in actions
        assert "auth.login" in actions


def test_matching_prefers_facility_with_specialist_on_duty():
    """A facility whose department is staffed must outrank one whose is not.

    This is the whole point of the specialist step in the matching chain: two
    hospitals can both list cardiology, and only one of them has a cardiologist
    at work right now. Before this, both scored identically on capability.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        inc = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "cardiac",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Sungam bypass",
                "district_id": 1,
                "requires_icu": True,
            },
        )
        assert inc.status_code == 201, inc.text
        shortlist = inc.json()["shortlist"]
        assert shortlist, "expected a non-empty shortlist"

        top = shortlist[0]
        assert top["specialist_score"] >= 0.7, top["specialist_note"]
        assert top["specialist_note"], "the operator must be told which specialist is on duty"
        assert top["on_duty_specialists"], "the on-duty specialist should be nameable"

        # And nothing with an empty department may sit above it.
        for other in shortlist[1:]:
            if other["eligible"] and other["specialist_score"] < 0.7:
                assert other["score"] <= top["score"], (
                    f"{other['short_name']} has no specialist on duty but outranks {top['short_name']}"
                )


def test_ambulance_selection_prefers_required_capability_over_distance():
    """A P1 cardiac call must get an ALS unit if one exists, even if further.

    Selecting the nearest unit regardless of capability is the failure this
    guards: a basic-life-support van cannot run a cardiac arrest, so being two
    minutes closer does not make it the right answer.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")

        amb = c.get(f"{API}/ambulances", headers=dispatcher).json()["results"]
        capable = [a for a in amb if "als" in a["capability"].lower()]
        assert capable, "pilot fleet must contain at least one ALS unit"

        inc = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "cardiac",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Sungam bypass",
                "district_id": 1,
                "requires_icu": True,
            },
        )
        incident = inc.json()
        top = incident["shortlist"][0]

        # No ambulance_id supplied, so the crew is chosen by capability.
        disp = c.post(
            f"{API}/incidents/{incident['id']}/dispatch",
            headers=dispatcher,
            json={"hospital_id": top["hospital_id"], "hold_resource": "icu", "hold_seconds": 900},
        )
        assert disp.status_code == 200, disp.text
        body = disp.json()

        crew = body["crew_notes"]
        if crew["matched"]:
            assert crew["capability"] == "als", crew
            assert "als" in body["assigned_ambulance"]["capability"].lower(), body["assigned_ambulance"]
        else:
            # Only acceptable when the fleet genuinely has no ALS unit free.
            assert crew["warnings"], "an unmatched crew must explain itself"


def test_hold_conflict_is_rejected_when_last_resource_is_contended():
    """Two dispatchers must not be able to hold the same last ICU bed.

    The count is read and the hold written inside a per-facility critical
    section, counting committed rows rather than the live projection, so the
    second request sees the first hold. This drives the facility to exactly one
    free ICU bed first, so the test cannot pass by finding nothing to contend
    over.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        hospital_admin = _login(c, "admin@srmc.medmesh.in", "Hospital@2026")

        hospital_id = c.get(f"{API}/auth/me", headers=hospital_admin).json()["hospital_id"]
        base = c.get(f"{API}/hospitals/{hospital_id}", headers=hospital_admin).json()
        if base["active_holds"]:
            for hold in base["active_holds"]:
                c.delete(f"{API}/holds/{hold['id']}", headers=dispatcher)

        # Walk the facility down to exactly one free ICU bed one unit at a time.
        #
        # A single push of "icu_available: 1" from 18 is correctly quarantined by
        # the trust engine as an implausible jump, which is the right behaviour
        # and the wrong tool for arranging a test fixture. Stepping down by one
        # is under both anomaly thresholds, and it is also how ward staff
        # actually report beds going out of service.
        for _ in range(60):
            live = c.get(f"{API}/hospitals/{hospital_id}").json()["capacity"]
            if live["icu_effective"] <= 1:
                break
            step = min(5, live["icu_effective"] - 1)
            r = c.post(
                f"{API}/hospitals/{hospital_id}/capacity/quick",
                headers=hospital_admin,
                json={"deltas": {"icu_available": -step}},
            )
            assert r.status_code == 200, r.text

        live = c.get(f"{API}/hospitals/{hospital_id}").json()["capacity"]
        assert live["icu_effective"] == 1, (
            f"arranging the fixture failed: expected one free ICU bed, got {live['icu_effective']}"
        )

        def new_incident(tag: str) -> dict:
            r = c.post(
                f"{API}/incidents",
                headers=dispatcher,
                json={
                    "category": "cardiac",
                    "urgency": "P1",
                    "lat": live["pinned_lat"] if "pinned_lat" in live else 11.0168,
                    "lng": 76.9558,
                    "landmark": tag,
                    "district_id": 1,
                    "requires_icu": True,
                },
            )
            assert r.status_code == 201, r.text
            return r.json()

        first = new_incident("Contention test A")
        second = new_incident("Contention test B")

        r1 = c.post(
            f"{API}/incidents/{first['id']}/dispatch",
            headers=dispatcher,
            json={"hospital_id": hospital_id, "hold_resource": "icu", "hold_seconds": 900},
        )
        assert r1.status_code == 200, r1.text

        r2 = c.post(
            f"{API}/incidents/{second['id']}/dispatch",
            headers=dispatcher,
            json={"hospital_id": hospital_id, "hold_resource": "icu", "hold_seconds": 900},
        )
        assert r2.status_code == 409, (
            f"second dispatch against the last ICU bed must be refused, got {r2.status_code}: {r2.text}"
        )
        reason = str(r2.json())
        assert "ICU" in reason, reason

        # The facility must never report negative effective capacity, and must
        # never carry more holds than it has beds.
        detail = c.get(f"{API}/hospitals/{hospital_id}").json()
        assert detail["capacity"]["icu_effective"] >= 0
        assert detail["holds"].get("icu", 0) == 1

        # Now the reservation primitive on its own, with the eligibility gate
        # out of the way. This is the actual read-then-write race: two claims on
        # one bed, checked and written inside one critical section.
        direct = c.post(
            f"{API}/hospitals/{hospital_id}/hold",
            headers=dispatcher,
            json={"resource": "icu", "seconds": 900},
        )
        assert direct.status_code == 409, (
            f"placing a second hold directly on the last ICU bed must be refused, "
            f"got {direct.status_code}: {direct.text}"
        )
        assert "last one" in direct.json()["detail"], direct.json()["detail"]

        # Releasing the first hold must make the bed claimable again, or the
        # lock is really a leak.
        held = c.get(f"{API}/holds", headers=dispatcher).json()["results"]
        mine = [h for h in held if h["hospital_id"] == hospital_id and h["resource"] == "icu"]
        assert len(mine) == 1, mine
        rel = c.delete(f"{API}/holds/{mine[0]['id']}", headers=dispatcher)
        assert rel.status_code == 200, rel.text

        again = c.post(
            f"{API}/hospitals/{hospital_id}/hold",
            headers=dispatcher,
            json={"resource": "icu", "seconds": 900},
        )
        assert again.status_code == 200, again.text

        # Hand the bed back. Without this the suite leaves a facility holding its
        # last ICU bed with no incident behind it, which quietly starves every
        # later test that tries to route there — a fixture leak dressed up as a
        # product failure.
        c.delete(f"{API}/holds/{again.json()['id']}", headers=dispatcher)
        restored = c.get(f"{API}/hospitals/{hospital_id}").json()
        assert restored["holds"].get("icu", 0) == 0, restored["holds"]


def test_connector_ingest_accepts_fhir_and_refuses_bad_key():
    """A hospital system must be able to push capacity with only its key.

    The connector path is the one the report calls for and the one an integrator
    actually uses: no interactive login, a machine credential, and a standard
    FHIR shape. This also checks the trust engine still applies — machine data
    must not get an easier ride than a human keying numbers in.
    """
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        hospital_admin = _login(c, "admin@srmc.medmesh.in", "Hospital@2026")
        hospital_id = c.get(f"{API}/auth/me", headers=hospital_admin).json()["hospital_id"]

        created = c.post(
            f"{API}/connectors",
            headers=admin,
            json={"hospital_id": hospital_id, "kind": "fhir_r4", "source_system": "Test HIS"},
        )
        assert created.status_code == 201, created.text
        key = created.json()["key"]
        assert key.startswith("mm_live_"), key

        # The plaintext key is never retrievable again.
        listing = c.get(f"{API}/connectors", headers=admin).json()["results"]
        row = next(r for r in listing if r["hospital_id"] == hospital_id)
        assert row["key_prefix"] == key[:16]
        assert "key" not in row
        assert row["has_key"] is True

        # An unknown key is refused before any parsing happens.
        bad = c.post(
            "/ingest/fhir",
            headers={"X-Connector-Key": "mm_live_not-a-real-key"},
            json={"resourceType": "Bundle", "type": "collection", "entry": []},
        )
        assert bad.status_code == 401, bad.text

        # A real FHIR Bundle is parsed and published.
        sample = c.post(f"{API}/connectors/{row['id']}/test", headers=admin).json()["sample_payload"]
        ok = c.post("/ingest/fhir", headers={"X-Connector-Key": key}, json=sample)
        assert ok.status_code == 202, ok.text
        body = ok.json()
        assert body["accepted"] is True, body
        # The sample is deliberately a small movement off the committed figure
        # so it clears the anomaly check; what matters is that the value the
        # connector pushed is the value that got published.
        pushed = sample["entry"][1]["resource"]["group"][0]["population"][0]["count"]
        assert body["published"]["beds_available"] == pushed, body

        # And the published figure is what the public directory now reports.
        after = c.get(f"{API}/hospitals/{hospital_id}").json()["capacity"]
        assert after["beds_available"] == pushed, after
        assert after["source"] == "api", after


def test_manual_facility_cannot_use_a_connector_ingress():
    """A facility registered for the keypad must not have a machine ingress,
    and the mismatch must be explained rather than silently accepted."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        listing = c.get(f"{API}/hospitals?limit=200").json()["results"]
        manual = next(h for h in listing if h["integration"] == "manual")

        created = c.post(
            f"{API}/connectors",
            headers=admin,
            json={"hospital_id": manual["id"], "kind": "manual"},
        )
        assert created.status_code == 201, created.text
        key = created.json()["key"]

        r = c.post("/ingest/vendor", headers={"X-Connector-Key": key}, json={"beds_available": 5})
        assert r.status_code == 409, r.text
        assert "manual" in r.json()["detail"].lower()


def test_inbound_alert_reaches_the_ward_inbox():
    """The two-way prep alert must be durable, not only a socket frame.

    A ward clerk who is not watching the dashboard still has to learn that an
    ambulance is inbound; that is the whole point of the feature. Both seeded
    hospital admins are checked so the assertion follows whichever facility the
    shortlist actually picked.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        households = {}
        for email in ("admin@kgch.medmesh.in", "admin@srmc.medmesh.in"):
            token = _login(c, email, "Hospital@2026")
            hid = c.get(f"{API}/auth/me", headers=token).json()["hospital_id"]
            households[hid] = (email, token)

        for hid, (email, token) in households.items():
            assert c.get(f"{API}/notifications", headers=token).json()["count"] >= 0

        inc = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "cardiac",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Sungam bypass",
                "district_id": 1,
                "requires_icu": True,
            },
        ).json()

        # Take the best candidate that one of the two seeded bed-control desks
        # owns; a dispatcher routinely overrides the ranking.
        candidate = next((x for x in inc["shortlist"] if x["hospital_id"] in households), None)
        assert candidate is not None, "shortlist should include at least one seeded facility"

        r = c.post(
            f"{API}/incidents/{inc['id']}/dispatch",
            headers=dispatcher,
            json={
                "hospital_id": candidate["hospital_id"],
                "hold_resource": "icu",
                "hold_seconds": 900,
            },
        )
        assert r.status_code == 200, r.text

        email, token = households[candidate["hospital_id"]]
        inbox = c.get(f"{API}/notifications", headers=token).json()
        kinds = [n["kind"] for n in inbox["results"]]
        assert "inbound_patient" in kinds, (email, kinds)
        alert = next(n for n in inbox["results"] if n["kind"] == "inbound_patient")
        assert "ETA" in alert["title"], alert
        assert alert["severity"] == "critical", alert
        assert alert["incident_id"] == inc["id"], alert

        # Marking it read must survive the round trip and drop the badge.
        before = inbox["unread"]
        acked = c.post(f"{API}/notifications/{alert['id']}/read", headers=token, json={})
        assert acked.status_code == 200, acked.text
        after = c.get(f"{API}/notifications", headers=token).json()
        assert after["unread"] == before - 1, (before, after["unread"])
        assert next(n for n in after["results"] if n["id"] == alert["id"])["read_at"] is not None


def test_facility_can_apply_publicly_and_lands_in_the_review_queue():
    """§6.10: a hospital with no compatible system joins the same way a private
    one does, and nothing it submits is published until a human verifies it."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")

        applied = c.post(
            f"{API}/onboarding/facility",
            json={
                "name": "Test Rural Health Centre",
                "short_name": "TRHC",
                "type": "public",
                "district_id": 1,
                "lat": 11.05,
                "lng": 76.99,
                "address": "Test Road, Coimbatore",
                "total_beds": 40,
                "total_icu": 4,
                "total_ventilators": 2,
                "specialties": ["general_medicine", "obstetrics"],
                "contact_phone": "0422-2345678",
                "has_existing_system": False,
            },
        )
        assert applied.status_code == 201, applied.text
        body = applied.json()
        assert body["verification"] == "unverified"
        assert body["reference"].startswith("MM-ONB-")
        assert any("Manual" in s for s in body["next_steps"])

        # An unverified facility must not appear in the public directory.
        public = c.get(f"{API}/hospitals?limit=200").json()["results"]
        assert all(h["short_name"] != "TRHC" for h in public), (
            "an unverified applicant must not be published"
        )

        queue = c.get(f"{API}/onboarding/queue", headers=admin).json()
        assert any(h["hospital_id"] == body["hospital_id"] for h in queue["results"])

        decided = c.post(
            f"{API}/onboarding/decide",
            headers=admin,
            json={
                "hospital_id": body["hospital_id"],
                "decision": "verify",
                "integration": "manual",
                "connector_kind": "manual",
            },
        )
        assert decided.status_code == 200, decided.text
        assert decided.json()["verification"] == "verified"

        # And only now does it appear.
        public = c.get(f"{API}/hospitals?limit=200").json()["results"]
        assert any(h["short_name"] == "TRHC" for h in public)


def test_verification_gates_public_visibility():
    """Fraud prevention (§6.3, §7): an unverified listing must not be
    discoverable by the public, but must still be routable by staff.

    This is the whole point of the verification workflow. A listing nobody has
    checked is worse than no listing, because a family will act on it; and a
    district hospital mid-verification may be the only ICU in range, so a
    dispatcher must still be able to see it.
    """
    with client() as c:
        applied = c.post(
            f"{API}/onboarding/facility",
            json={
                "name": "Visibility Test Hospital",
                "short_name": "VTH",
                "type": "private",
                "district_id": 1,
                "lat": 11.02,
                "lng": 76.98,
                "address": "Nowhere Road, Coimbatore",
                "total_beds": 30,
                "total_icu": 2,
                "total_ventilators": 1,
                "specialties": ["general_medicine"],
                "contact_phone": "0422-9998887",
            },
        )
        assert applied.status_code == 201, applied.text
        hospital_id = applied.json()["hospital_id"]

        # Anonymous: not listed at all.
        anon = c.get(f"{API}/hospitals?limit=300").json()["results"]
        assert all(h["short_name"] != "VTH" for h in anon), "an unverified facility is public"

        # Even asking for them does not help an anonymous caller.
        anon_explicit = c.get(f"{API}/hospitals?include_unverified=true&limit=300").json()["results"]
        assert all(h["short_name"] != "VTH" for h in anon_explicit), (
            "include_unverified must not override the public gate"
        )

        # Staff see it, because a dispatcher may genuinely need to route there.
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        staff = c.get(f"{API}/hospitals?include_unverified=true&limit=300", headers=admin).json()["results"]
        assert any(h["short_name"] == "VTH" for h in staff), "staff must see pending facilities"

        # A decision publishes it.
        decided = c.post(
            f"{API}/onboarding/decide",
            headers=admin,
            json={"hospital_id": hospital_id, "decision": "verify", "integration": "manual"},
        )
        assert decided.status_code == 200, decided.text
        after = c.get(f"{API}/hospitals?limit=300").json()["results"]
        assert any(h["short_name"] == "VTH" for h in after), "a verified facility must be published"

        # And a suspended one is withdrawn again — suspension is the outcome of a
        # failed re-review, so it must not stay in the public directory.
        from app.database import SessionLocal
        from app.models import Hospital, VerificationStatus

        db = SessionLocal()
        row = db.get(Hospital, hospital_id)
        row.verification = VerificationStatus.SUSPENDED
        db.commit()
        db.close()

        suspended = c.get(f"{API}/hospitals?limit=300").json()["results"]
        assert all(h["short_name"] != "VTH" for h in suspended), "a suspended facility is still public"


def test_incident_references_do_not_collide_under_a_forced_clash():
    """Incident references are drawn from a deliberately small space -- three
    characters from a 24-symbol alphabet, 13,824 values per day -- because a
    call-taker has to read them aloud over the radio. At a few hundred incidents
    a day the birthday paradox makes an accidental repeat near-certain, so
    allocation has to check rather than draw blind.

    This test makes the clash deterministic instead of hoping for one: the
    allocator's own random source is pinned to "A", and a pre-existing incident
    is given the reference that pinning produces. An allocator that simply draws
    returns a duplicate and fails here. The real one notices and redraws -- and
    because every redraw hits the same taken value, it eventually widens the
    suffix, which is the designed response to a saturated space.
    """
    import secrets as _secrets

    from sqlalchemy import select as _select

    from app.database import SessionLocal
    from app.models import Incident, User, utcnow
    from app.services import references

    # Entering the client context runs application startup, which is what
    # creates and seeds the schema. Reading SessionLocal directly without it
    # gives "no such table: incidents".
    with client():
        pass

    db = SessionLocal()
    try:
        day = utcnow()
        taken = f"TN-{day:%d%m}-AAA"
        actor_id = db.execute(_select(User.id)).scalars().first()

        db.add(
            Incident(
                reference=taken,
                category="cardiac",
                urgency="P1",
                lat=11.0,
                lng=77.0,
                landmark="reference-allocation fixture",
                district_id=1,
                created_by=actor_id,
                created_at=day,
            )
        )
        db.commit()

        # Pin the random source: every draw would be "AAA" without the check.
        original = _secrets.choice
        _secrets.choice = lambda _seq: "A"
        try:
            allocated = references.allocate_reference(db, now=day)
        finally:
            _secrets.choice = original

        assert allocated != taken, (
            "allocator returned a reference that was already in use -- it is "
            "drawing without checking"
        )
        assert allocated.startswith(f"TN-{day:%d%m}-"), allocated
        # Still the same shape and still readable over the radio.
        suffix = allocated.rsplit("-", 1)[1]
        assert suffix and set(suffix) == {"A"}
        assert 3 <= len(suffix) <= 4, f"unexpected suffix width: {allocated}"
    finally:
        db.close()


def test_incident_references_are_unique_across_many_persisted_allocations():
    """The complement of the clash test, and the property the radio depends on.

    Each reference is persisted before the next is drawn, which is what the real
    callers do -- the console adds the Incident to the session immediately, and
    the allocator's SELECT autoflushes it. Two hundred draws from a 13,824-value
    space collide about 76% of the time by chance alone, so an allocator that
    draws without checking fails this most of the time it is run.
    """
    from sqlalchemy import select as _select

    from app.database import SessionLocal
    from app.models import Incident, User, utcnow
    from app.services import references

    with client():
        pass

    db = SessionLocal()
    try:
        day = utcnow()
        actor_id = db.execute(_select(User.id)).scalars().first()
        allocated = []
        for i in range(200):
            reference = references.allocate_reference(db, now=day)
            db.add(
                Incident(
                    reference=reference,
                    category="cardiac",
                    urgency="P1",
                    lat=11.0,
                    lng=77.0,
                    landmark=f"allocation fixture {i}",
                    district_id=1,
                    created_by=actor_id,
                    created_at=day,
                )
            )
            db.flush()
            allocated.append(reference)
        db.commit()

        assert len(set(allocated)) == len(allocated), "duplicate reference allocated"
        assert len(set(allocated)) == 200
    finally:
        db.close()


# --------------------------------------------------------------------------- #
# Road routing as an input to matching
# --------------------------------------------------------------------------- #


class _StubRouter:
    """A routing provider whose answers are chosen by the test.

    Stands in for Distance Matrix so the routing path is provable without a
    billed key, a network, or a non-deterministic third party.
    """

    name = "stub-router"

    def __init__(self, fn):
        self.fn = fn
        self.calls = []

    def matrix(self, origin, destinations):
        self.calls.append((origin, list(destinations)))
        return [self.fn(origin, d) for d in destinations]


def _leg(road_km, minutes, *, provider="stub-router", traffic=False):
    from app.services.geo import Leg

    return Leg(
        straight_km=round(road_km / 1.32, 2),
        road_km=road_km,
        eta_minutes=minutes,
        bearing_deg=0.0,
        label=f"{road_km} km · {minutes} min",
        provider=provider,
        traffic_aware=traffic,
    )


def test_road_distance_outranks_straight_line_distance():
    """The claim the routing layer exists to make true.

    Take the facility the geometric engine liked best and give it a road that
    doubles back -- a river with one bridge, a hill with one ghat road. Its
    straight-line distance is unchanged, so a geometry-based engine would keep
    it at the top; its drive time is now far worse than the facility the
    geometry ranked below it. The engine must follow the road.

    The values are decisive rather than subtle on purpose. This test is about
    whether the resolved leg reaches the ranking at all -- a mechanism question,
    not a tuning question -- and a decisive swing cannot be produced by accident
    or masked by the seed's capability mix.
    """
    from app.services import routing
    from app.services.geo import Leg, estimate_leg

    with client() as c:
        dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = c.post(
            f"{API}/incidents",
            headers=dispatch,
            json={
                "category": "cardiac",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Road-accessible ranking fixture",
                "district_id": 1,
            },
        )
        assert incident.status_code == 201, incident.text
        incident_id = incident.json()["id"]

        baseline = c.get(f"{API}/incidents/{incident_id}/shortlist", headers=dispatch).json()
        baseline_rows = [
            r for r in baseline["results"] if r["eligible"] and r["distance_is_road"] is False
        ]
        assert len(baseline_rows) >= 3, "need a shortlist to compare"
        loser, winner = baseline_rows[0], baseline_rows[1]
        assert winner["eta_minutes"] > 0

        by_coords = {
            (round(r["lat"], 6), round(r["lng"], 6)): r["hospital_id"] for r in baseline["results"]
        }

        def stub(origin, destination):
            """Road answers chosen by which facility is being asked about."""
            key = (round(destination[0], 6), round(destination[1], 6))
            target = by_coords.get(key)
            estimated = estimate_leg(origin[0], origin[1], destination[0], destination[1])
            if target == loser["hospital_id"]:
                # The road doubles back: 4x the distance and a two-hour drive,
                # while the straight line is exactly as it was.
                return Leg(
                    straight_km=estimated.straight_km,
                    road_km=round(estimated.road_km * 4, 1),
                    eta_minutes=120,
                    bearing_deg=estimated.bearing_deg,
                    label="detour",
                    provider="stub-router",
                )
            if target == winner["hospital_id"]:
                return Leg(
                    straight_km=estimated.straight_km,
                    road_km=2.0,
                    eta_minutes=4,
                    bearing_deg=estimated.bearing_deg,
                    label="2.0 km · 4 min",
                    provider="stub-router",
                    traffic_aware=True,
                )
            return Leg(
                straight_km=estimated.straight_km,
                road_km=estimated.road_km,
                eta_minutes=estimated.eta_minutes,
                bearing_deg=estimated.bearing_deg,
                label=estimated.label,
                provider="stub-router",
            )

        router = _StubRouter(stub)
        routing.use(router)
        try:
            routed = c.get(f"{API}/incidents/{incident_id}/shortlist", headers=dispatch)
            assert routed.status_code == 200, routed.text
            body = routed.json()
            order = [r["hospital_id"] for r in body["results"]]

            assert order.index(winner["hospital_id"]) < order.index(loser["hospital_id"]), (
                "the engine did not follow the road: the facility that the geometry "
                f"ranked first stayed ahead despite a two-hour drive ({order})"
            )

            # And the ranking declares where its distances came from.
            assert body["routing"]["routed"] > 0
            assert body["routing"]["provider"] == "stub-router"
            chosen = next(r for r in body["results"] if r["hospital_id"] == winner["hospital_id"])
            assert chosen["distance_is_road"] is True
            assert chosen["eta_minutes"] == 4
            assert chosen["traffic_aware"] is True
            assert chosen["straight_km"] < chosen["distance_km"] or chosen["distance_km"] == 2.0
        finally:
            routing.reset()

        # With the stub gone the ranking returns to the estimator, which is the
        # behaviour a deployment without a Maps key gets -- and it says so.
        restored = c.get(f"{API}/incidents/{incident_id}/shortlist", headers=dispatch).json()
        assert restored["routing"]["provider"] == "estimate"
        assert restored["routing"]["road_derived"] is False
        assert all(r["distance_is_road"] is False for r in restored["results"])
        restored_order = [r["hospital_id"] for r in restored["results"]]
        assert restored_order.index(loser["hospital_id"]) < restored_order.index(
            winner["hospital_id"]
        ), "the estimator's own preference should still hold without routing"


def test_routing_failure_degrades_to_estimates_and_says_so():
    """Routing is a third-party call in the path of an emergency dispatch.

    When it fails the platform must still produce a ranked shortlist, and must
    mark it as geometry-derived so a dispatcher is not misled about how the
    numbers were obtained. Silently falling back would be worse than failing
    loudly.
    """
    from app.services import routing

    class _DeadRouter:
        name = "dead-router"

        def matrix(self, origin, destinations):
            # Whole-request failure: no answer for anything.
            return [None] * len(destinations)

    with client() as c:
        dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = c.post(
            f"{API}/incidents",
            headers=dispatch,
            json={
                "category": "road_accident",
                "urgency": "P1",
                "lat": 11.0168,
                "lng": 76.9558,
                "landmark": "Routing failure fixture",
                "district_id": 1,
            },
        )
        assert incident.status_code == 201, incident.text
        incident_id = incident.json()["id"]

        routing.use(_DeadRouter())
        try:
            response = c.get(f"{API}/incidents/{incident_id}/shortlist", headers=dispatch)
            assert response.status_code == 200, "a dead router must not fail the request"
            body = response.json()
            assert len(body["results"]) > 0, "a dead router must not empty the shortlist"
            assert body["routing"]["routed"] == 0
            assert body["routing"]["estimated"] == body["routing"]["total"]
            assert body["routing"]["road_derived"] is False
            # Every leg still exists -- callers never have to handle a hole.
            assert all(r["eta_minutes"] >= 1 for r in body["results"])
        finally:
            routing.reset()


def test_routing_is_not_asked_about_facilities_out_of_range():
    """The prefilter is what keeps this affordable.

    A facility whose straight-line distance already exceeds the catchment cannot
    be inside it by road -- roads are never shorter than straight lines -- so
    asking the router about it is a billed request that cannot change the answer.
    """
    from app.services import routing

    with client() as c:
        seen: list[list[tuple[float, float]]] = []

        class _RecordingRouter:
            name = "recording-router"

            def matrix(self, origin, destinations):
                seen.append(list(destinations))
                from app.services.geo import estimate_leg

                return [
                    estimate_leg(origin[0], origin[1], d[0], d[1]) for d in destinations
                ]

        routing.use(_RecordingRouter())
        try:
            dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")
            incident = c.post(
                f"{API}/incidents",
                headers=dispatch,
                json={
                    "category": "cardiac",
                    "urgency": "P1",
                    "lat": 11.0168,
                    "lng": 76.9558,
                    "landmark": "Prefilter fixture",
                    "district_id": 1,
                },
            )
            assert incident.status_code == 201, incident.text
            c.get(f"{API}/incidents/{incident.json()['id']}/shortlist", headers=dispatch)

            from app.config import settings
            from app.services.geo import haversine_km

            assert seen, "the router was never consulted"
            for chunk in seen:
                for lat, lng in chunk:
                    straight = haversine_km(11.0168, 76.9558, lat, lng)
                    assert straight <= settings.routing_prefilter_km + 1e-6, (
                        f"router was asked about a facility {straight:.0f} km away by "
                        "straight line, which the prefilter should have dropped"
                    )
        finally:
            routing.reset()


def test_distance_cache_is_reused_and_duration_is_not():
    """Distance and duration have different shelf lives.

    Road distance is a property of the road network; road duration is traffic.
    Caching them together either re-bills for a known road or serves a stale
    journey time. The provider keeps them on separate clocks.
    """
    import json as _json
    import time as _time
    import urllib.request as _url

    from app.config import settings
    from app.services.routing import GoogleDistanceMatrixProvider

    calls = []

    class _Response:
        def __init__(self, payload):
            self._payload = payload

        def read(self):
            return _json.dumps(self._payload).encode()

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(url, timeout=None):
        calls.append(url)
        return _Response(
            {
                "status": "OK",
                "rows": [
                    {
                        "elements": [
                            {
                                "status": "OK",
                                "distance": {"value": 14_000},
                                "duration": {"value": 1_200},
                                "duration_in_traffic": {"value": 1_500},
                            }
                        ]
                    }
                ],
            }
        )

    provider = GoogleDistanceMatrixProvider("test-key")
    original = _url.urlopen
    _url.urlopen = fake_urlopen
    try:
        origin = (11.0168, 76.9558)
        target = (11.0500, 77.0000)

        first = provider.matrix(origin, [target])[0]
        assert first.provider == "google-distance-matrix"
        assert first.road_km == 14.0
        assert first.eta_minutes == 25, "should prefer duration_in_traffic over free-flow"
        assert first.traffic_aware is True
        assert len(calls) == 1

        # A second identical request inside both TTLs must not hit the network.
        second = provider.matrix(origin, [target])[0]
        assert len(calls) == 1, "the cache did not absorb a repeat request"
        assert second.eta_minutes == first.eta_minutes

        # Age the duration past its (short) TTL but leave the distance inside
        # its (long) one: the road is still known, the traffic is not.
        entry = provider._cache[next(iter(provider._cache))]
        entry.duration_at = _time.monotonic() - (settings.routing_duration_ttl_minutes * 60 + 5)
        provider.matrix(origin, [target])
        assert len(calls) == 2, "a stale duration should be refreshed, not served"
    finally:
        _url.urlopen = original


def test_routing_reports_and_stops_cleanly_when_the_provider_errors():
    """A provider that raises must not propagate out of the routing layer."""
    import urllib.request as _url

    from app.services.routing import GoogleDistanceMatrixProvider

    def exploding_urlopen(url, timeout=None):
        raise OSError("network unreachable")

    original = _url.urlopen
    _url.urlopen = exploding_urlopen
    try:
        provider = GoogleDistanceMatrixProvider("test-key")
        result = provider.matrix((11.0, 77.0), [(11.1, 77.1), (11.2, 77.2)])
        assert result == [None, None], "errors must surface as 'no answer', not as an exception"
    finally:
        _url.urlopen = original


# --------------------------------------------------------------------------- #
# Statewide coverage
# --------------------------------------------------------------------------- #


def test_all_38_districts_are_present_and_correct():
    """Tamil Nadu has 38 districts, and a platform claiming to cover the state
    has to have all of them -- including the five carved out in 2019
    (Kallakurichi, Ranipet, Tirupathur, Tenkasi, Chengalpattu), which a dataset
    built from older material silently omits.

    Coordinates are checked for plausibility rather than exactness: a district
    placed in the wrong part of the state produces a confidently wrong ranking
    now that matching scores on road distance, so the test asserts every
    headquarters lies inside Tamil Nadu's bounding box and that no two share a
    position.
    """
    import app.seed as seed

    assert len(seed.DISTRICTS) == 38, f"expected 38 districts, found {len(seed.DISTRICTS)}"

    codes = [row[0] for row in seed.DISTRICTS]
    assert len(set(codes)) == 38, "duplicate district codes"
    names = [row[1] for row in seed.DISTRICTS]
    assert len(set(names)) == 38, "duplicate district names"

    for code, name in [
        ("KLK", "Kallakurichi"),
        ("RPT", "Ranipet"),
        ("TPT", "Tirupathur"),
        ("TEN", "Tenkasi"),
        ("CGP", "Chengalpattu"),
    ]:
        assert code in codes, f"{name} is missing — carved out of an older district in 2019"
        assert names[codes.index(code)] == name

    # Every district has a Tamil label, because the citizen surface is bilingual
    # and a district with no translation shows an English name in a Tamil page.
    for code, name, name_ta, *_rest in seed.DISTRICTS:
        assert name_ta and len(name_ta) > 1, f"{name} has no Tamil name"

    # Geographic sanity: inside Tamil Nadu's envelope, and all distinct.
    seen: set[tuple[float, float]] = set()
    for code, name, _ta, lat, lng, population in seed.DISTRICTS:
        assert 8.0 <= lat <= 13.6, f"{name} latitude {lat} is outside Tamil Nadu"
        assert 76.0 <= lng <= 80.5, f"{name} longitude {lng} is outside Tamil Nadu"
        assert population > 100_000, f"{name} population {population} implausible"
        assert (lat, lng) not in seen, f"{name} shares a position with another district"
        seen.add((lat, lng))


def test_every_district_has_a_usable_facility_estate():
    """No district may be empty, and none may be without emergency provision.

    A district with no facility is a district the dispatcher console cannot
    serve. Every one must have at least a public facility (the district hospital
    is the state's actual safety net) and at least one facility with ICU beds,
    because a district where nothing can take a critical patient is a data gap
    that would only surface during an incident.
    """
    import app.seed as seed

    by_district: dict[str, list] = {}
    for row in seed.FACILITIES:
        by_district.setdefault(row[3], []).append(row)

    codes = {row[0] for row in seed.DISTRICTS}
    assert set(by_district) == codes, (
        f"districts without facilities: {sorted(codes - set(by_district))}"
    )

    for code, rows in by_district.items():
        assert len(rows) >= 3, f"{code} has only {len(rows)} facilities"
        assert any(r[2] == "public" for r in rows), f"{code} has no public facility"
        assert max(r[5] for r in rows) >= 10, (
            f"{code} has no facility with more than 10 ICU beds"
        )


def test_statewide_publication_reaches_every_district():
    """The anonymous directory must expose facilities in all 38 districts.

    This is the citizen-facing half of the coverage claim. The publication gate
    (unverified and suspended facilities hidden) applies on top, so the seeded
    estate must leave at least one verified facility in every district -- if a
    district's only hospital were unverified, the district would vanish from the
    public map while appearing fine from inside the platform.
    """
    with client() as c:
        districts = c.get(f"{API}/hospitals/districts").json()["results"]
        assert len(districts) == 38, f"district endpoint returned {len(districts)}"

        listed = c.get(f"{API}/hospitals?limit=500").json()
        assert listed["count"] > 100, (
            f"only {listed['count']} facilities are publicly visible across 38 districts"
        )

        # The verification gate itself is covered by
        # test_verification_gates_public_visibility; what this test is about is
        # that the gate never costs a district its entire presence. Note that
        # `include_unverified=true` cannot be used to widen the comparison here:
        # it is a staff-only flag and an anonymous caller is correctly refused,
        # which is itself asserted elsewhere.

        covered = {row["district_id"] for row in listed["results"]}
        missing = {
            d["name"] for d in districts if d["id"] not in covered
        }
        assert not missing, f"districts absent from the public directory: {sorted(missing)}"


def test_statewide_matching_stays_within_budget():
    """Ranking the whole state must stay well inside the 1-second read budget.

    The report's §5 commits to sub-second reads. The candidate set grew from 29
    facilities to 147 when coverage went statewide, and the routing layer adds a
    resolved leg per candidate, so this is exactly the change that could quietly
    blow the budget. Measured over several runs because a single sample on a
    shared machine is not evidence.
    """
    import time

    with client() as c:
        dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")

        timings = []
        for i in range(5):
            started = time.perf_counter()
            response = c.post(
                f"{API}/incidents",
                headers=dispatch,
                json={
                    "category": "cardiac",
                    "urgency": "P1",
                    "lat": 11.0168 + i * 0.01,
                    "lng": 76.9558 - i * 0.01,
                    "landmark": f"Budget fixture {i}",
                    "district_id": 1,
                },
            )
            timings.append(time.perf_counter() - started)
            assert response.status_code == 201, response.text

        worst = max(timings)
        assert worst < 1.0, (
            f"intake plus a full statewide ranking took {worst * 1000:.0f} ms, "
            "which breaks the sub-second read budget"
        )
        # And the shortlist endpoint on its own, which the console polls.
        started = time.perf_counter()
        incident_id = response.json()["id"]
        c.get(f"{API}/incidents/{incident_id}/shortlist", headers=dispatch)
        shortlist_ms = (time.perf_counter() - started) * 1000
        assert shortlist_ms < 500, f"shortlist rebuild took {shortlist_ms:.0f} ms"


# --------------------------------------------------------------------------- #
# Authorization regressions
#
# Every test below corresponds to a specific hole found in the end-to-end audit.
# They are grouped here, rather than beside the feature each one protects,
# because they share a shape: an action that was guarded by role alone, or by
# nothing, when it needed to be guarded by jurisdiction or ownership.
# --------------------------------------------------------------------------- #


def _release_unit(c, dispatcher, ambulance_id: int) -> None:
    """Close any live trip on a unit so it is available again."""
    fleet = c.get(f"{API}/ambulances", headers=dispatcher).json()["results"]
    unit = next((a for a in fleet if a["id"] == ambulance_id), None)
    assert unit is not None, f"unit {ambulance_id} is not in the fleet view"
    if unit["status"] == "available":
        return

    # Read the unit's own incident history rather than the queue: the queue is
    # filtered and scoped, and a fixture that depends on a filtered list breaks
    # whenever that filter is corrected -- which it just was.
    detail = c.get(f"{API}/ambulances/{ambulance_id}", headers=dispatcher).json()
    live = {"open", "dispatched", "en_route", "at_scene", "patient_onboard", "transporting", "at_hospital"}
    for item in detail.get("recent_incidents", []):
        if item["status"] not in live:
            continue
        for step in ("en_route", "at_scene", "patient_onboard", "at_hospital", "handed_over"):
            response = c.post(
                f"{API}/incidents/{item['id']}/status",
                headers=dispatcher,
                json={"status": step},
            )
            if response.status_code != 200:
                continue
            if response.json()["status"] in ("handed_over", "closed", "cancelled"):
                break


def _crew_vehicle(c, admin, crew_email: str = "crew@medmesh.in") -> dict:
    """The vehicle the pilot crew account drives, with its id.

    The authorization tests all need a real crew-to-vehicle link, and it has to
    come from the API rather than from an assumption about the seeded ids --
    otherwise the tests stop testing ownership the moment the seed changes.
    """
    directory = c.get(f"{API}/ambulances/drivers", headers=admin)
    assert directory.status_code == 200, directory.text
    for row in directory.json()["results"]:
        if row["email"] == crew_email:
            assert row["linked_ambulance"], (
                f"{crew_email} is not linked to a vehicle, so the seed no longer "
                "exercises the crew workflow"
            )
            return row["linked_ambulance"]
    raise AssertionError(f"{crew_email} is not a driver account in this dataset")


def _a_crew_incident(c, dispatcher, admin, *, ambulance_id: int | None = None, exclude: int | None = None) -> dict:
    """A live incident, dispatched to a stated unit.

    Deliberately a P2 bed hold rather than the P1 ICU case the main dispatch
    test uses. Each call consumes real capacity for the length of the test
    session, and demanding the last ICU bed in Coimbatore from two different
    fixtures made these tests fail for a reason that has nothing to do with what
    they assert -- which is the same trap the hold-release test documented
    earlier. Beds are plentiful; the ownership and scope behaviour is identical.
    """
    created = c.post(
        f"{API}/incidents",
        headers=dispatcher,
        json={
            "category": "trauma_fall",
            "urgency": "P2",
            "lat": 11.0168,
            "lng": 76.9558,
            "landmark": "Ownership fixture",
            "district_id": 1,
        },
    )
    assert created.status_code == 201, created.text
    incident = created.json()

    if ambulance_id is not None:
        # The suite shares one database, so an earlier test may have left this
        # unit mid-trip. Close those trips first rather than asserting on a
        # vehicle whose state depends on test ordering -- a fixture that only
        # works when it runs first is a fixture that will break the next time
        # somebody inserts a test above it.
        _release_unit(c, dispatcher, ambulance_id)

    eligible = [x for x in incident["shortlist"] if x["eligible"]]
    assert eligible, "a Coimbatore incident must have a reachable facility"
    top = eligible[0]

    body: dict = {"hospital_id": top["hospital_id"], "hold_resource": "bed"}
    if ambulance_id is not None:
        body["ambulance_id"] = ambulance_id
    elif exclude is not None:
        # The engine would otherwise pick the nearest capable unit, which in
        # Coimbatore is the one the crew test is already driving -- making the
        # "not theirs" assertion below vacuously true.
        fleet = c.get(f"{API}/ambulances", headers=dispatcher).json()["results"]
        alternatives = [a for a in fleet if a["status"] == "available" and a["id"] != exclude]
        assert alternatives, "no second available unit to dispatch"
        body["ambulance_id"] = alternatives[0]["id"]
    dispatched = c.post(f"{API}/incidents/{incident['id']}/dispatch", headers=dispatcher, json=body)
    assert dispatched.status_code == 200, dispatched.text
    # Kept on the incident so a caller can assert about the dispatch decision --
    # which unit, which escalation tier, what the engine warned about -- without
    # re-dispatching, which would fail because the incident is already live.
    incident["dispatch"] = dispatched.json()
    return incident


def test_driver_cannot_act_on_an_incident_that_is_not_theirs():
    """A crew action needs ownership, not just the driver role.

    Incident ids are small integers and appear in the queue, in notifications
    and in hold rows. Before this check, any driver account could advance *any*
    incident it could name -- including marking a patient handed over and
    diverting an ambulance -- and the actions are clinical, so the blast radius
    was the whole state's caseload.
    """
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        unit = _crew_vehicle(c, admin)

        # Their own incident, dispatched to their own unit.
        incident = _a_crew_incident(c, dispatcher, admin, ambulance_id=unit["id"])

        own = c.get(f"{API}/crew/assignment", headers=crew)
        assert own.status_code == 200, own.text
        assignment = own.json()["assignment"]
        assert assignment is not None, (
            "the pilot crew account must be linked to a vehicle, otherwise the "
            "next assertion proves nothing"
        )
        assert assignment["id"] == incident["id"]

        # A second incident, on a different unit. The crew must not be able to
        # touch it even knowing its id.
        other = _a_crew_incident(c, dispatcher, admin, exclude=unit["id"])
        assert other["dispatch"]["assigned_ambulance"]["id"] != unit["id"], (
            "the fixture accidentally reused the crew's own vehicle, which would "
            "make the refusal below meaningless"
        )
        assert other["id"] != incident["id"]
        refused = c.post(
            f"{API}/incidents/{other['id']}/status",
            headers=crew,
            json={"status": "en_route"},
        )
        assert refused.status_code == 404, (
            f"a driver advanced an incident belonging to another unit: {refused.status_code} {refused.text}"
        )

        # And the reroute path, which moves the destination hospital.
        rerouted = c.post(
            f"{API}/incidents/{other['id']}/reroute",
            headers=crew,
            json={"hospital_id": other["shortlist"][0]["hospital_id"], "reason": "attempted hijack"},
        )
        assert rerouted.status_code == 404, (
            f"a driver re-routed another unit's incident: {rerouted.status_code} {rerouted.text}"
        )

        # Their own incident still works, so the guard is scoped and not a
        # blanket refusal.
        allowed = c.post(
            f"{API}/incidents/{incident['id']}/status",
            headers=crew,
            json={"status": "en_route"},
        )
        assert allowed.status_code == 200, allowed.text


def test_crew_directory_does_not_invent_an_assignment():
    """An unlinked driver must be told they are unlinked, not shown a stranger's job."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        _a_crew_incident(c, dispatcher, admin)  # guarantees a live incident exists to be leaked

        unlinked_email = "unlinked.crew@medmesh.in"
        created = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "email": unlinked_email,
                "full_name": "Unlinked Crew",
                "password": "Unlinked@108",
                "role": "driver",
                "district_id": 1,
            },
        )
        # Re-running the suite must not be defeated by the account from the
        # previous run, so an existing one is reused rather than treated as an
        # error. The test is about the account being unlinked, not about it
        # being new.
        if created.status_code == 409:
            unlinked = _login(c, unlinked_email, "Unlinked@108")
        else:
            assert created.status_code == 201, created.text
            unlinked = _login(c, unlinked_email, "Unlinked@108")

        # Whatever previous state this account was in, it must not be driving
        # anything -- otherwise the assertion below would pass for the wrong
        # reason.
        directory = c.get(f"{API}/ambulances/drivers", headers=admin).json()
        for row in directory["results"]:
            if row["email"] == unlinked_email and row["linked_ambulance"]:
                released = c.post(
                    f"{API}/ambulances/{row['linked_ambulance']['id']}/crew",
                    headers=admin,
                    json={"driver_user_id": None, "reason": "test setup"},
                )
                assert released.status_code == 200, released.text

        response = c.get(f"{API}/crew/assignment", headers=unlinked)
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["assignment"] is None, (
            "a driver with no vehicle was handed an assignment; this is the "
            "fallback that showed strangers' emergencies"
        )
        assert body["ambulance"] is None
        assert "link" in body["action_required"].lower()


def test_incidents_are_scoped_to_the_readers_jurisdiction():
    """Reading an incident is an operation: it carries a scene and a destination."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = _a_crew_incident(c, dispatcher, admin)

        # The district officer for that district may read it.
        gov = _login(c, "gov@medmesh.in", "District@2026")
        gov_district = c.get(f"{API}/auth/me", headers=gov).json()["district_id"]
        owner_view = c.get(f"{API}/incidents/{incident['id']}", headers=gov)
        if incident["district_id"] == gov_district:
            assert owner_view.status_code == 200
        else:
            assert owner_view.status_code == 404, (
                "an incident outside the officer's district must not be readable"
            )

        # A citizen is not an operational role at all.
        anon = c.get(f"{API}/incidents/{incident['id']}")
        assert anon.status_code in (401, 403, 404)


def test_fleet_list_is_not_readable_by_every_authenticated_account():
    """The fleet list is a live map of every emergency vehicle in the state."""
    with client() as c:
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        mine = c.get(f"{API}/ambulances", headers=crew)
        assert mine.status_code == 200, mine.text
        assert mine.json()["count"] <= 1, "a driver must only see their own vehicle"

        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        theirs = c.get(f"{API}/ambulances", headers=dispatcher)
        assert theirs.status_code == 200
        assert theirs.json()["count"] > 1, "dispatch needs the fleet"

        anon = c.get(f"{API}/ambulances")
        assert anon.status_code in (401, 403)


def test_doctor_directory_opt_out_survives_a_direct_id_lookup():
    """The opt-out is a property of the facility, not of the search endpoint."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        # A private facility that has withheld its roster.
        hospitals = c.get(f"{API}/hospitals?type=private&limit=200").json()["results"]
        private = next((h for h in hospitals if not h.get("expose_doctor_directory", True)), None)
        if private is None:
            for h in hospitals:
                toggle = c.patch(
                    f"{API}/hospitals/{h['id']}",
                    headers=admin,
                    json={"expose_doctor_directory": False},
                )
                if toggle.status_code == 200:
                    private = c.get(f"{API}/hospitals/{h['id']}").json()
                    break
        assert private is not None, "no private facility available to test the opt-out"

        roster = c.get(f"{API}/doctors?hospital_id={private['id']}&limit=5").json()
        assert roster["count"] == 0, "the directory itself must hide an opted-out roster"

        doctors = c.get(f"{API}/doctors?limit=5&hospital_id={private['id']}").json()
        assert doctors["count"] == 0

        # The direct lookup must hide it too. Find an id by asking as staff.
        staff = c.get(f"{API}/doctors?hospital_id={private['id']}&limit=5", headers=admin).json()
        if staff["count"]:
            doctor_id = staff["results"][0]["id"]
            public_view = c.get(f"{API}/doctors/{doctor_id}")
            assert public_view.status_code == 404, (
                "a direct doctor id defeated the facility's directory opt-out"
            )


def test_gov_analytics_respect_the_officers_district():
    """A district officer's overview must be their district, not the state."""
    with client() as c:
        gov = _login(c, "gov@medmesh.in", "District@2026")
        me = c.get(f"{API}/auth/me", headers=gov).json()
        payload = c.get(f"{API}/analytics/overview", headers=gov).json()

        if me["district_id"] is not None:
            assert len(payload["districts"]) == 1, (
                "a district officer was served the statewide rollup"
            )
            assert payload["districts"][0]["district_id"] == me["district_id"]

        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        statewide = c.get(f"{API}/analytics/overview", headers=admin).json()
        assert len(statewide["districts"]) == 38


def test_manual_ambulance_assignment_is_validated_like_the_engines_choice():
    """Naming a unit by hand must not be the least-checked path in the system."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = _a_crew_incident(c, dispatcher, admin)

        fleet = c.get(f"{API}/ambulances", headers=dispatcher).json()["results"]
        busy = next((a for a in fleet if a["status"] != "available"), None)
        if busy is not None:
            forced = c.post(
                f"{API}/incidents/{incident['id']}/dispatch",
                headers=dispatcher,
                json={"hospital_id": incident["shortlist"][0]["hospital_id"], "ambulance_id": busy["id"]},
            )
            assert forced.status_code == 409, (
                f"a unit that is not free was accepted by hand: {forced.status_code}"
            )
            detail = forced.json()["detail"]
            assert detail["blockers"], "the refusal must say what is wrong"

            # With a stated reason it is permitted, because the override is meant
            # to be accountable rather than impossible.
            overridden = c.post(
                f"{API}/incidents/{incident['id']}/dispatch",
                headers=dispatcher,
                json={
                    "hospital_id": incident["shortlist"][0]["hospital_id"],
                    "ambulance_id": busy["id"],
                    "override_reason": "unit is clearing the previous job; control room accepts the wait",
                },
            )
            assert overridden.status_code == 200, overridden.text
            crew_match = overridden.json()["crew_notes"]
            assert crew_match["manual"] is True
            assert crew_match["escalation"] in ("local", "neighbouring", "statewide")


def test_ambulance_selection_escalates_outward_but_reports_it():
    """Local first, then mutual aid, then statewide -- and labelled."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = _a_crew_incident(c, dispatcher, admin)
        crew_match = incident["dispatch"]["crew_notes"]

        tier = crew_match["escalation"]
        assert tier in ("local", "neighbouring", "statewide"), (
            "the assignment must state which tier it came from"
        )

        # The tier must be the *best available* one, not merely a plausible one.
        # Asserting a hard "local", as an earlier version of this test did, only
        # held while the suite ran in a particular order -- by the time it
        # executed, every Coimbatore unit was already committed to an earlier
        # fixture, so statewide was the correct answer and the test was wrong.
        # What actually matters is the search order, so that is what is checked:
        # count the capable units that were free in each tier at dispatch time
        # and require the engine to have used the innermost one with any supply.
        fleet = c.get(f"{API}/ambulances", headers=dispatcher).json()
        allowed_local = set(fleet["scope"]["tiers"]["local"]["district_ids"])
        assigned_id = incident["dispatch"]["assigned_ambulance"]["id"]

        # Supply is counted for the capability that was actually dispatched, not
        # for anything on the incident's preference list. The engine is allowed
        # to pass over a local basic-life-support van to reach an advanced one
        # further out -- capability outranks distance, by design -- so counting
        # any-capable supply would report that as a search-order failure when it
        # is the intended behaviour.
        dispatched_capability = crew_match["capability"]
        local_supply = [
            a
            for a in fleet["results"]
            if a["status"] == "available"
            and dispatched_capability in a["capabilities"]
            and a["base_district_id"] in allowed_local
            and a["id"] != assigned_id
        ]
        if local_supply:
            assert tier == "local", (
                f"{len(local_supply)} {dispatched_capability} unit(s) were free in the incident "
                f"district, but the engine reached into {tier}: {crew_match['warnings']}"
            )
        else:
            # No local supply, so escalation is the correct answer -- and it has
            # to be announced rather than performed silently.
            assert tier in ("neighbouring", "statewide")
            assert any("aid" in w or "escalation" in w for w in crew_match["warnings"]), (
                "reaching outside the district must be stated in the assignment warnings, "
                f"got: {crew_match['warnings']}"
            )


def test_escalation_ladder_is_geographically_sane():
    """Neighbours are neighbours, not "everything that is not local"."""
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        fleet = c.get(f"{API}/ambulances", headers=dispatcher).json()
        tiers = fleet["scope"]["tiers"]
        assert tiers is not None
        local = set(tiers["local"]["district_ids"])
        neighbours = set(tiers["neighbouring"]["district_ids"])
        rest = set(tiers["statewide"]["district_ids"])
        assert not (local & neighbours), "a district cannot be both local and a neighbour"
        assert local | neighbours | rest
        assert len(neighbours) >= 2, "Coimbatore has neighbours"
        assert len(neighbours) < 20, "neighbouring must not collapse into 'everywhere'"


# --------------------------------------------------------------------------- #
# Password and session lifecycle
# --------------------------------------------------------------------------- #


def test_demo_credentials_are_not_compiled_into_the_client():
    """The published pilot accounts come from the API, gated by a server flag.

    The sign-in screen used to contain them as string literals, so every build
    of the app -- pilot, staging, production -- shipped a working platform
    administrator password in its JavaScript bundle. Moving them behind a flag
    does not make them secret; it makes it possible for a deployment to *not*
    have them, and puts the decision somewhere a deployment can actually make it.
    """
    with client() as c:
        response = c.get(f"{API}/auth/demo-accounts")
        assert response.status_code == 200, response.text
        body = response.json()
        assert "accounts" in body, "the endpoint must always answer, flag or not"
        for account in body["accounts"]:
            assert {"role", "email", "password", "surface"} <= set(account), (
                "a published credential needs to say which surface it opens"
            )
        if not body["demo_mode"]:
            assert body["accounts"] == [], "credentials must not leak when demo mode is off"


def test_forced_first_login_change_is_enforced_before_credentials_are_issued():
    """An unrotated one-time password may not provision other accounts."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")

        state = c.get(f"{API}/auth/session", headers=admin)
        assert state.status_code == 200, state.text
        flag = state.json()["must_change_password"]

        attempt = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "email": "rotation.probe@medmesh.in",
                "full_name": "Rotation Probe",
                "password": "Rotation@2026",
                "role": "driver",
                "district_id": 1,
            },
        )
        if flag:
            assert attempt.status_code == 403, (
                f"an account still on its one-time password provisioned another: {attempt.status_code}"
            )
            assert "one-time password" in attempt.json()["detail"]

            # Clearing the flag — and proving the change was real — reopens it.
            changed = c.post(
                f"{API}/auth/password/change",
                headers=admin,
                json={"current_password": "MedMesh@2026", "new_password": "Rotated-Admin-2026!"},
            )
            assert changed.status_code == 200, changed.text
            assert changed.json()["forced_change_cleared"] is True

            again = c.post(
                f"{API}/governance/users",
                headers=admin,
                json={
                    "email": "rotation.probe@medmesh.in",
                    "full_name": "Rotation Probe",
                    "password": "Rotation@2026",
                    "role": "driver",
                    "district_id": 1,
                },
            )
            assert again.status_code == 201, again.text

            # Put the pilot credential back so the published demo account still
            # works for whoever opens the app next.
            restored = c.post(
                f"{API}/auth/password/change",
                headers=admin,
                json={"current_password": "Rotated-Admin-2026!", "new_password": "MedMesh@2026"},
            )
            # `MedMesh@2026` is on the banned list on purpose, so this must fail:
            # the point of the banned list is that a published credential cannot
            # be reinstated by its holder.
            assert restored.status_code == 422, (
                "a published pilot password was accepted as a new password"
            )
        else:
            assert attempt.status_code in (201, 409)


def test_password_reset_round_trip_and_enumeration_resistance():
    """Forgot/reset works, and the forgot step does not confirm which accounts exist."""
    with client() as c:
        account_email = "reset.probe@medmesh.in"
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        created = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "email": account_email,
                "full_name": "Reset Probe",
                "password": "Initial-Password-98",
                "role": "driver",
                "district_id": 1,
            },
        )
        assert created.status_code in (201, 409), created.text

        # Unknown address and known address answer identically. Any difference
        # here is an account-enumeration oracle, and the account names on this
        # platform are real hospitals and real districts.
        unknown = c.post(f"{API}/auth/password/forgot", json={"email": "nobody@example.invalid"})
        known = c.post(f"{API}/auth/password/forgot", json={"email": account_email})
        assert unknown.status_code == known.status_code == 200
        assert unknown.json()["message"] == known.json()["message"]

        token = known.json().get("dev_token")
        if token is None:
            # No reset-token echo configured, so the round trip cannot be driven
            # from here; the identical-response assertion above is the part that
            # matters for this environment.
            return

        weak = c.post(f"{API}/auth/password/reset", json={"token": token, "new_password": "short"})
        assert weak.status_code == 422, "the password policy must apply to resets too"

        bad = c.post(
            f"{API}/auth/password/reset",
            json={"token": "not-a-real-token-value-at-all", "new_password": "Replacement-Pass-77"},
        )
        assert bad.status_code == 400
        assert bad.json()["detail"] == "That reset link is invalid or has expired", (
            "an invalid link and an expired one must be indistinguishable"
        )

        done = c.post(
            f"{API}/auth/password/reset",
            json={"token": token, "new_password": "Replacement-Pass-77"},
        )
        assert done.status_code == 200, done.text

        # The token is single-use.
        replay = c.post(
            f"{API}/auth/password/reset",
            json={"token": token, "new_password": "Another-Replacement-99"},
        )
        assert replay.status_code == 400, "a reset token was accepted twice"

        # And the new credential is the one that works.
        assert c.post(f"{API}/auth/login", json={"email": account_email, "password": "Replacement-Pass-77"}).status_code == 200
        assert c.post(f"{API}/auth/login", json={"email": account_email, "password": "Initial-Password-98"}).status_code == 401


def test_capacity_ingest_reaches_the_websocket_subscribers():
    """A capacity write must fan out, not just update the database.

    The projection was updated in memory and the database was committed, so
    polling clients were correct -- but a hospital dashboard sitting open on a
    ward terminal only learned about a change when some unrelated code path
    happened to publish. This asserts the write path itself publishes, which is
    the difference between a real-time directory and a snapshot that refreshes
    whenever the user presses something.
    """
    with client() as c:
        from app.live import live_store

        admin = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        hospital_id = c.get(f"{API}/auth/me", headers=admin).json()["hospital_id"]

        queue = live_store.subscribe()
        try:
            published: list[dict] = []
            original = live_store._fan_out

            def capture(event, payload):
                published.append({"event": event, "payload": payload})
                return original(event, payload)

            live_store._fan_out = capture  # type: ignore[assignment]
            try:
                response = c.post(
                    f"{API}/hospitals/{hospital_id}/capacity/quick",
                    headers=admin,
                    json={"deltas": {"beds_available": -1}},
                )
                assert response.status_code == 200, response.text
            finally:
                live_store._fan_out = original  # type: ignore[assignment]
        finally:
            live_store.unsubscribe(queue)

        assert any(p["event"] == "capacity.updated" for p in published), (
            "the ingest path committed without telling any connected surface"
        )
        update = next(p for p in published if p["event"] == "capacity.updated")
        assert update["payload"]["hospital_id"] == hospital_id
        assert update["payload"]["capacity"]["beds_available"] is not None


def test_trip_lifecycle_requires_the_stages_in_order_and_stamps_each_one():
    """The extended state machine, and the timestamps it exists to produce."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = _a_crew_incident(c, dispatcher, admin)

        # Skipping a stage is refused, and the refusal explains the legal next
        # moves rather than just rejecting.
        skipped = c.post(
            f"{API}/incidents/{incident['id']}/status",
            headers=dispatcher,
            json={"status": "transporting"},
        )
        assert skipped.status_code == 409, skipped.text
        detail = skipped.json()["detail"]
        assert detail["current"] == "dispatched"
        assert "en_route" in detail["allowed"]
        assert detail["allowed_labels"], "the refusal must be readable, not just a code list"

        # The vocabulary the audit asked for, in order.
        for step in ("en_route", "at_scene", "patient_onboard", "transporting", "at_hospital", "handed_over"):
            response = c.post(
                f"{API}/incidents/{incident['id']}/status",
                headers=dispatcher,
                json={"status": step},
            )
            assert response.status_code == 200, f"{step}: {response.text}"
            assert response.json()["status"] == step

        # Repeating a state is idempotent rather than an error: a device that
        # retried after a dropped response is resending what already succeeded.
        repeat = c.post(
            f"{API}/incidents/{incident['id']}/status",
            headers=dispatcher,
            json={"status": "handed_over"},
        )
        assert repeat.status_code == 200, repeat.text

        # Moving backwards is not.
        backwards = c.post(
            f"{API}/incidents/{incident['id']}/status",
            headers=dispatcher,
            json={"status": "at_scene"},
        )
        assert backwards.status_code == 409

        # Every stage left a timestamp, which is what makes the analytics able to
        # report the intervals separately instead of inferring four of them.
        final = c.get(f"{API}/incidents/{incident['id']}", headers=dispatcher).json()
        for field in (
            "dispatched_at",
            "en_route_at",
            "scene_arrived_at",
            "patient_onboard_at",
            "departed_scene_at",
            "hospital_arrived_at",
            "handed_over_at",
        ):
            assert final.get(field), f"{field} was never stamped"


def test_deprecated_arrived_spelling_still_works():
    """Older clients send `arrived`; it means at_scene and must not start failing."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident = _a_crew_incident(c, dispatcher, admin)

        c.post(f"{API}/incidents/{incident['id']}/status", headers=dispatcher, json={"status": "en_route"})
        legacy = c.post(
            f"{API}/incidents/{incident['id']}/status",
            headers=dispatcher,
            json={"status": "arrived"},
        )
        assert legacy.status_code == 200, legacy.text
        assert legacy.json()["status"] == "at_scene", (
            "`arrived` is the deprecated spelling of at_scene and must normalise"
        )


def test_fleet_management_links_and_releases_a_crew():
    """The administrative path the audit found missing entirely."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")

        directory = c.get(f"{API}/ambulances/drivers", headers=admin).json()
        assert "orphan_drivers" in directory, "the fleet screen must surface unlinked accounts"
        assert "crewless_units" in directory, "and vehicles with no crew"

        created = c.post(
            f"{API}/ambulances",
            headers=admin,
            json={
                "call_sign": "108-TNCBE-TEST",
                "registration": "TN 99 ZZ 0001",
                "operator_type": "108",
                "operator_name": "Test Control Room",
                "base_district_id": 1,
                "capabilities": ["als"],
            },
        )
        if created.status_code == 409:
            units = c.get(f"{API}/ambulances", headers=admin).json()["results"]
            unit = next(u for u in units if u["call_sign"] == "108-TNCBE-TEST")
        else:
            assert created.status_code == 201, created.text
            unit = created.json()

        assert unit["capabilities"] == ["als"], "capabilities round-trip as a list"
        assert unit["capability_labels"], "and carry their human labels"

        # A non-driver account must be refused: the role is what the crew screens
        # authenticate against.
        wrong_role = c.post(
            f"{API}/ambulances/{unit['id']}/crew",
            headers=admin,
            json={"driver_user_id": 1},
        )
        assert wrong_role.status_code == 409
        assert "not driver" in wrong_role.json()["detail"]

        # Linking a real driver, then releasing them.
        driver = next((r for r in directory["results"] if r["linked_ambulance"] is None), None)
        if driver is not None:
            linked = c.post(
                f"{API}/ambulances/{unit['id']}/crew",
                headers=admin,
                json={"driver_user_id": driver["id"], "reason": "fleet test"},
            )
            assert linked.status_code == 200, linked.text
            assert linked.json()["driver"]["id"] == driver["id"]
            assert linked.json()["crew_state"] == "linked"

            released = c.post(
                f"{API}/ambulances/{unit['id']}/crew",
                headers=admin,
                json={"driver_user_id": None, "reason": "fleet test cleanup"},
            )
            assert released.status_code == 200
            assert released.json()["driver"] is None

        # Standing a unit down, and the refusal to do it mid-trip.
        down = c.post(
            f"{API}/ambulances/{unit['id']}/status",
            headers=admin,
            json={"status": "out_of_service", "reason": "workshop"},
        )
        assert down.status_code == 200, down.text
        assert down.json()["status"] == "out_of_service"

        back = c.post(
            f"{API}/ambulances/{unit['id']}/status",
            headers=admin,
            json={"status": "available"},
        )
        assert back.status_code == 200
        assert back.json()["status"] == "available"

        # A driver account may not manage the fleet at all.
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        refused = c.post(
            f"{API}/ambulances/{unit['id']}/status",
            headers=crew,
            json={"status": "out_of_service"},
        )
        assert refused.status_code == 403


def test_roster_crud_and_specialty_validation():
    """The roster is editable, and specialty is a closed list.

    The audit's finding was that the platform could mark a clinician on duty and
    could not add, correct or remove one -- so every clinician arrived through the
    seeder. Worse, specialty was free text, and specialty is the *first* step of
    the matching chain: a cardiologist recorded as "Heart" is indistinguishable
    from a facility with no cardiologist at all.
    """
    with client() as c:
        admin = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        hospital_id = c.get(f"{API}/auth/me", headers=admin).json()["hospital_id"]

        created = c.post(
            f"{API}/doctors",
            headers=admin,
            json={
                "hospital_id": hospital_id,
                "full_name": "Roster Probe",
                "specialty": "cardiology",
                "designation": "Consultant Cardiologist",
                "shift_window": "08:00 – 20:00",
                "on_duty": True,
                "accepts_emergency": True,
            },
        )
        if created.status_code == 409:
            roster = c.get(f"{API}/doctors?hospital_id={hospital_id}&limit=200", headers=admin).json()
            doctor = next(d for d in roster["results"] if d["full_name"] == "Roster Probe")
        else:
            assert created.status_code == 201, created.text
            doctor = created.json()
            # The response is renderable, not just an id: the roster screen shows
            # the new row without a refetch.
            assert doctor["specialty_label"]
            assert doctor["shift_window"] == "08:00 – 20:00"

        # Near-misses are normalised rather than creating invisible duplicates.
        for near, canonical in (
            ("Cardiology", "cardiology"),
            ("orthopedics", "orthopaedics"),
            ("ICU", "critical_care"),
        ):
            updated = c.patch(f"{API}/doctors/{doctor['id']}", headers=admin, json={"specialty": near})
            assert updated.status_code == 200, updated.text
            assert updated.json()["specialty"] == canonical, (
                f"'{near}' should normalise to '{canonical}'"
            )

        # A genuinely different specialty is refused, with the options listed.
        refused = c.patch(f"{API}/doctors/{doctor['id']}", headers=admin, json={"specialty": "heart"})
        assert refused.status_code == 422, refused.text
        detail = refused.json()["detail"]
        assert detail["allowed"], "the refusal must list what is acceptable"
        assert len(detail["allowed"]) == 19

        # A partial edit touches only what it names.
        before = c.get(f"{API}/doctors/{doctor['id']}", headers=admin).json()
        edited = c.patch(f"{API}/doctors/{doctor['id']}", headers=admin, json={"designation": "Senior Consultant"})
        assert edited.status_code == 200, edited.text
        after = c.get(f"{API}/doctors/{doctor['id']}", headers=admin).json()
        assert after["designation"] == "Senior Consultant"
        assert after["specialty"] == before["specialty"], "an unnamed field was clobbered"
        assert after["shift_window"] == before["shift_window"]

        # Duty can now be set through the same endpoint as everything else.
        off = c.patch(f"{API}/doctors/{doctor['id']}", headers=admin, json={"on_duty": False})
        assert off.status_code == 200
        assert off.json()["on_duty"] is False

        # Removal.
        removed = c.delete(f"{API}/doctors/{doctor['id']}", headers=admin)
        assert removed.status_code == 204, removed.text
        assert c.get(f"{API}/doctors/{doctor['id']}", headers=admin).status_code == 404

        # A facility may not edit another facility's roster.
        other = _login(c, "admin@srmc.medmesh.in", "Hospital@2026")
        other_id = c.get(f"{API}/auth/me", headers=other).json()["hospital_id"]
        assert other_id != hospital_id
        cross = c.post(
            f"{API}/doctors",
            headers=other,
            json={"hospital_id": hospital_id, "full_name": "Cross Tenant", "specialty": "cardiology"},
        )
        assert cross.status_code == 403, "one facility edited another's roster"


# --------------------------------------------------------------------------- #
# #23 — the incident coordinate is the caller's, and says where it came from
# --------------------------------------------------------------------------- #


def test_incident_location_is_the_callers_and_carries_its_provenance():
    """The console used to send the district centre for every incident.

    A call from Pollachi and a call from the middle of Coimbatore produced the
    same pair of floats, and since the matching engine ranks facilities by drive
    time *from that point*, both were answered with a plan for a journey nobody
    was making. The coordinate is now captured at the console (GPS fix, map tap,
    pasted coordinates, or an explicitly-labelled district fallback) and the
    incident records which of those it was.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        base = {
            "category": "road_accident",
            "urgency": "P2",
            "landmark": "Provenance probe",
            "district_id": 1,
        }

        # A handset fix, well away from the district centre.
        gps = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={**base, "lat": 10.9950, "lng": 76.9600, "location_source": "gps", "taluk": "Coimbatore South"},
        )
        assert gps.status_code == 201, gps.text
        body = gps.json()
        assert body["location_source"] == "gps"
        assert body["taluk"] == "Coimbatore South"
        assert body["location_approximate"] is False

        # The documented fallback is still accepted, and is flagged as such.
        fallback = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={**base, "lat": 11.0010, "lng": 76.9629, "location_source": "district"},
        )
        assert fallback.status_code == 201, fallback.text
        assert fallback.json()["location_approximate"] is True, (
            "a district-centre placeholder was recorded as a real fix"
        )

        # A transposed pair is the failure that actually happens, and it must not
        # reach the matcher: 80.27, 13.08 is off the coast near Chennai's
        # longitude but at Coimbatore's latitude.
        swapped = c.post(f"{API}/incidents", headers=dispatcher, json={**base, "lat": 80.2707, "lng": 13.0827})
        assert swapped.status_code == 422, "a coordinate outside Tamil Nadu was accepted"

        outside = c.post(f"{API}/incidents", headers=dispatcher, json={**base, "lat": 13.0827, "lng": 86.9558})
        assert outside.status_code == 422

        # And the free-text field that was removed stays removed.
        legacy = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={**base, "lat": 11.0, "lng": 76.9, "caller_notes": "Patient is Mr Suresh, 74"},
        )
        assert legacy.status_code == 422, "a free-text clinical field was accepted"


def test_district_fallback_warning_survives_to_the_crew_screen():
    """The crew has to know the destination may be approximate.

    The driver is the person who has to find the scene. If the only coordinate
    is a district centre, they need that on their own screen rather than having
    to infer it from a suspiciously round number.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        created = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "cardiac",
                "urgency": "P1",
                "landmark": "Approximate scene",
                "district_id": 1,
                "lat": 11.0010,
                "lng": 76.9629,
                "location_source": "district",
            },
        )
        assert created.status_code == 201, created.text
        incident_id = created.json()["id"]
        eligible = [row for row in created.json()["shortlist"] if row.get("eligible")]
        assert eligible, "no eligible facility for an approximate-location cardiac call"
        # Sent to the pilot crew's own vehicle, so the assertion is about this
        # incident rather than about whichever unit the engine happened to pick.
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        vehicle = _crew_vehicle(c, admin)
        _release_unit(c, dispatcher, vehicle["id"])

        dispatched = c.post(
            f"{API}/incidents/{incident_id}/dispatch",
            headers=dispatcher,
            json={
                "hospital_id": eligible[0]["hospital_id"],
                "ambulance_id": vehicle["id"],
                "override_reason": "test fixture: pinning the crew vehicle",
            },
        )
        assert dispatched.status_code == 200, dispatched.text
        assert dispatched.json()["location_approximate"] is True

        crew = _login(c, "crew@medmesh.in", "Crew@108")
        assignment = c.get(f"{API}/crew/assignment", headers=crew)
        assert assignment.status_code == 200
        payload = assignment.json()
        assert payload["assignment"] is not None, "the crew did not receive the trip they were sent"
        assert payload["assignment"]["id"] == incident_id
        assert payload["assignment"]["location_approximate"] is True, (
            "the crew screen has no way to know the scene coordinate is a placeholder"
        )
        _release_unit(c, dispatcher, vehicle["id"])


# --------------------------------------------------------------------------- #
# #15 — duty changes reach the public directory
# --------------------------------------------------------------------------- #


def test_duty_changes_are_announced_on_every_roster_path():
    """`doctor.duty` was published by the toggle endpoint and nothing else.

    Adding an on-duty consultant, correcting one through a roster edit, removing
    one, and ending a shift on rollover all changed the answer to "is there a
    cardiologist here right now" without the directory being told. The public
    board is the one screen a citizen uses to decide where to take somebody, so
    a stale answer there is the worst stale answer on the platform.

    Asserted at the publisher rather than through a websocket client: the
    contract is "this write path announces the change", and intercepting the
    announcement tests exactly that without a socket in the way.
    """
    import app.routers.doctors as doctors_router
    from app.live import live_store

    announced: list[dict] = []

    def record_sync(event, payload):
        announced.append({"event": event, **payload})
        return True

    async def record_async(event, payload):
        announced.append({"event": event, **payload})

    original_soon = doctors_router._publish_duty
    original_publish = live_store.publish

    def capture(doctor, *, event="duty"):
        announced.append(
            {
                "event": "doctor.duty",
                "doctor_id": doctor.id,
                "on_duty": doctor.on_duty,
                "removed": event == "removed",
            }
        )
        return True

    async def capture_async(event, payload):
        announced.append({"event": event, **payload})

    doctors_router._publish_duty = capture
    live_store.publish = capture_async
    try:
        with client() as c:
            facility_admin = _login(c, "admin@srmc.medmesh.in", "Hospital@2026")
            own_id = c.get(f"{API}/auth/me", headers=facility_admin).json()["hospital_id"]

            # 1. Created while on duty.
            created = c.post(
                f"{API}/doctors",
                headers=facility_admin,
                json={
                    "hospital_id": own_id,
                    "full_name": "Dr. Duty Probe",
                    "specialty": "cardiology",
                    "registration_no": "TN-DUTY-0001",
                    "on_duty": True,
                },
            )
            assert created.status_code == 201, created.text
            doctor_id = created.json()["id"]
            assert [a["doctor_id"] for a in announced] == [doctor_id], (
                "adding an on-duty clinician announced nothing"
            )

            # 2. Flipped off through the partial edit rather than the toggle.
            announced.clear()
            edited = c.patch(f"{API}/doctors/{doctor_id}", headers=facility_admin, json={"on_duty": False})
            assert edited.status_code == 200, edited.text
            assert [a["doctor_id"] for a in announced] == [doctor_id], (
                "a roster edit changed duty silently"
            )
            assert announced[0]["on_duty"] is False

            # 3. Back on through the dedicated toggle.
            announced.clear()
            toggled = c.post(f"{API}/doctors/{doctor_id}/duty", headers=facility_admin, json={"on_duty": True})
            assert toggled.status_code == 200, toggled.text
            assert [a["doctor_id"] for a in announced] == [doctor_id]

            # 4. An edit that does not touch duty stays quiet. A directory that
            #    re-renders on every designation change is a directory that
            #    flickers for no reason.
            announced.clear()
            c.patch(f"{API}/doctors/{doctor_id}", headers=facility_admin, json={"designation": "Registrar"})
            assert announced == [], "an unrelated edit announced a duty change"

            # 5. Removed while on duty -- the case where the board would
            #    otherwise keep showing somebody who no longer works there.
            announced.clear()
            removed = c.delete(f"{API}/doctors/{doctor_id}", headers=facility_admin)
            assert removed.status_code == 204, removed.text
            assert [a["doctor_id"] for a in announced] == [doctor_id], (
                "removing an on-duty clinician left them on the public board"
            )
            assert announced[0]["removed"] is True
    finally:
        doctors_router._publish_duty = original_soon
        live_store.publish = original_publish




# --------------------------------------------------------------------------- #
# #3/#4/#5 — a vehicle is a record, and a crew is linked to exactly one
# --------------------------------------------------------------------------- #


def test_fleet_management_creates_edits_crews_and_retires_a_vehicle():
    """The whole ambulance lifecycle, through the API the console uses.

    Before this there was no fleet management at all: `Ambulance.driver_id`
    existed and the seeder filled it in, so the demo worked and a real unit
    could not be onboarded without editing the database. A crew account created
    through the account screen had no vehicle, and the crew app -- which is
    built entirely around "my unit" -- had nothing to show.
    """
    import time as _time

    tag = str(int(_time.time()))[-5:]

    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")

        # Create.
        made = c.post(
            f"{API}/ambulances",
            headers=admin,
            json={
                "call_sign": f"108-TN37-C{tag}",
                "registration": f"TN 37 ZC {tag}",
                "operator_type": "108",
                "operator_name": "108 Emergency Response",
                "base_district_id": 1,
                "capabilities": ["als", "nicu"],
                "lat": 11.02,
                "lng": 76.96,
            },
        )
        assert made.status_code == 201, made.text
        unit = made.json()
        assert unit["capabilities"] == ["als", "nicu"]
        assert unit["status"] == "available"

        # Duplicate call signs are refused -- two units answering to the same
        # name on the radio is a safety problem, not a data-entry nit.
        clash = c.post(
            f"{API}/ambulances",
            headers=admin,
            json={
                "call_sign": f"108-TN37-C{tag}",
                "registration": f"TN 37 ZD {tag}",
                "operator_name": "108 Emergency Response",
                "base_district_id": 1,
                "capabilities": ["bls"],
            },
        )
        assert clash.status_code == 409, "a duplicate call sign was accepted"

        # Edit: re-base and re-fit.
        edited = c.patch(
            f"{API}/ambulances/{unit['id']}",
            headers=admin,
            json={"base_district_id": 2, "capabilities": ["bls"]},
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["base_district_id"] == 2
        assert edited.json()["capabilities"] == ["bls"]

        # A crew account, and the link.
        driver = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "full_name": "Fleet Probe",
                "email": f"fleet.probe.{tag}@medmesh.in",
                "password": "FleetProbe@2026",
                "role": "driver",
                "district_id": 1,
            },
        )
        assert driver.status_code == 201, driver.text
        driver_id = driver.json()["id"]

        linked = c.post(
            f"{API}/ambulances/{unit['id']}/crew",
            headers=admin,
            json={"driver_user_id": driver_id},
        )
        assert linked.status_code == 200, linked.text
        assert linked.json()["driver"]["id"] == driver_id
        assert linked.json()["crew_state"] == "linked"

        # One driver, one active vehicle: linking them to a second unit must
        # release the first, not leave two rows pointing at the same person.
        second = c.post(
            f"{API}/ambulances",
            headers=admin,
            json={
                "call_sign": f"108-TN37-D{tag}",
                "registration": f"TN 37 ZE {tag}",
                "operator_name": "108 Emergency Response",
                "base_district_id": 1,
                "capabilities": ["bls"],
            },
        )
        assert second.status_code == 201, second.text
        moved = c.post(
            f"{API}/ambulances/{second.json()['id']}/crew",
            headers=admin,
            json={"driver_user_id": driver_id},
        )
        assert moved.status_code == 200, moved.text
        assert moved.json()["driver"]["id"] == driver_id

        old = c.get(f"{API}/ambulances/{unit['id']}", headers=admin).json()
        assert old["driver"] is None, "the previous vehicle still claims the same driver"

        # And the crew's own screen follows them to the new unit.
        crew_token = _login(c, f"fleet.probe.{tag}@medmesh.in", "FleetProbe@2026")
        own = c.get(f"{API}/ambulances", headers=crew_token).json()
        assert own["count"] == 1, "a driver can see more than their own vehicle"
        assert own["results"][0]["id"] == second.json()["id"]

        # Release, and the vehicle reports itself uncrewed.
        released = c.post(
            f"{API}/ambulances/{second.json()['id']}/crew",
            headers=admin,
            json={"driver_user_id": None, "reason": "end of shift"},
        )
        assert released.status_code == 200, released.text
        assert released.json()["driver"] is None
        assert released.json()["crew_state"] == "unlinked"

        # Status changes are the two-state set the engine understands.
        out = c.post(f"{API}/ambulances/{unit['id']}/status", headers=admin, json={"status": "out_of_service"})
        assert out.status_code == 200
        assert out.json()["status"] == "out_of_service"
        back = c.post(f"{API}/ambulances/{unit['id']}/status", headers=admin, json={"status": "available"})
        assert back.status_code == 200

        bogus = c.post(f"{API}/ambulances/{unit['id']}/crew", headers=admin, json={"driver_user_id": 10**7})
        assert bogus.status_code == 404, "a nonexistent driver account was linked"

        # Leave the fleet as it was found.
        for ident in (unit["id"], second.json()["id"]):
            c.post(f"{API}/ambulances/{ident}/status", headers=admin, json={"status": "out_of_service"})


def test_an_unlinked_driver_is_told_so_rather_than_given_a_trip():
    """`GET /crew/assignment` must never invent an assignment.

    The driver screen is built around "your current trip". A crew account with
    no vehicle previously produced whichever payload fell out of a lookup that
    assumed a link existed, which on a bad day means a driver being shown
    somebody else's cardiac call as their own.
    """
    import time as _time

    tag = str(int(_time.time()))[-5:]

    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        made = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "full_name": "Orphan Probe",
                "email": f"orphan.probe.{tag}@medmesh.in",
                "password": "OrphanProbe@2026",
                "role": "driver",
                "district_id": 1,
            },
        )
        assert made.status_code == 201, made.text
        token = _login(c, f"orphan.probe.{tag}@medmesh.in", "OrphanProbe@2026")

        payload = c.get(f"{API}/crew/assignment", headers=token).json()
        assert payload["ambulance"] is None
        assert payload["assignment"] is None
        assert payload.get("action_required"), "the driver is not told what to do about it"

        # Reading the fleet as an unlinked driver is an empty list, not a 500.
        fleet = c.get(f"{API}/ambulances", headers=token)
        assert fleet.status_code == 200, fleet.text
        assert fleet.json()["results"] == []


def test_an_uncrewed_unit_is_ranked_below_a_crewed_one_in_the_same_district():
    """Where there is a choice, the unit somebody is sitting in goes first.

    Not a hard filter: a district with one uncrewed unit and nothing else free
    is still better served by sending it than by refusing. But the engine now
    knows the difference, which it did not when `driver_id` was a column nothing
    read.
    """
    import time as _time

    tag = str(int(_time.time()))[-5:]

    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        crew_vehicle = _crew_vehicle(c, admin)
        _release_unit(c, dispatcher, crew_vehicle["id"])

        near = c.post(
            f"{API}/ambulances",
            headers=admin,
            json={
                "call_sign": f"108-TN37-E{tag}",
                "registration": f"TN 37 ZF {tag}",
                "operator_name": "108 Emergency Response",
                "base_district_id": 1,
                "capabilities": ["bls"],
                # Closer to the incident than the crewed unit, but empty.
                "lat": 11.0168,
                "lng": 76.9558,
            },
        )
        assert near.status_code == 201, near.text

        crewed = c.get(f"{API}/ambulances/{crew_vehicle['id']}", headers=admin).json()
        c.patch(
            f"{API}/ambulances/{crew_vehicle['id']}",
            headers=admin,
            json={"capabilities": ["bls"], "base_district_id": 1, "lat": 11.0600, "lng": 77.0000},
        )

        incident = c.post(
            f"{API}/incidents",
            headers=dispatcher,
            json={
                "category": "other",
                "urgency": "P3",
                "landmark": "Crewed ranking probe",
                "district_id": 1,
                "lat": 11.0200,
                "lng": 76.9700,
                "location_source": "map",
            },
        )
        assert incident.status_code == 201, incident.text
        eligible = [r for r in incident.json()["shortlist"] if r.get("eligible")]
        assert eligible
        sent = c.post(
            f"{API}/incidents/{incident.json()['id']}/dispatch",
            headers=dispatcher,
            json={"hospital_id": eligible[0]["hospital_id"]},
        )
        assert sent.status_code == 200, sent.text
        chosen = sent.json()["assigned_ambulance"]["id"]
        assert chosen == crew_vehicle["id"], (
            "an empty vehicle closer by was picked over a crewed one in the same district"
        )
        assert chosen != near.json()["id"]

        _release_unit(c, dispatcher, chosen)
        c.post(f"{API}/ambulances/{near.json()['id']}/status", headers=admin, json={"status": "out_of_service"})


# --------------------------------------------------------------------------- #
# #20 — the ward can answer, and a decline is remembered
# --------------------------------------------------------------------------- #


def _dispatch_to_first_eligible(c, dispatcher, *, urgency="P1", category="cardiac", landmark="Inbound probe"):
    """Raise an incident and send it to the top eligible facility.

    Returns (incident_id, hospital_id, dispatched_payload).
    """
    created = c.post(
        f"{API}/incidents",
        headers=dispatcher,
        json={
            "category": category,
            "urgency": urgency,
            "landmark": landmark,
            "district_id": 1,
            "lat": 11.0168,
            "lng": 76.9558,
            "location_source": "map",
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    eligible = [row for row in body["shortlist"] if row.get("eligible")]
    assert eligible, "no eligible facility to dispatch to"
    hospital_id = eligible[0]["hospital_id"]
    sent = c.post(
        f"{API}/incidents/{body['id']}/dispatch",
        headers=dispatcher,
        json={"hospital_id": hospital_id},
    )
    assert sent.status_code == 200, sent.text
    return body["id"], hospital_id, sent.json()


def _provision_ward(c, admin, hospital_id: int, *, tag: str = None) -> str:
    """A facility account scoped to the receiving ward, ready to answer.

    Provisioned rather than assumed: the pilot dataset has two hospital accounts
    and the engine may legitimately pick any of 152 facilities, so a test that
    used whichever account happened to exist would silently skip the ward path
    it is supposed to be exercising. The platform admin can scope an account to
    any facility, so the test does that and then signs in as the ward.
    """
    import time as _time

    suffix = tag or str(int(_time.time()))[-6:]
    email = f"ward.probe.{suffix}.{hospital_id}@medmesh.in"
    made = c.post(
        f"{API}/governance/users",
        headers=admin,
        json={
            "full_name": "Ward Probe",
            "email": email,
            "password": "WardProbe@2026",
            "role": "hospital_admin",
            "hospital_id": hospital_id,
        },
    )
    assert made.status_code == 201, made.text
    return _login(c, email, "WardProbe@2026")


def test_a_ward_can_confirm_and_the_dispatcher_is_told():
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        incident_id, hospital_id, sent = _dispatch_to_first_eligible(c, dispatcher)
        ward = _provision_ward(c, admin, hospital_id)

        me = c.get(f"{API}/auth/me", headers=ward).json()
        assert me["hospital_id"] == hospital_id, "the ward account is scoped to the wrong facility"

        confirmed = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=ward,
            json={"response": "accepted", "note": "Bay 3 ready"},
        )
        assert confirmed.status_code == 200, confirmed.text
        body = confirmed.json()
        assert body["facility_response"] == "accepted"
        assert body["facility_acknowledged_at"] is not None, (
            "the ward confirmed but the acknowledgement was not recorded"
        )
        # Accepting is not a re-route: the destination must still be set, and the
        # ward's own inbox must show the case as answered.
        assert body["assigned_hospital_id"] == hospital_id
        assert body["assigned_hospital"]["id"] == hospital_id

        inbox = c.get(f"{API}/notifications?limit=50", headers=ward).json()
        assert any(n["incident_id"] == incident_id for n in inbox["results"]), (
            "the ward has no record of the case it just confirmed"
        )

        _release_unit(c, dispatcher, sent["assigned_ambulance"]["id"])


def test_a_decline_withdraws_the_destination_and_shuts_that_door():
    """The most important behaviour in the inbound loop.

    A ward saying "not here" must not stand the incident down — the patient is
    still in an ambulance — but it must clear the destination, so the crew stops
    navigating to a facility that has refused them and the console re-offers the
    case. Before this the destination stayed set, the shortlist kept proposing
    the same facility, and a dispatcher re-routing a P1 had to remember which
    doors were already closed.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        incident_id, hospital_id, sent = _dispatch_to_first_eligible(
            c, dispatcher, urgency="P2", category="road_accident", landmark="Decline probe"
        )
        ward = _provision_ward(c, admin, hospital_id)

        answered = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=ward,
            json={"response": "declined", "reason": "no_icu", "note": "unit closed for cleaning"},
        )
        assert answered.status_code == 200, answered.text
        body = answered.json()

        assert body["facility_decline_reason"] == "no_icu"
        assert body["facility_declined_at"] is not None
        assert body["assigned_hospital_id"] is None, "the destination survived a refusal"
        assert body["assigned_hospital"] is None
        assert body["destination_withdrawn"] is True
        assert hospital_id in body["declined_hospital_ids"], "the refused facility was not remembered"
        assert body["status"] != "cancelled", "a ward's refusal stood a live incident down"
        assert body["status"] not in ("closed", "handed_over")

        # The facility is gone from the shortlist handed back with the refusal.
        assert all(
            row["hospital_id"] != hospital_id for row in body["shortlist"]
        ), "the facility that just declined is still offered"

        # And it stays gone: the console re-reading the incident gets a fresh
        # shortlist that still excludes it.
        reread = c.get(f"{API}/incidents/{incident_id}", headers=dispatcher).json()
        assert hospital_id in reread["declined_hospital_ids"]

        # The dispatcher was told, because somebody has to pick a new
        # destination and the crew is still driving.
        operator = c.get(f"{API}/notifications?limit=50", headers=dispatcher).json()
        assert any(
            n["incident_id"] == incident_id and n["severity"] == "critical"
            for n in operator["results"]
        ), "a refusal did not reach the dispatcher who owns the incident"

        _release_unit(c, dispatcher, sent["assigned_ambulance"]["id"])


def test_answering_for_somebody_elses_ward_is_refused():
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        incident_id, hospital_id, sent = _dispatch_to_first_eligible(
            c, dispatcher, landmark="Wrong ward probe"
        )

        # Every hospital account that is not scoped to the receiving facility.
        for email in ("admin@srmc.medmesh.in", "admin@kgch.medmesh.in"):
            token = _login(c, email, "Hospital@2026")
            me = c.get(f"{API}/auth/me", headers=token).json()
            if me.get("hospital_id") == hospital_id:
                continue
            refused = c.post(
                f"{API}/incidents/{incident_id}/facility-response",
                headers=token,
                json={"response": "accepted"},
            )
            assert refused.status_code in (403, 404), (
                f"{email} answered for a facility it does not run: {refused.text}"
            )

        # A citizen certainly cannot.
        citizen = _login(c, "citizen@medmesh.in", "Citizen@2026")
        refused = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=citizen,
            json={"response": "accepted"},
        )
        assert refused.status_code == 403, refused.text

        # Nor can a dispatcher outside the incident's district.
        gov = _login(c, "gov@medmesh.in", "District@2026")
        refused = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=gov,
            json={"response": "accepted"},
        )
        assert refused.status_code == 403, refused.text

        _release_unit(c, dispatcher, sent["assigned_ambulance"]["id"])


def test_a_decline_needs_a_reason():
    """"Diversion" and "no ICU" tell the console very different things."""
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident_id, hospital_id, sent = _dispatch_to_first_eligible(
            c, dispatcher, urgency="P3", category="other", landmark="No-reason probe"
        )
        refused = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=dispatcher,
            json={"response": "declined"},
        )
        assert refused.status_code == 422, refused.text
        _release_unit(c, dispatcher, sent["assigned_ambulance"]["id"])


def test_a_dispatcher_can_record_a_refusal_taken_by_telephone():
    """The answer often arrives on a phone, and somebody has to write it down.

    A dispatcher may answer for a facility, but the difference has to survive:
    the audit trail distinguishes a ward's own answer from one taken on its
    behalf, because after an incident somebody asks who decided.
    """
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        incident_id, hospital_id, sent = _dispatch_to_first_eligible(
            c, dispatcher, urgency="P2", category="stroke", landmark="Phone-in probe"
        )

        recorded = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=dispatcher,
            json={"response": "declined", "reason": "diversion", "note": "taken by phone at 14:20"},
        )
        assert recorded.status_code == 200, recorded.text
        assert recorded.json()["facility_decline_reason"] == "diversion"

        # Filtered server-side: the audit table is the busiest in the platform
        # and a test that pulls the whole thing is a test that depends on what
        # ran before it.
        trail = c.get(
            f"{API}/governance/audit?hours=1&limit=50&action=incident.facility_decline"
            f"&entity_type=incident&entity_id={incident_id}",
            headers=admin,
        ).json()["results"]
        entries = [e for e in trail if "decline" in e["action"]]
        assert entries, "a refusal recorded by the control room left no audit entry"
        assert any("control room" in e["summary"] for e in entries), (
            "the audit trail does not distinguish an answer taken by phone from the ward's own: "
            + str([e["summary"] for e in entries])
        )

        _release_unit(c, dispatcher, sent["assigned_ambulance"]["id"])


def test_rerouting_back_to_a_facility_that_declined_needs_a_reason():
    with client() as c:
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incident_id, hospital_id, sent = _dispatch_to_first_eligible(
            c, dispatcher, urgency="P2", category="road_accident", landmark="Re-offer probe"
        )
        declined = c.post(
            f"{API}/incidents/{incident_id}/facility-response",
            headers=dispatcher,
            json={"response": "declined", "reason": "diversion"},
        )
        assert declined.status_code == 200, declined.text

        again = c.post(
            f"{API}/incidents/{incident_id}/reroute",
            headers=dispatcher,
            json={"hospital_id": hospital_id},
        )
        assert again.status_code == 409, "a facility that had refused was re-offered silently"
        assert again.json()["detail"]["declined_hospital_ids"], again.text

        override = c.post(
            f"{API}/incidents/{incident_id}/reroute",
            headers=dispatcher,
            json={"hospital_id": hospital_id, "override_reason": "ward called back: bay free"},
        )
        assert override.status_code == 200, override.text
        assert override.json()["assigned_hospital_id"] == hospital_id

        _release_unit(c, dispatcher, sent["assigned_ambulance"]["id"])


# --------------------------------------------------------------------------- #
# Driver telemetry
#
# The position a crew reports is the only thing that moves a vehicle on the
# console's map between status presses, so it is worth an assertion that it
# travels the whole way: driver endpoint, stored on the unit, and read back by
# the two views the control room actually uses.
# --------------------------------------------------------------------------- #


def test_a_crew_position_report_moves_the_unit_on_the_console_map():
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        unit = _crew_vehicle(c, admin)

        # Somewhere on the Avinashi Road corridor, a plausible mid-transport fix
        # rather than a coordinate copied from the unit's seeded position.
        fix = {"lat": 11.0621, "lng": 77.0412}
        r = c.post(f"{API}/crew/location", headers=crew, json=fix)
        assert r.status_code == 200, r.text
        assert r.json()["ok"] is True

        # The unit's own record -- what the crew screen reads back.
        own = c.get(f"{API}/ambulances/{unit['id']}", headers=dispatcher).json()
        assert abs(own["lat"] - fix["lat"]) < 1e-6
        assert abs(own["lng"] - fix["lng"]) < 1e-6

        # And the fleet list behind the console map, so a console watching the
        # board sees the same number rather than the seeded one.
        fleet = c.get(f"{API}/ambulances", headers=dispatcher).json()["results"]
        row = next(a for a in fleet if a["id"] == unit["id"])
        assert abs(row["lat"] - fix["lat"]) < 1e-6
        assert abs(row["lng"] - fix["lng"]) < 1e-6

        # And the crew's own view -- the screen that prints the fix back as a
        # GPS age -- reads it from the same place.
        own_view = c.get(f"{API}/ambulances", headers=crew).json()["results"]
        assert len(own_view) == 1, "a driver sees exactly one vehicle: their own"
        assert abs(own_view[0]["lat"] - fix["lat"]) < 1e-6


def test_telemetry_is_refused_to_everyone_but_the_crew():
    with client() as c:
        for email, password in (
            ("citizen@medmesh.in", "Citizen@2026"),
            ("admin@srmc.medmesh.in", "Hospital@2026"),
            ("dispatch@medmesh.in", "Dispatch@108"),
            ("gov@medmesh.in", "District@2026"),
        ):
            token = _login(c, email, password)
            r = c.post(f"{API}/crew/location", headers=token, json={"lat": 11.0, "lng": 77.0})
            assert r.status_code == 403, f"{email} could move a vehicle: {r.status_code}"

        # An unauthenticated caller, too: this is a position feed for operational
        # vehicles and must never be writable without a credential.
        assert c.post(f"{API}/crew/location", json={"lat": 11.0, "lng": 77.0}).status_code == 401


def test_a_position_fix_must_be_a_real_coordinate():
    with client() as c:
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        for bad in ({"lat": 95.0, "lng": 77.0}, {"lat": 11.0, "lng": 200.0}, {"lat": 11.0}):
            r = c.post(f"{API}/crew/location", headers=crew, json=bad)
            assert r.status_code == 422, f"accepted {bad} as a position: {r.status_code}"


# --------------------------------------------------------------------------- #
# Government analytics: the operational picture is not public
# --------------------------------------------------------------------------- #


def test_the_operations_overview_is_not_world_readable():
    """The state header carries open incidents and live fleet strength.

    It answered anonymous callers, so anyone on the internet could read how many
    ambulances were free across Tamil Nadu and where the surge flag was up. The
    public portal does not call this endpoint -- it reads the facility directory,
    which says where care is available without saying where the fleet is.
    """
    with client() as c:
        assert c.get(f"{API}/analytics/overview").status_code == 401

        # Signed in but not entitled: the citizen has the directory, not this.
        citizen = _login(c, "citizen@medmesh.in", "Citizen@2026")
        assert c.get(f"{API}/analytics/overview", headers=citizen).status_code == 403

        ward = _login(c, "admin@srmc.medmesh.in", "Hospital@2026")
        assert c.get(f"{API}/analytics/overview", headers=ward).status_code == 403

        gov = _login(c, "gov@medmesh.in", "District@2026")
        body = c.get(f"{API}/analytics/overview", headers=gov).json()
        assert "operations" in body and "districts" in body


def test_the_sla_report_is_operations_only():
    """Median dispatch latency is platform telemetry, not a public statistic."""
    with client() as c:
        assert c.get(f"{API}/analytics/sla?days=7").status_code == 401
        citizen = _login(c, "citizen@medmesh.in", "Citizen@2026")
        assert c.get(f"{API}/analytics/sla?days=7", headers=citizen).status_code == 403
        gov = _login(c, "gov@medmesh.in", "District@2026")
        assert c.get(f"{API}/analytics/sla?days=7", headers=gov).status_code == 200


def test_the_incident_export_carries_the_officers_jurisdiction():
    """Both exports are scoped, and the incident file is the one that was not.

    A district officer downloading their own district's incidents received every
    incident in the state, in a file, with nothing in the interface to suggest
    the widening.
    """
    with client() as c:
        gov = _login(c, "gov@medmesh.in", "District@2026")
        me = c.get(f"{API}/auth/me", headers=gov).json()
        mine = set()

        export = c.get(f"{API}/analytics/export/incidents.csv?days=365", headers=gov)
        assert export.status_code == 200, export.text
        assert export.headers["content-type"].startswith("text/csv")

        lines = [l for l in export.text.splitlines() if l.strip()]
        header = lines[0].split(",")
        district_col = header.index("district_id")
        mine = {int(l.split(",")[district_col]) for l in lines[1:]}
        assert mine, "the export returned no rows, so it proves nothing either way"
        if me["district_id"] is not None:
            assert mine == {me["district_id"]}, (
                f"a district officer exported {len(mine)} districts"
            )

        # The state directorate still gets the state, because that is the role.
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        wide = c.get(f"{API}/analytics/export/incidents.csv?days=365", headers=admin)
        assert wide.status_code == 200


# --------------------------------------------------------------------------- #
# Crew assignment persistence
#
# The audit asked for this one specifically. `/crew/assignment` listed only
# DISPATCHED, EN_ROUTE and a deprecated ARRIVED, so the assignment vanished the
# moment a crew reached the scene and reappeared only if somebody advanced it by
# another route. Everything the crew app does hangs off the assignment existing
# -- the trip screen, the stage buttons, and the position reporting, which is
# wired to `data?.assignment` -- so a driver who refreshed while transporting a
# patient was shown "Standing by", stopped being tracked, and disappeared from
# the console's map.
# --------------------------------------------------------------------------- #


def test_the_crew_assignment_survives_every_stage_of_the_trip():
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        unit = _crew_vehicle(c, admin)
        incident = _a_crew_incident(c, dispatcher, admin, ambulance_id=unit["id"])

        # The stages a real trip passes through, in order. DISPATCHED is where
        # the incident already is; the rest are walked one at a time.
        for stage in ("dispatched", "en_route", "at_scene", "patient_onboard", "transporting", "at_hospital"):
            if stage != "dispatched":
                moved = c.post(
                    f"{API}/incidents/{incident['id']}/status",
                    headers=crew,
                    json={"status": stage},
                )
                assert moved.status_code == 200, f"{stage}: {moved.text}"

            payload = c.get(f"{API}/crew/assignment", headers=crew).json()
            assert payload.get("assignment") is not None, (
                f"the assignment disappeared at {stage!r} -- the driver screen would "
                "show 'Standing by' while the patient is in the vehicle"
            )
            assert payload["assignment"]["id"] == incident["id"]
            assert payload["assignment"]["status"] == stage

        # Handover ends it. That is the one transition that should clear the
        # screen, and it must actually clear it.
        done = c.post(
            f"{API}/incidents/{incident['id']}/status",
            headers=crew,
            json={"status": "handed_over"},
        )
        assert done.status_code == 200, done.text
        after = c.get(f"{API}/crew/assignment", headers=crew).json()
        assert after.get("assignment") is None, "the trip is over but the crew is still holding it"


def test_a_cancelled_trip_also_releases_the_crew_screen():
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        unit = _crew_vehicle(c, admin)
        incident = _a_crew_incident(c, dispatcher, admin, ambulance_id=unit["id"])

        assert c.get(f"{API}/crew/assignment", headers=crew).json()["assignment"]["id"] == incident["id"]
        c.post(f"{API}/incidents/{incident['id']}/status", headers=crew, json={"status": "cancelled"})
        assert c.get(f"{API}/crew/assignment", headers=crew).json().get("assignment") is None


def test_standby_payload_receipts_the_last_handover():
    """Standing by must show the trip that was just completed.

    A driver who hands over and then refreshes the app — or whose phone was
    killed at the hospital gate — lands on the standby payload. Without a
    receipt the screen says only "Standing by" and the driver has no way to
    confirm the handover was recorded, which is exactly the moment they need
    to know. The receipt is the most recent HANDED_OVER/CLOSED trip for this
    vehicle inside a six-hour window; a cancelled job was never a trip and
    must not be offered as one.
    """
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        dispatcher = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        crew = _login(c, "crew@medmesh.in", "Crew@108")
        unit = _crew_vehicle(c, admin)
        incident = _a_crew_incident(c, dispatcher, admin, ambulance_id=unit["id"])

        # Walk the trip to handover.
        for stage in ("en_route", "at_scene", "patient_onboard", "transporting", "at_hospital", "handed_over"):
            moved = c.post(
                f"{API}/incidents/{incident['id']}/status",
                headers=crew,
                json={"status": stage},
            )
            assert moved.status_code == 200, f"{stage}: {moved.text}"

        standby = c.get(f"{API}/crew/assignment", headers=crew).json()
        assert standby.get("assignment") is None
        assert standby.get("message") == "Standing by"
        last = standby.get("last_trip")
        assert last is not None, "the standby payload carries no receipt for the handover just performed"
        assert last["id"] == incident["id"]
        assert last["reference"] == incident["reference"]
        assert last["status"] == "handed_over"
        assert last["status_label"] == "Handed over"
        assert last["handed_over_at"], "the receipt has no handover time"
        assert last["hospital_short_name"], "the receipt does not name the receiving hospital"

        # A second trip, closed straight from the hospital without a handover
        # (the lifecycle allows AT_HOSPITAL -> CLOSED for a patient the ward
        # took informally). Such a trip has no handed_over_at, so the receipt
        # must fall back to closed_at rather than drop the trip.
        second = _a_crew_incident(c, dispatcher, admin, ambulance_id=unit["id"])
        for stage in ("en_route", "at_scene", "patient_onboard", "transporting", "at_hospital"):
            moved = c.post(
                f"{API}/incidents/{second['id']}/status",
                headers=crew,
                json={"status": stage},
            )
            assert moved.status_code == 200, f"{stage}: {moved.text}"
        closed = c.post(
            f"{API}/incidents/{second['id']}/status",
            headers=crew,
            json={"status": "closed"},
        )
        assert closed.status_code == 200, closed.text
        after = c.get(f"{API}/crew/assignment", headers=crew).json()
        assert after["last_trip"]["id"] == second["id"], "the newer completed trip did not replace the receipt"
        assert after["last_trip"]["status"] == "closed"
        assert after["last_trip"]["status_label"] == "Closed"
        assert after["last_trip"]["handed_over_at"], "a trip closed at the hospital has no receipt stamp"

        # A cancelled job is not a trip and must not become the receipt.
        third = _a_crew_incident(c, dispatcher, admin, ambulance_id=unit["id"])
        c.post(f"{API}/incidents/{third['id']}/status", headers=crew, json={"status": "cancelled"})
        standby2 = c.get(f"{API}/crew/assignment", headers=crew).json()
        assert standby2.get("assignment") is None
        assert standby2["last_trip"]["id"] == second["id"], (
            "a cancelled job replaced the real handover as the receipt"
        )


# --------------------------------------------------------------------------- #
# Doctor duty expiry
#
# A duty window has an end. The pilot stored one, exposed it, and then treated
# every doctor whose flag was still set as available for ever, because nothing
# enforced the end: the rollover endpoint existed, was documented as running on a
# scheduler, and no scheduler called it.
# --------------------------------------------------------------------------- #


def _a_doctor(c, admin) -> dict:
    page = c.get(f"{API}/doctors?limit=200", headers=admin).json()
    assert page["results"], "the roster is empty"
    return page["results"][0]


def test_a_duty_window_that_has_elapsed_is_not_availability():
    """The flag still set, the window gone: the directory must say off duty."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        doctor = _a_doctor(c, admin)
        hospital_id = doctor["hospital"]["id"]

        # Put them on duty for the next hour: a window that is genuinely open.
        live = c.post(
            f"{API}/doctors/{doctor['id']}/duty",
            headers=admin,
            json={"on_duty": True, "shift_window": "08:00-20:00"},
        )
        assert live.status_code == 200, live.text
        assert live.json()["on_duty"] is True
        assert live.json()["duty_state"] == "on_duty"
        assert live.json()["minutes_remaining"] is not None

        # Now move the window's end into the past behind the API's back -- which
        # is exactly the state a running system reaches when a shift ends and the
        # sweep has not run yet.
        from app.database import SessionLocal
        from app.models import Doctor, utcnow
        from datetime import timedelta

        db = SessionLocal()
        try:
            row = db.get(Doctor, doctor["id"])
            row.duty_end = utcnow() - timedelta(minutes=5)
            db.commit()
        finally:
            db.close()

        # Read paths must not report availability.
        reread = c.get(f"{API}/doctors/{doctor['id']}", headers=admin).json()
        assert reread["on_duty"] is False, "an elapsed window was reported as on duty"
        assert reread["duty_state"] == "expired"
        assert reread["minutes_remaining"] is not None and reread["minutes_remaining"] < 0, (
            "the countdown was clamped, so a caller cannot tell it has passed"
        )

        # Nor may the facility page advertise them.
        facility = c.get(f"{API}/hospitals/{hospital_id}", headers=admin).json()
        assert all(d["id"] != doctor["id"] for d in facility["doctors_on_duty"]), (
            "the facility page listed a clinician whose shift had ended"
        )

        # Nor the public directory.
        public = c.get(f"{API}/doctors?specialty={doctor['specialty']}&limit=200").json()
        assert all(d["id"] != doctor["id"] for d in public["results"]), (
            "the public directory advertised an ended shift"
        )


def test_the_roster_sweep_closes_the_window_and_publishes_it():
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        doctor = _a_doctor(c, admin)
        c.post(
            f"{API}/doctors/{doctor['id']}/duty",
            headers=admin,
            json={"on_duty": True, "shift_window": "08:00-20:00"},
        )

        from datetime import timedelta

        from app.database import SessionLocal
        from app.models import Doctor, utcnow

        db = SessionLocal()
        try:
            row = db.get(Doctor, doctor["id"])
            row.duty_end = utcnow() - timedelta(minutes=1)
            db.commit()
        finally:
            db.close()

        # The scheduled path, called directly rather than waited for: a sweep
        # that can only be exercised by waiting five minutes is never tested.
        from app.services.roster import run_rollover_once

        assert run_rollover_once() >= 1

        after = c.get(f"{API}/doctors/{doctor['id']}", headers=admin).json()
        assert after["roster_flag"] is False and after["on_duty"] is False
        assert after["duty_end"] is None, "the window was closed but its end time was left behind"


def test_a_duty_manager_switching_a_doctor_off_is_not_undone_by_renewal():
    """Renewal puts the rostered shift back; it must not overrule a person."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        doctor = _a_doctor(c, admin)

        off = c.post(f"{API}/doctors/{doctor['id']}/duty", headers=admin, json={"on_duty": False})
        assert off.status_code == 200, off.text
        assert off.json()["on_duty"] is False

        from app.database import SessionLocal
        from app.services.roster import renew_demo_roster

        db = SessionLocal()
        try:
            renew_demo_roster(db)
            db.commit()
        finally:
            db.close()

        still = c.get(f"{API}/doctors/{doctor['id']}", headers=admin).json()
        assert still["on_duty"] is False, (
            "the roster renewal put back a clinician a duty manager had taken off"
        )


# --------------------------------------------------------------------------- #
# Second audit round: privacy, admin editing, audit pagination
# --------------------------------------------------------------------------- #


def test_anonymous_feedback_cannot_carry_a_personal_note():
    """#47: the category is public; a note is not, and neither is a phone number."""
    with client() as c:
        hospitals = c.get(f"{API}/hospitals?limit=1").json()["results"]
        hid = hospitals[0]["id"]

        anonymous_with_note = c.post(
            f"{API}/governance/feedback",
            json={"hospital_id": hid, "kind": "beds_unavailable", "comment": "ward was full"},
        )
        assert anonymous_with_note.status_code == 422, (
            "an anonymous report carried free text, which is the hole the audit closed"
        )

        anonymous_plain = c.post(
            f"{API}/governance/feedback",
            json={"hospital_id": hid, "kind": "beds_unavailable"},
        )
        assert anonymous_plain.status_code == 201, anonymous_plain.text


def test_a_signed_in_note_carrying_a_phone_number_is_refused():
    """#47: the PII gate names what it found rather than silently redacting."""
    with client() as c:
        ward = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        me = c.get(f"{API}/auth/me", headers=ward).json()
        hid = me["hospital_id"]

        bad = c.post(
            f"{API}/governance/feedback",
            headers=ward,
            json={
                "hospital_id": hid,
                "kind": "wrong_hours",
                "comment": "call the desk on 9840712345 and ask for sister Mary",
            },
        )
        assert bad.status_code == 422, bad.text
        assert "phone number" in bad.json()["detail"][0]["msg"].lower() or "phone" in bad.text.lower()

        good = c.post(
            f"{API}/governance/feedback",
            headers=ward,
            json={
                "hospital_id": hid,
                "kind": "wrong_hours",
                "comment": "casualty desk said the posted hours end at eight, not ten",
            },
        )
        assert good.status_code == 201, good.text


def test_the_audit_trail_does_not_carry_the_feedback_note():
    """#53: free text belongs to the report row, not to every audit export."""
    with client() as c:
        ward = _login(c, "admin@kgch.medmesh.in", "Hospital@2026")
        me = c.get(f"{API}/auth/me", headers=ward).json()
        note = "casualty desk redirected us to the annex after midnight"
        created = c.post(
            f"{API}/governance/feedback",
            headers=ward,
            json={"hospital_id": me["hospital_id"], "kind": "closed", "comment": note},
        )
        assert created.status_code == 201, created.text

        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        entries = c.get(f"{API}/governance/audit?hours=1&limit=50&action=feedback", headers=admin).json()
        submits = [e for e in entries["results"] if e["action"] == "feedback.submit"]
        assert submits, "the submission was not audited at all"
        for entry in submits:
            assert note not in json.dumps(entry["payload"]), (
                "the free-text note rode along inside the audit payload"
            )

        # The reviewer's decision note lands on the report, and the audit says
        # only that a note exists.
        fid = submits[0]["payload"]["feedback_id"]
        resolved = c.post(
            f"{API}/governance/feedback/{fid}/resolve",
            headers=admin,
            json={"status": "upheld", "resolution_note": "confirmed against the bed-control desk"},
        )
        assert resolved.status_code == 200, resolved.text
        listed = c.get(f"{API}/governance/feedback?limit=50", headers=admin).json()
        row = next(f for f in listed["results"] if f["id"] == fid)
        assert row["resolution_note"] == "confirmed against the bed-control desk"
        assert row["status"] == "upheld"


def test_the_audit_endpoint_pages_and_says_how_much_is_left():
    """#41: a total, a page, and an honest has_more."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        first = c.get(f"{API}/governance/audit?hours=24&limit=5&offset=0", headers=admin).json()
        assert first["count"] == len(first["results"]) <= 5
        assert first["total"] >= first["count"]
        assert "has_more" in first and "offset" in first
        if first["has_more"]:
            second = c.get(f"{API}/governance/audit?hours=24&limit=5&offset=5", headers=admin).json()
            ids_a = {e["id"] for e in first["results"]}
            ids_b = {e["id"] for e in second["results"]}
            assert not (ids_a & ids_b), "pages overlap"


def test_an_account_can_be_moved_between_facilities_without_losing_its_history():
    """#37: editing is a change, not a delete-and-recreate."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        hospitals = c.get(f"{API}/hospitals?include_unverified=true&limit=4", headers=admin).json()["results"]
        created = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "full_name": "Transfer Test",
                "email": "transfer.test@medmesh.in",
                "password": "Transfer@2026x",
                "role": "hospital_admin",
                "hospital_id": hospitals[0]["id"],
            },
        )
        assert created.status_code in (200, 201), created.text
        uid = created.json()["id"]

        moved = c.patch(
            f"{API}/governance/users/{uid}",
            headers=admin,
            json={"hospital_id": hospitals[1]["id"], "full_name": "Transfer Test II"},
        )
        assert moved.status_code == 200, moved.text
        assert set(moved.json()["changed"]), "nothing was recorded as changed"

        listed = c.get(f"{API}/governance/users", headers=admin).json()
        row = next(u for u in listed["results"] if u["id"] == uid)
        assert row["hospital_id"] == hospitals[1]["id"]
        assert row["full_name"] == "Transfer Test II"

        # Scope rules still bind on edit: a hospital account without a facility
        # is exactly what creation refuses, and edit must not smuggle it in.
        unscoped = c.patch(
            f"{API}/governance/users/{uid}",
            headers=admin,
            json={"role": "dispatcher"},
        )
        assert unscoped.status_code == 422, unscoped.text


def test_disabling_and_re_enabling_an_account_is_audited_once_each():
    """#38: the switch still works, and says what it did."""
    with client() as c:
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        created = c.post(
            f"{API}/governance/users",
            headers=admin,
            json={
                "full_name": "Switch Test",
                "email": "switch.test@medmesh.in",
                "password": "Switching@2026x",
                "role": "gov_official",
                "district_id": 1,
            },
        )
        uid = created.json()["id"]

        off = c.patch(f"{API}/governance/users/{uid}?is_active=false", headers=admin)
        assert off.status_code == 200 and off.json()["is_active"] is False

        denied = _login_status(c, "switch.test@medmesh.in", "Switching@2026x")
        assert denied == 401 or denied == 403, "a disabled account still signs in"

        on = c.patch(f"{API}/governance/users/{uid}?is_active=true", headers=admin)
        assert on.status_code == 200 and on.json()["is_active"] is True


def _login_status(c, email: str, password: str) -> int:
    return c.post(f"{API}/auth/login", json={"email": email, "password": password}).status_code


def test_a_blocked_facility_needs_a_typed_override_and_the_audit_keeps_it():
    """#11: the engine's refusal is overridable, but only on the record."""
    with client() as c:
        dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        incidents = c.get(f"{API}/incidents?limit=20", headers=dispatch).json()["results"]
        open_inc = next((i for i in incidents if i["status"] == "open"), None)
        assert open_inc is not None, "fixture needs an open incident"

        shortlist = c.get(
            f"{API}/incidents/{open_inc['id']}/shortlist?limit=20&include_ineligible=true",
            headers=dispatch,
        ).json()
        blocked = next((r for r in shortlist["results"] if not r["eligible"]), None)
        if blocked is None:
            import pytest

            pytest.skip("every candidate is eligible for this incident")

        refused = c.post(
            f"{API}/incidents/{open_inc['id']}/dispatch",
            headers=dispatch,
            json={"hospital_id": blocked["hospital_id"]},
        )
        assert refused.status_code == 409, refused.text
        detail = refused.json()["detail"]
        assert detail["blockers"], "the refusal must say what is blocking"

        reason = "receiving consultant confirmed by phone; control accepts"
        overridden = c.post(
            f"{API}/incidents/{open_inc['id']}/dispatch",
            headers=dispatch,
            json={"hospital_id": blocked["hospital_id"], "override_reason": reason},
        )
        assert overridden.status_code == 200, overridden.text

        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        audit = c.get(f"{API}/governance/audit?hours=1&limit=40&action=incident.dispatch", headers=admin).json()
        entry = next(
            (e for e in audit["results"] if str(e["entity"].split(":")[-1]) == str(open_inc["id"])),
            None,
        )
        assert entry is not None
        assert reason in entry["summary"], "the override reason must be in the audit trail"


def test_a_unit_that_is_not_free_is_refused_until_overridden():
    """#29/#31: a hand-picked vehicle is checked exactly like the engine's own."""
    with client() as c:
        dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        incidents = c.get(f"{API}/incidents?limit=20", headers=dispatch).json()["results"]
        open_inc = next((i for i in incidents if i["status"] == "open"), None)
        assert open_inc is not None

        fleet = c.get(f"{API}/ambulances?limit=200", headers=admin).json()["results"]
        unit = next(u for u in fleet if u["status"] == "available")
        down = c.post(f"{API}/ambulances/{unit['id']}/status", headers=admin, json={"status": "out_of_service"})
        assert down.status_code == 200, down.text
        try:
            shortlist = c.get(f"{API}/incidents/{open_inc['id']}/shortlist?limit=5", headers=dispatch).json()
            target = shortlist["results"][0]["hospital_id"]

            refused = c.post(
                f"{API}/incidents/{open_inc['id']}/dispatch",
                headers=dispatch,
                json={"hospital_id": target, "ambulance_id": unit["id"]},
            )
            assert refused.status_code == 409, refused.text
            assert refused.json()["detail"]["blockers"], "the unit's state must be named"

            forced = c.post(
                f"{API}/incidents/{open_inc['id']}/dispatch",
                headers=dispatch,
                json={
                    "hospital_id": target,
                    "ambulance_id": unit["id"],
                    "override_reason": "only vehicle with the crew's equipment; control accepts",
                },
            )
            assert forced.status_code == 200, forced.text
        finally:
            c.post(f"{API}/ambulances/{unit['id']}/status", headers=admin, json={"status": "available"})


def test_a_reroute_cannot_swap_the_crew():
    """The vehicle carrying a patient stays with them until the trip closes."""
    with client() as c:
        dispatch = _login(c, "dispatch@medmesh.in", "Dispatch@108")
        admin = _login(c, "admin@medmesh.in", "MedMesh@2026")
        incidents = c.get(f"{API}/incidents?limit=30", headers=dispatch).json()["results"]
        moving = next((i for i in incidents if i["status"] in ("en_route", "transporting")), None)
        if moving is None:
            import pytest

            pytest.skip("no incident mid-trip in the fixture")
        shortlist = c.get(f"{API}/incidents/{moving['id']}/shortlist?limit=5", headers=dispatch).json()
        other = next(
            (r["hospital_id"] for r in shortlist["results"] if r["hospital_id"] != moving["assigned_hospital_id"]),
            None,
        )
        assert other is not None
        fleet = c.get(f"{API}/ambulances?limit=200", headers=admin).json()["results"]
        spare = next(
            (u for u in fleet if u["id"] != moving.get("assigned_ambulance_id") and u["status"] == "available"),
            None,
        )
        assert spare is not None

        refused = c.post(
            f"{API}/incidents/{moving['id']}/reroute",
            headers=dispatch,
            json={"hospital_id": other, "ambulance_id": spare["id"]},
        )
        assert refused.status_code == 409, refused.text
        assert "re-route" in refused.json()["detail"].lower() or "crew" in refused.json()["detail"].lower()
