with open("src/components/GoogleMap.web.tsx", "r") as f:
    content = f.read()

new_import = "import { MapPoint, pinFill, freshnessOf, RING_COLOUR } from './mapTypes';\n"
if "import { useTheme }" in content and "import { MapPoint" not in content:
    content = content.replace("import { useTheme }", new_import + "import { useTheme }")
    with open("src/components/GoogleMap.web.tsx", "w") as f:
        f.write(content)
    print("Patched imports")
else:
    print("could not patch imports")
