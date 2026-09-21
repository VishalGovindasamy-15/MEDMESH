import React, { useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgTextNode } from 'react-native-svg';

import type { MapPoint } from './mapTypes';
import { pinRadius, pinTone } from './mapTypes';
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
}: Props) {
  const { t } = useTheme();

  const projected = useMemo(() => {
    const coords = [
      ...markers.map((m) => ({ lat: m.lat, lng: m.lng })),
      ...(origin ? [origin] : []),
      ...(route ? [route.origin, route.destination] : []),
    ];
    return projectToCanvas(coords, width, height, 34);
  }, [markers, origin, route, width, height]);

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
    const pts = projectToCanvas(all, width, height, 34);
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
              <Circle cx={p.x} cy={p.y} r={r} fill={tone.fill} stroke={tone.ring} strokeWidth={1.6} />
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
        <SvgTextNode x={7} y={height - 5.5} fill={t.fg.faint} fontSize={8.5} fontFamily={mono}>
          SCHEMATIC · TRUE COORDINATES · NOT TO SCALE
        </SvgTextNode>
      </Svg>

      {/* Hit targets sit above the SVG so taps resolve reliably on web, where
          SVG-in-RN hit testing is inconsistent. */}
      {markers.map((f, i) => {
        const p = projected[i];
        return (
          <Pressable
            key={`hit-${f.id}`}
            onPress={() => onSelect?.(f.id)}
            accessibilityLabel={`${f.name ?? f.short_name}, ${pinTone(f).label}`}
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
        <Label style={{ fontSize: 9 }}>Capacity</Label>
        <Legend color="#137547" label="ICU free" />
        <Legend color="#8a5a00" label="Beds only" />
        <Legend color="#a32217" label="At capacity" />
        <Legend color="transparent" ring="#8b93a1" label="No data" />
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
