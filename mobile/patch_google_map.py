with open("src/components/GoogleMap.web.tsx", "r") as f:
    content = f.read()

# Add import
old_import = "import { MapPoint } from './mapTypes';"
new_import = "import { MapPoint, pinFill, freshnessOf, RING_COLOUR, pinRadius } from './mapTypes';"
if old_import in content:
    content = content.replace(old_import, new_import)

# Replace marker color logic
old_marker = """        {points.map((p) => {
          const isSelected = selectedId === p.id;
          const color = p.tone === 'live' ? t.status.live.base : 
                        p.tone === 'warm' ? t.status.warm.base : 
                        p.tone === 'critical' ? t.status.critical.base : t.fg.muted;
          return (
            <Marker 
              key={p.id}
              position={[p.lat, p.lng]} 
              icon={createIcon(color, isSelected)}"""

new_marker = """        {points.map((p) => {
          const isSelected = selectedId === p.id;
          const fill = pinFill(p);
          const freshness = freshnessOf(p);
          const stroke = RING_COLOUR[freshness];
          return (
            <Marker 
              key={p.id}
              position={[p.lat, p.lng]} 
              icon={createIcon(fill, isSelected, stroke)}"""

if old_marker in content:
    content = content.replace(old_marker, new_marker)
else:
    print("could not find old_marker")

# Update createIcon signature and implementation
old_icon = """const createIcon = (color: string, isSelected: boolean) => {
  const size = isSelected ? 24 : 16;
  const stroke = isSelected ? '#fff' : 'rgba(255,255,255,0.8)';"""

new_icon = """const createIcon = (color: string, isSelected: boolean, strokeColor: string = '#fff') => {
  const size = isSelected ? 24 : 16;
  const stroke = isSelected ? '#fff' : strokeColor;"""

if old_icon in content:
    content = content.replace(old_icon, new_icon)
else:
    print("could not find old_icon")

with open("src/components/GoogleMap.web.tsx", "w") as f:
    f.write(content)
print("Patched GoogleMap")
