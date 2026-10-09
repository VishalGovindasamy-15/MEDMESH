with open("src/components/GoogleMap.web.tsx", "r") as f:
    content = f.read()

old_map = """      <MapContainer 
        center={[defaultCenter.lat, defaultCenter.lng]} 
        zoom={zoom} 
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={false}
      >"""

new_map = """      <MapContainer 
        center={[defaultCenter.lat, defaultCenter.lng]} 
        zoom={zoom} 
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={false}
        attributionControl={false}
      >"""

old_tile = """        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />"""

new_tile = """        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        />"""

if old_map in content:
    content = content.replace(old_map, new_map)
    print("Patched MapContainer")
if old_tile in content:
    content = content.replace(old_tile, new_tile)
    print("Patched TileLayer")

with open("src/components/GoogleMap.web.tsx", "w") as f:
    f.write(content)
