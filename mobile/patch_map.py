with open("src/components/MapSurface.tsx", "r") as f:
    content = f.read()

old_code = """      {showLegend ? (
        <Row gap={space.md} wrap align="center">
          {google ? (
            <Row gap={space.xs} align="center" style={{ flexShrink: 1 }}>
              <Small muted numberOfLines={1}>Basemap · OpenStreetMap</Small>
            </Row>
          ) : (
            /* flexShrink + numberOfLines: this sentence is longer than a 360px
               phone, and RN-web text will not shrink below its content width
               unless the row says so — the legend was the widest element on
               the crew screen at small viewports. */
            <Row gap={space.xs} align="center" style={{ flexShrink: 1 }}>

            </Row>
          )}
          <LegendDot tone="live" label="ICU free" />
          <LegendDot tone="warm" label="Beds only" />
          <LegendDot tone="critical" label="At capacity" />
          <LegendDot tone="neutral" label="No live data" />
          {routing ? <Small muted style={{ flexShrink: 1 }}>Resolving road route…</Small> : null}
          {resolved ? (
            <Small muted style={{ flexShrink: 1 }} numberOfLines={2}>
              Directions: {resolved.distanceKm.toFixed(1)} km · {resolved.durationMinutes} min
              {resolved.summary ? ` via ${resolved.summary}` : ''}
            </Small>
          ) : null}
          {route && !resolved && !routing && hasDirections() ? (
            <Small muted style={{ flexShrink: 1 }} numberOfLines={2}>Directions unavailable — corridor shown is an estimate</Small>
          ) : null}
        </Row>
      ) : null}"""

new_code = """      {showLegend ? (
        <Row gap={space.md} wrap align="center">
          {routing ? <Small muted style={{ flexShrink: 1 }}>Resolving road route…</Small> : null}
          {resolved ? (
            <Small muted style={{ flexShrink: 1 }} numberOfLines={2}>
              Directions: {resolved.distanceKm.toFixed(1)} km · {resolved.durationMinutes} min
              {resolved.summary ? ` via ${resolved.summary}` : ''}
            </Small>
          ) : null}
          {route && !resolved && !routing && hasDirections() ? (
            <Small muted style={{ flexShrink: 1 }} numberOfLines={2}>Directions unavailable — corridor shown is an estimate</Small>
          ) : null}
        </Row>
      ) : null}"""

if old_code in content:
    content = content.replace(old_code, new_code)
    with open("src/components/MapSurface.tsx", "w") as f:
        f.write(content)
    print("Patched successfully")
else:
    print("Could not find old_code")
