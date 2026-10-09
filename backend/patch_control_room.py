with open("app/simulator.py", "r") as f:
    content = f.read()

# Replace the where clause in _control_room_tick
old_code = """            candidate = scout.execute(
                select(Incident)
                .where(Incident.status == IncidentStatus.OPEN)
                .order_by(Incident.urgency, Incident.created_at)
                .limit(1)
            ).scalars().first()"""

new_code = """            candidate = scout.execute(
                select(Incident)
                .where(
                    Incident.status == IncidentStatus.OPEN,
                    Incident.casualty_count == 1
                )
                .order_by(Incident.urgency, Incident.created_at)
                .limit(1)
            ).scalars().first()"""

if old_code in content:
    content = content.replace(old_code, new_code)
    with open("app/simulator.py", "w") as f:
        f.write(content)
    print("Patched correctly.")
else:
    print("old_code not found.")
