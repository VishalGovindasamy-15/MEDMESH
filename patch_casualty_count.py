with open("mobile/app/console/index.tsx", "r") as f:
    content = f.read()

# 1. Update initial state
old_init = """  const [scene, setScene] = useState({
    patient_state: 'unknown',
    mechanism: 'none',
    bleeding: 'none',
    hazard: 'none',
    casualty_count: 1,
    trapped: false,
    bystander_cpr: false,
  });"""
new_init = """  const [scene, setScene] = useState({
    patient_state: 'unknown',
    mechanism: 'none',
    bleeding: 'none',
    hazard: 'none',
    casualty_count: '1',
    trapped: false,
    bystander_cpr: false,
  });"""
content = content.replace(old_init, new_init)

# 2. Update reset state
old_reset = """      setScene({
        patient_state: 'unknown',
        mechanism: 'none',
        bleeding: 'none',
        hazard: 'none',
        casualty_count: 1,
        trapped: false,
        bystander_cpr: false,
      });"""
new_reset = """      setScene({
        patient_state: 'unknown',
        mechanism: 'none',
        bleeding: 'none',
        hazard: 'none',
        casualty_count: '1',
        trapped: false,
        bystander_cpr: false,
      });"""
content = content.replace(old_reset, new_reset)

# 3. Update router push condition
old_push = """      if (scene.casualty_count > 1) {"""
new_push = """      if ((parseInt(scene.casualty_count, 10) || 1) > 1) {"""
content = content.replace(old_push, new_push)

# 4. Update TextField
old_text = """          <TextField
            value={String(scene.casualty_count)}
            onChangeText={(v) => {
              const parsed = parseInt(v, 10);
              if (!isNaN(parsed) && parsed > 0) {
                setScene((p) => ({ ...p, casualty_count: parsed }));
              } else if (v === '') {
                // allow clearing, handle invalid gracefully
                setScene((p) => ({ ...p, casualty_count: 1 }));
              }
            }}"""
new_text = """          <TextField
            value={scene.casualty_count}
            onChangeText={(v) => {
              const clean = v.replace(/[^0-9]/g, '');
              setScene((p) => ({ ...p, casualty_count: clean }));
            }}"""
content = content.replace(old_text, new_text)

# 5. Update payload
old_payload = """          ...scene,"""
new_payload = """          ...scene,
          casualty_count: parseInt(scene.casualty_count, 10) || 1,"""
content = content.replace(old_payload, new_payload)

# 6. Update buttons
old_btn = """          label={scene.casualty_count > 1 ? `Create incident & Plan MCI (${scene.casualty_count} units)` : "Create incident & find hospital"}
          variant={scene.casualty_count > 1 ? "danger" : "primary"}"""
new_btn = """          label={(parseInt(scene.casualty_count, 10) || 1) > 1 ? `Create incident & Plan MCI (${parseInt(scene.casualty_count, 10) || 1} units)` : "Create incident & find hospital"}
          variant={(parseInt(scene.casualty_count, 10) || 1) > 1 ? "danger" : "primary"}"""
content = content.replace(old_btn, new_btn)

with open("mobile/app/console/index.tsx", "w") as f:
    f.write(content)
print("Patched console UI")
