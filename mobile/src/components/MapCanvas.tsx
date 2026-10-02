import React, { useMemo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgTextNode } from 'react-native-svg';

import type { MapPoint } from './mapTypes';
import { freshnessOf, pinRadius, pinTone, RING_COLOUR } from './mapTypes';
import { projectToCanvas, isWeb } from '../lib/format';
import { useTheme } from '../theme/ThemeProvider';
import { mono, space, type as typeScale } from '../theme/tokens';
import { Body, Label, Small } from '../ui';

/**
 * Schematic capacity canvas.
 *
 * This is deliberately *not* a map tile renderer. It is a coordinate-accurate
 * scatter of facilities over a graticule, labelled as schematic in the UI,
 * because shipping a hand-drawn pseudo-map that looks like a real one is how
 * you get someone to trust a spatial relationship that is not there. Every pin
 * position is a true lat/lng projection; only the basemap is absent, and the
 * caption says so.
 *
 * This is the fallback, not the plan. When a Google Maps key is configured,
 * `MapSurface` renders the real basemap instead and never reaches this file.
 * Keeping it working is still worth the code: a pilot district with no Maps
 * billing account has to be able to run the platform, and an offline crew phone
 * cannot fetch tiles at all.
 */

interface Props {
  points: MapPoint[];
  width: number;
  height: number;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  origin?: { lat: number; lng: number } | null;
  originLabel?: string;
  showLabels?: boolean;
  /** Schematic corridor to overlay, when a real route could not be resolved. */
  route?: { origin: { lat: number; lng: number }; destination: { lat: number; lng: number } } | null;
  /**
   * Fixed projection origin. Supplied only by the tap-to-place case: with it,
   * the canvas stops auto-fitting to its own points and draws a stable grid at a
   * known scale, which is the only condition under which a tap can be converted
   * back into a coordinate.
   */
  center?: { lat: number; lng: number } | null;
  zoom?: number | null;
  onPress?: (point: { lat: number; lng: number }) => void;
}

