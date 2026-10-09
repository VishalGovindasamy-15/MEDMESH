with open("app/routers/dispatch.py", "r") as f:
    content = f.read()

old_code = """            inc = Incident(
                reference=f"{parent.reference}-{i+1}",
                category=parent.category,
                urgency=parent.urgency,
                lat=parent.lat,
                lng=parent.lng,
                landmark=parent.landmark,
                district_id=parent.district_id,
                taluk=parent.taluk,
                location_source=parent.location_source,
                patient_state=parent.patient_state,
                casualty_count=1,
                mechanism=parent.mechanism,
                created_by=parent.created_by,
                status=IncidentStatus.OPEN
            )"""

new_code = """            inc = Incident(
                reference=f"{parent.reference}-{i+1}",
                category=parent.category,
                urgency=parent.urgency,
                lat=parent.lat,
                lng=parent.lng,
                landmark=parent.landmark,
                district_id=parent.district_id,
                taluk=parent.taluk,
                location_source=parent.location_source,
                patient_state=parent.patient_state,
                casualty_count=1,
                mechanism=parent.mechanism,
                bleeding=parent.bleeding,
                hazard=parent.hazard,
                trapped=parent.trapped,
                bystander_cpr=parent.bystander_cpr,
                observations=parent.observations,
                required_specialty=parent.required_specialty,
                requires_icu=parent.requires_icu,
                requires_ventilator=parent.requires_ventilator,
                requires_blood=parent.requires_blood,
                created_by=parent.created_by,
                status=IncidentStatus.OPEN
            )"""

if old_code in content:
    content = content.replace(old_code, new_code)
    with open("app/routers/dispatch.py", "w") as f:
        f.write(content)
    print("Patched correctly.")
else:
    print("old_code not found.")
