with open("src/components/GoogleMap.web.tsx", "r") as f:
    content = f.read()

old_icon = """  const createIcon = (color: string, isSelected: boolean) => {
    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background-color: ${color};
        width: ${isSelected ? '24px' : '16px'};
        height: ${isSelected ? '24px' : '16px'};
        border-radius: 50%;
        border: 2px solid white;"""

new_icon = """  const createIcon = (color: string, isSelected: boolean, strokeColor: string = 'white') => {
    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background-color: ${color};
        width: ${isSelected ? '24px' : '16px'};
        height: ${isSelected ? '24px' : '16px'};
        border-radius: 50%;
        border: 2px solid ${strokeColor};"""

if old_icon in content:
    content = content.replace(old_icon, new_icon)
    with open("src/components/GoogleMap.web.tsx", "w") as f:
        f.write(content)
    print("Patched createIcon")
else:
    print("could not find old_icon")
