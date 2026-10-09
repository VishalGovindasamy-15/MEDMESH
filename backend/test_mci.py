import requests

# 1. Login as dispatcher
r = requests.post("http://localhost:8000/api/v1/auth/login", json={"email": "dispatch@medmesh.in", "password": "Dispatch@108"})
token = r.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

# 2. Create MCI
payload = {
    "category": "road_accident",
    "urgency": "P1",
    "lat": 11.0,
    "lng": 77.0,
    "district_id": 4, # Coimbatore
    "location_source": "map",
    "patient_state": "unknown",
    "mechanism": "none",
    "bleeding": "none",
    "hazard": "none",
    "casualty_count": 3,
    "landmark": "Test MCI Landmark"
}
r = requests.post("http://localhost:8000/api/v1/incidents", json=payload, headers=headers)
print("Create:", r.status_code)
inc = r.json()
inc_id = inc["id"]

# 3. Get MCI Plan
r = requests.get(f"http://localhost:8000/api/v1/incidents/{inc_id}/mci-plan", headers=headers)
print("Plan:", r.status_code)
plan = r.json()["plan"]
ambs = r.json()["available_ambulances"]

# 4. Override first patient with a specific ambulance
override_amb = ambs[10]["id"]
print("Overriding patient 1 with amb:", override_amb)
plan[0]["ambulance_id"] = override_amb

# 5. Commit MCI
r = requests.post(f"http://localhost:8000/api/v1/incidents/{inc_id}/mci-commit", json={"assignments": plan}, headers=headers)
print("Commit:", r.status_code)

# 6. Verify what was assigned
r = requests.get(f"http://localhost:8000/api/v1/incidents?limit=10", headers=headers)
incidents = r.json()["results"]
for i in incidents:
    if i["reference"].startswith(inc["reference"]):
        print(i["reference"], i["assigned_ambulance"]["id"] if i["assigned_ambulance"] else None)

