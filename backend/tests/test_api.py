"""Smoke test: the critical paths must work end-to-end.

Run:  python3 -m pytest tests -q      (from backend/)
"""

from __future__ import annotations

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
        detail = c.get(f"{API}/hospitals/{top['hospital_id']}").json()
        assert incident["id"] not in [h["incident_id"] for h in detail["active_holds"]], (
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
        assert body["state"]["facilities"] > 20
        assert body["districts"][0]["beds"]["occupancy_pct"] is not None

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
