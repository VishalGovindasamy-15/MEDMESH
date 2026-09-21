import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline, Text as SvgTextNode } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';
import { mono, radius, space } from '../theme/tokens';
import { Label, Row, Small } from '../ui';

/**
 * Route corridor renderer.
 *
 * Draws a plausible, deterministic corridor between two coordinates so the crew
 * app can show a route while offline and while no Directions API key is
 * configured. It is explicitly labelled as an estimate in the UI — presenting a
 * hand-drawn line as turn-by-turn navigation would be actively dangerous, so the
 * card always carries the caveat and a "check before departure" line.
 *
 * Production passes the decoded Directions polyline into `points` and drops the
 * caveat; the geometry pipeline does not change.
 */

interface Props {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  originLabel?: string;
  destinationLabel?: string;
  height?: number;
  /** Decoded polyline from a routing provider. Falls back to a generated corridor. */
  points?: [number, number][];
  showCaveat?: boolean;
  bearing?: number;
}

export function RouteCanvas({
  origin,
  destination,
  originLabel = 'Start',
  destinationLabel = 'Destination',
  height = 190,
  points,
  showCaveat = true,
  bearing,
}: Props) {
  const { t } = useTheme();

  const width = 320;
  const pad = 26;

  const geometry = React.useMemo(() => {
    const src = points && points.length > 1 ? points : generateCorridor(origin, destination);
    const lats = src.map((p) => p[0]);
    const lngs = src.map((p) => p[1]);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const spanLat = maxLat - minLat || 0.01;
    const spanLng = maxLng - minLng || 0.01;
    const scale = Math.min((width - pad * 2) / spanLng, (height - pad * 2) / spanLat);
    const offX = (width - spanLng * scale) / 2;
    const offY = (height - spanLat * scale) / 2;
    const project = (p: [number, number]) => ({
      x: offX + (p[1] - minLng) * scale,
      y: height - (offY + (p[0] - minLat) * scale),
    });
    const pts = src.map(project);
    return {
      path: pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' '),
      start: pts[0],
      end: pts[pts.length - 1],
      mid: pts[Math.floor(pts.length / 2)],
      count: pts.length,
    };
  }, [points, origin, destination, height]);

  return (
    <View
      style={{
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.line.base,
        backgroundColor: t.bg.sunken,
        overflow: 'hidden',
      }}
    >
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid slice">
        {Array.from({ length: 8 }).map((_, i) => (
          <Line key={`v${i}`} x1={i * 44} x2={i * 44} y1={0} y2={height} stroke={t.chart.grid} strokeWidth={1} />
        ))}
        {Array.from({ length: Math.ceil(height / 44) }).map((_, i) => (
          <Line key={`h${i}`} x1={0} x2={width} y1={i * 44} y2={i * 44} stroke={t.chart.grid} strokeWidth={1} />
        ))}

        {/* casing + core, the way a real navigation trace is drawn */}
        <Path d={geometry.path} stroke={t.accent.base} strokeWidth={6.5} fill="none" opacity={0.16} strokeLinecap="round" />
        <Path d={geometry.path} stroke={t.accent.base} strokeWidth={2.6} fill="none" strokeLinecap="round" />

        {/* progress ticks along the corridor */}
        <Polyline
          points={geometry.path.replace(/[ML]/g, '').trim()}
          fill="none"
          stroke={t.bg.sunken}
          strokeWidth={1}
          strokeDasharray="2,7"
        />

        <G>
          <Circle cx={geometry.end.x} cy={geometry.end.y} r={9} fill={t.status.live.base} opacity={0.16} />
          <Circle cx={geometry.end.x} cy={geometry.end.y} r={5} fill={t.status.live.base} stroke={t.bg.sunken} strokeWidth={1.8} />
          <SvgTextNode
            x={clamp(geometry.end.x, 34, width - 34)}
            y={geometry.end.y - 12}
            fill={t.fg.muted}
            fontSize={9}
            fontFamily={mono}
            textAnchor="middle"
          >
            {destinationLabel}
          </SvgTextNode>
        </G>

        <G>
          <Circle cx={geometry.start.x} cy={geometry.start.y} r={4.6} fill={t.accent.base} stroke={t.bg.sunken} strokeWidth={1.8} />
          <SvgTextNode
            x={clamp(geometry.start.x, 30, width - 30)}
            y={geometry.start.y + 16}
            fill={t.fg.muted}
            fontSize={9}
            fontFamily={mono}
            textAnchor="middle"
          >
            {originLabel}
          </SvgTextNode>
        </G>
      </Svg>

      <View
        style={{
          padding: space.md,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.line.base,
          backgroundColor: t.bg.surface,
          gap: 4,
        }}
      >
        <Row justify="space-between" align="center">
          <Label>Route corridor</Label>
          {bearing != null ? (
            <Small muted style={{ fontSize: 11 }}>
              heading {Math.round(bearing)}°
            </Small>
          ) : null}
        </Row>
        {showCaveat ? (
          <Small muted style={{ fontSize: 11 }}>
            Estimated corridor for situational awareness — not turn-by-turn. Check the road before departure.
          </Small>
        ) : null}
      </View>
    </View>
  );
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Deterministic corridor between two points. Seeded off the coordinates so the
 * same trip always renders identically — a route line that reshapes on every
 * repaint destroys trust in the display faster than having no line at all.
 */
function generateCorridor(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  steps = 22,
): [number, number][] {
  const seed = Math.abs(Math.round((origin.lat + destination.lng) * 100000));
  let state = seed % 2147483647 || 7;
  const rnd = () => {
    state = (1103515245 * state + 12345) % 2147483648;
    return state / 2147483648;
  };

  const dLat = destination.lat - origin.lat;
  const dLng = destination.lng - origin.lng;
  const norm = Math.hypot(dLat, dLng) || 1;
  const amp = Math.min(0.004, 0.05 / Math.max(norm * 100, 1));
  const phase = rnd() * Math.PI * 2;

  const out: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const f = i / (steps - 1);
    const wobble = Math.sin(phase + f * Math.PI * 2.2) * amp * Math.sin(f * Math.PI);
    out.push([
      Number((origin.lat + dLat * f - (dLng / norm) * wobble).toFixed(6)),
      Number((origin.lng + dLng * f + (dLat / norm) * wobble).toFixed(6)),
    ]);
  }
  return out;
}