export function MapCanvas({
  points: markers,
  width,
  height,
  selectedId,
  onSelect,
  origin,
  originLabel,
  showLabels = true,
  route = null,
  center = null,
  zoom = null,
  onPress,
}: Props) {
  const { t } = useTheme();
  /** Ref for the tap-to-place layer, used to convert pageX/pageY into
      layer-relative coordinates when locationX/locationY are missing. */
  const tapLayerRef = useRef<View>(null);

  /**
   * Two projection modes.
   *
   * The default auto-fits the canvas to whatever points it is given, which is
   * right for a directory map — the state fills the frame. It is *not* right for
   * a map somebody is about to tap: the frame would move every time a point
   * arrived, so the same tap could mean two different places a second apart.
   *
   * When `center` and `zoom` are supplied the canvas becomes a fixed
   * equirectangular projection anchored on that point, at the same scale as the
   * Google map it is standing in for. A tap then converts back to a coordinate
   * unambiguously, and the pins stay where they were put.
   */
  const fixed = Boolean(center && zoom);
  const projection = useMemo(() => {
    if (fixed && center && zoom) {
      // Web Mercator metres-per-pixel at this latitude and zoom, the same figure
      // the Maps SDK uses, so the two renderings agree at the same zoom level.
      const metresPerPixel = (156543.03392 * Math.cos((center.lat * Math.PI) / 180)) / 2 ** zoom;
      const toXY = (p: { lat: number; lng: number }) => ({
        x: width / 2 + ((p.lng - center.lng) * 111320 * Math.cos((center.lat * Math.PI) / 180)) / metresPerPixel,
        y: height / 2 - ((p.lat - center.lat) * 110540) / metresPerPixel,
      });
      const toLatLng = (x: number, y: number) => {
        // NaN in, NaN out is how a pin ended up at "NaN, NaN": RN-web does not
        // always populate locationX/locationY (Safari, and synthetic events
        // over nested pressables). The caller falls back to pageX/pageY, and
        // this guard turns anything still non-finite into a refusal rather
        // than a coordinate that will be posted to the API.
        if (!Number.isFinite(x) || !Number.isFinite(y)) return { lat: NaN, lng: NaN };
        return {
          lat: center.lat - ((y - height / 2) * metresPerPixel) / 110540,
          lng: center.lng + ((x - width / 2) * metresPerPixel) / (111320 * Math.cos((center.lat * Math.PI) / 180)),
        };
      };
      return { toXY, toLatLng };
    }
    return {
      toXY: (_p: { lat: number; lng: number }) => ({ x: 0, y: 0 }),
      toLatLng: null,
    };
  }, [fixed, center, zoom, width, height]);

  const projected = useMemo(() => {
    const coords = [
      ...markers.map((m) => ({ lat: m.lat, lng: m.lng })),
      ...(origin ? [origin] : []),
      ...(route ? [route.origin, route.destination] : []),
    ];
    if (fixed && center) {
      return coords.map((c) => projection.toXY(c));
    }
    return projectToCanvas(coords, width, height, 34);
  }, [markers, origin, route, width, height, fixed, center, projection]);

  const originIndex = origin ? markers.length : -1;

  // Corridor overlay. Drawn before the pins so a facility never sits under the
  // line, and dashed on purpose: a straight chord is a bearing, not a road.
  const corridor = useMemo(() => {
    if (!route) return null;
    const all = [
      ...markers.map((m) => ({ lat: m.lat, lng: m.lng })),
      ...(origin ? [origin] : []),
      route.origin,
      route.destination,
    ];
    const pts =
      fixed && center
        ? all.map((p) => projection.toXY(p))
        : projectToCanvas(all, width, height, 34);
    const a = pts[all.length - 2];
    const b = pts[all.length - 1];
    if (!a || !b) return null;
    return { a, b };
  }, [route, markers, origin, width, height]);

  // Labels are the least important thing on this canvas and the easiest to get
  // wrong: thirty facilities in one metro area overprint into an unreadable
  // smear, which is worse than no labels at all. So labels are placed greedily
  // -- largest pins first, since those are the facilities with the most
  // capacity and therefore the ones a reader is looking for -- and any label
  // that would touch an already-placed label or sit on top of a pin is dropped.
  // The pin itself still works, and the list underneath carries every name.
  const labels = useMemo(() => {
    if (!showLabels) return [];
    const compact = width < 420;
    const font = compact ? 8 : 8.5;
    const charWidth = font * 0.62;
    const lineHeight = font + 2.5;

    const ranked = markers
      .map((f, i) => ({ f, i, r: pinRadius(f) }))
      .sort((a, b) => {
        if (a.f.id === selectedId) return -1;
        if (b.f.id === selectedId) return 1;
        return b.r - a.r;
      });

    const taken: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const pinBoxes = markers.map((f, i) => {
      const p = projected[i];
      const r = pinRadius(f);
      return { x1: p.x - r - 1, y1: p.y - r - 1, x2: p.x + r + 1, y2: p.y + r + 1 };
    });
    const originBox = origin
      ? {
          x1: projected[originIndex].x - 14,
          y1: projected[originIndex].y - 14,
          x2: projected[originIndex].x + 14,
          y2: projected[originIndex].y + 22,
        }
      : null;

    const overlaps = (a: any, b: any) => !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);

    const out: { id: number; x: number; y: number; text: string }[] = [];
    // A hard ceiling keeps the phone canvas calm even when nothing overlaps.
    const budget = compact ? 9 : 26;

    for (const { f, i } of ranked) {
      if (out.length >= budget) break;
      const p = projected[i];
      const w = f.short_name.length * charWidth;
      const r = pinRadius(f);
      // The label sits at y = pin - r - 6 (see the renderer below), so the box
      // has to account for the pin's radius. Sizing it as if every pin were the
      // smallest one made each label overlap its own pin, which -- because a
      // label is also tested against the pin boxes -- meant no label could ever
      // be drawn. The map rendered correctly and silently carried no names.
      const baseline = p.y - r - 6;
      const box = {
        x1: p.x - w / 2,
        y1: baseline - lineHeight + 1,
        x2: p.x + w / 2,
        y2: baseline + 2,
      };
      if (box.x1 < 2 || box.x2 > width - 2 || box.y1 < 2) continue;
      // Its own pin is excluded: the label is *supposed* to sit just above the
      // marker it names, and testing it against that marker rejects every label.
      if (pinBoxes.some((b, bi) => bi !== i && overlaps(box, b))) continue;
      if (originBox && overlaps(box, originBox)) continue;
      if (taken.some((b) => overlaps(box, b))) continue;
      taken.push({ x1: box.x1 - 2, y1: box.y1 - 1, x2: box.x2 + 2, y2: box.y2 + 1 });
      out.push({ id: f.id, x: p.x, y: p.y, text: f.short_name });
    }
    return out;
  }, [markers, projected, selectedId, showLabels, origin, originIndex, width]);

  const labelFor = useMemo(() => {
    const m = new Map<number, string>();
    labels.forEach((l) => m.set(l.id, l.text));
    return m;
  }, [labels]);

  const compact = width < 420;

  return (
    <View
      style={{
        width,
        borderRadius: 9,
        overflow: 'hidden',
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.line.base,
        backgroundColor: t.bg.sunken,
      }}
    >
      <Svg width={width} height={height}>
        {/* graticule */}
        {Array.from({ length: Math.floor(width / 44) }).map((_, i) => (
          <Line
            key={`v${i}`}
            x1={i * 44}
            x2={i * 44}
            y1={0}
            y2={height}
            stroke={t.chart.grid}
            strokeWidth={StyleSheet.hairlineWidth}
          />
        ))}
        {Array.from({ length: Math.floor(height / 44) }).map((_, i) => (
          <Line
            key={`h${i}`}
            x1={0}
            x2={width}
            y1={i * 44}
            y2={i * 44}
            stroke={t.chart.grid}
            strokeWidth={StyleSheet.hairlineWidth}
          />
        ))}

        {/* a faint arterial cross so the canvas reads as a spatial layout
            rather than a spreadsheet with dots */}
        <Path
          d={`M0 ${height * 0.62} C ${width * 0.3} ${height * 0.52}, ${width * 0.62} ${height * 0.74}, ${width} ${
            height * 0.58
          }`}
          stroke={t.line.base}
          strokeWidth={1.2}
          fill="none"
          opacity={0.7}
        />
        <Path
          d={`M${width * 0.44} 0 C ${width * 0.4} ${height * 0.34}, ${width * 0.56} ${height * 0.6}, ${width * 0.5} ${height}`}
          stroke={t.line.base}
          strokeWidth={1.2}
          fill="none"
          opacity={0.7}
        />

        {corridor ? (
          <G>
            <Line
              x1={corridor.a.x}
              y1={corridor.a.y}
              x2={corridor.b.x}
              y2={corridor.b.y}
              stroke={t.accent.base}
              strokeWidth={2.4}
              strokeDasharray="6,5"
              opacity={0.85}
            />
            <Circle cx={corridor.b.x} cy={corridor.b.y} r={4.4} fill={t.bg.sunken} stroke={t.accent.base} strokeWidth={2} />
          </G>
        ) : null}

        {markers.map((f, i) => {
          const p = projected[i];
          const tone = pinTone(f);
          const selected = f.id === selectedId;
          const r = pinRadius(f);
          return (
            <G key={f.id}>
              {selected ? <Circle cx={p.x} cy={p.y} r={r + 7} fill={tone.ring} opacity={0.16} /> : null}
              {/* Fill is capacity, outline is freshness -- see freshnessOf(). */}
              <Circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill={tone.fill}
                stroke={RING_COLOUR[freshnessOf(f)]}
                strokeWidth={1.6}
              />
              {labelFor.has(f.id) ? (
                <SvgTextNode
                  x={p.x}
                  y={p.y - r - 6}
                  fill={t.fg.muted}
                  fontSize={compact ? 8 : 8.5}
                  fontFamily={mono}
                  textAnchor="middle"
                >
                  {labelFor.get(f.id)}
                </SvgTextNode>
              ) : null}
            </G>
          );
        })}

        {origin && originIndex >= 0 ? (
          <G>
            <Circle
              cx={projected[originIndex].x}
              cy={projected[originIndex].y}
              r={13}
              fill={t.accent.base}
              opacity={0.14}
            />
            <Circle
              cx={projected[originIndex].x}
              cy={projected[originIndex].y}
              r={4.6}
              fill={t.accent.base}
              stroke={t.bg.surface}
              strokeWidth={1.6}
            />
            {originLabel ? (
              <SvgTextNode
                x={projected[originIndex].x}
                y={projected[originIndex].y + 18}
                fill={t.accent.base}
                fontSize={9}
                fontFamily={mono}
                textAnchor="middle"
              >
                {originLabel}
              </SvgTextNode>
            ) : null}
          </G>
        ) : null}

        <Rect
          x={0.5}
          y={height - 17.5}
          width={width - 1}
          height={17}
          fill={t.bg.surface}
          opacity={0.86}
        />
        {fixed && center ? (
          <>
            {/* Anchor crosshair. Without it the fixed projection has no visual
                reference and a tap feels arbitrary; with it, "the pin goes where
                I press" is obvious. */}
            <Line x1={width / 2 - 9} x2={width / 2 + 9} y1={height / 2} y2={height / 2} stroke={t.accent.base} strokeWidth={1.2} />
            <Line x1={width / 2} x2={width / 2} y1={height / 2 - 9} y2={height / 2 + 9} stroke={t.accent.base} strokeWidth={1.2} />
            <Circle cx={width / 2} cy={height / 2} r={3.4} fill="none" stroke={t.accent.base} strokeWidth={1.2} />
          </>
        ) : null}
        <SvgTextNode x={7} y={height - 5.5} fill={t.fg.faint} fontSize={8.5} fontFamily={mono}>
          {fixed
            ? `SCHEMATIC · TAP TO PLACE · CENTRED ${center?.lat.toFixed(3)}, ${center?.lng.toFixed(3)}`
            : 'SCHEMATIC · TRUE COORDINATES · NOT TO SCALE'}
        </SvgTextNode>
      </Svg>

      {/* Tap-to-place layer. Sits above the SVG but below the pin hit targets,
          so tapping a facility still selects it while tapping open ground drops
          the pin. Only mounted when the caller supplied both a handler and a
          fixed projection -- see the note on `projection` above. */}
      {onPress && projection.toLatLng ? (
        <Pressable
          ref={tapLayerRef}
          onPress={(event) => {
            const native = event.nativeEvent as {
              locationX?: number;
              locationY?: number;
              pageX?: number;
              pageY?: number;
            };
            let x = native.locationX;
            let y = native.locationY;
            // RN-web leaves locationX/locationY undefined on some browsers and
            // on synthetic events that bubbled through nested pressables — the
            // pin then landed at NaN. pageX/pageY minus the layer's own window
            // offset is the same number, computed by hand.
            if ((!Number.isFinite(x) || !Number.isFinite(y)) && Number.isFinite(native.pageX) && Number.isFinite(native.pageY)) {
              const layer = tapLayerRef.current;
              if (layer?.measureInWindow) {
                layer.measureInWindow((wx: number, wy: number) => {
                  const p = projection.toLatLng!(native.pageX! - wx, native.pageY! - wy);
                  if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) onPress(p);
                });
                return;
              }
            }
            if (!Number.isFinite(x) || !Number.isFinite(y)) return;
            const px = x as number;
            const py = y as number;
            const p = projection.toLatLng!(px, py);
            if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) onPress(p);
          }}
          accessibilityLabel="Tap to place a point"
          style={{ position: 'absolute', left: 0, top: 0, right: 0, bottom: height }}
        />
      ) : null}

      {/* Hit targets sit above the SVG so taps resolve reliably on web, where
          SVG-in-RN hit testing is inconsistent. */}
      {markers.map((f, i) => {
        const p = projected[i];
        return (
          <Pressable
            key={`hit-${f.id}`}
            onPress={() => onSelect?.(f.id)}
            accessibilityLabel={`${f.name ?? f.short_name}, ${pinTone(f).label}, ${
              freshnessOf(f) === 'fresh'
                ? 'reported recently'
                : freshnessOf(f) === 'stale' || freshnessOf(f) === 'unknown'
                  ? 'data stale or unreported'
                  : 'data slightly out of date'
            }`}
            style={{
              position: 'absolute',
              left: p.x - 18,
              top: p.y - 18,
              width: 36,
              height: 36,
              borderRadius: 18,
              ...(isWeb ? ({ cursor: 'pointer' } as any) : null),
            }}
          />
        );
      })}

      {/* The legend is docked below the canvas rather than floated over it. A
          floating legend sat on top of the pins on a phone, hiding four or five
          facilities behind its own key -- the least useful possible trade in a
          view whose whole job is showing where the facilities are. */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          columnGap: 12,
          rowGap: 4,
          paddingHorizontal: space.sm,
          paddingVertical: 6,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.line.base,
          backgroundColor: t.bg.surface,
        }}
      >
        {/* Two dimensions, kept apart.
            The legend previously ran ICU free / Beds only / At capacity / No
            data in one row, which conflates two different questions: how much
            capacity is left (a property of the facility) and how recently anyone
            confirmed it (a property of the report). A facility with 40 beds free
            reported nine hours ago is not the same proposition as one with 40
            beds free reported a minute ago, and a reader who cannot see the
            second dimension will treat them as identical. */}
        <Label style={{ fontSize: 9 }}>Fill</Label>
        <Legend color="#137547" label="ICU free" />
        <Legend color="#8a5a00" label="Beds only" />
        <Legend color="#a32217" label="At capacity" />
        <Legend color="transparent" ring="#8b93a1" label="No data" />
        <Label style={{ fontSize: 9, marginLeft: 4 }}>Freshness</Label>
        <Legend color="transparent" ring="#c3c8d1" label="Ring: reported now" />
        <Legend color="transparent" ring="#8b93a1" label="Ring: stale or unknown" />
        <Small muted style={{ fontSize: 9.5, marginLeft: 'auto' }}>
          {labels.length < markers.length
            ? `${markers.length - labels.length} label(s) hidden to avoid overlap`
            : ' '}
        </Small>
      </View>
    </View>
  );
}

function Legend({ color, ring, label }: { color: string; ring?: string; label: string }) {
  const { t } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 3.5,
          backgroundColor: color,
          borderWidth: ring ? 1.2 : 0,
          borderColor: ring,
        }}
      />
      <Small style={{ fontSize: 10, lineHeight: 13, color: t.fg.muted }}>{label}</Small>
    </View>
  );
}
