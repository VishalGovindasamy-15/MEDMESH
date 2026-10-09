with open("app/routers/dispatch.py", "r") as f:
    content = f.read()

old_code = """    dispatched_incidents = []

    for i, assignment in enumerate(payload.assignments):
        amb = db.get(Ambulance, assignment.ambulance_id)
        hosp = db.get(Hospital, assignment.hospital_id)
        
        if amb is None or hosp is None:
            continue

        if amb.status != AmbulanceStatus.AVAILABLE:
            continue

        # Use the parent incident for the first one, create clones for the rest
        if i == 0:
            inc = parent
            inc.casualty_count = 1
        else:
            inc = Incident(
                reference=f"{parent.reference}-{i+1}","""

new_code = """    dispatched_incidents = []
    original_reference = parent.reference

    for i, assignment in enumerate(payload.assignments):
        amb = db.get(Ambulance, assignment.ambulance_id)
        hosp = db.get(Hospital, assignment.hospital_id)
        
        if amb is None or hosp is None:
            continue

        if amb.status != AmbulanceStatus.AVAILABLE:
            continue

        # Use the parent incident for the first one, create clones for the rest
        if i == 0:
            inc = parent
            inc.casualty_count = 1
            inc.reference = f"{original_reference}-1"
        else:
            inc = Incident(
                reference=f"{original_reference}-{i+1}","""

if old_code in content:
    content = content.replace(old_code, new_code)
    with open("app/routers/dispatch.py", "w") as f:
        f.write(content)
    print("Patched correctly.")
else:
    print("old_code not found.")
