import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';


import { fetchRoute, hasGoogleMaps, hasDirections, type RouteResult } from '../lib/maps';
import type { Tokens } from '../theme/tokens';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Label, Row, Small, StatusDot } from '../ui';
import { GoogleMap } from './GoogleMap';
import type { MapPoint } from './mapTypes';
import { MapCanvas } from './MapCanvas';
import { RouteCanvas } from './RouteCanvas';

/**
 * The one map surface the whole app talks to.
 *
 * Every screen — directory, console, crew, facility page — renders through this,
 * so "which basemap" is decided in exactly one place and no screen has to know
 * whether a Maps key is configured. When one is, you get Google tiles; when one
 * is not, you get the schematic canvas, which is a genuinely usable fallback
 * rather than an empty box.
 *
 * Route geometry is fetched here too, and falls back the same way: no Directions
 * key means the schematic corridor, clearly labelled as an estimate.
 */

export interface MapSurfaceProps {
  points?: MapPoint[];
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: number;
  width?: number;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  origin?: { lat: number; lng: number } | null;
  originLabel?: string;
  /** When both are set, a route is drawn and (if a key exists) really resolved. */
  route?: { from: { lat: number; lng: number }; to: { lat: number; lng: number } } | null;
  showLabels?: boolean;
  interactive?: boolean;
  /** Hides the "how to read this" strip where the screen already explains it. */
  showLegend?: boolean;
  /**
   * Tap-to-place. Only meaningful with a fixed `center`+`zoom`: the schematic
   * canvas auto-fits to its own points, so a tap on it has no geographic
   * meaning. When a handler is supplied and Maps is unavailable, the canvas
   * switches to a fixed projection around `center` so that a tap still lands
   * somewhere real.
   */
  onPress?: (point: { lat: number; lng: number }) => void;
}

export function MapSurface(props: MapSurfaceProps) {
  const { t } = useTheme();
  const {
    points = [],
    center,
    zoom,
    height = 300,
    width,
    selectedId = null,
    onSelect,
    origin = null,
    originLabel = 'Scene',
    route = null,
    showLabels = true,
    interactive = true,
    showLegend = true,
  } = props;
  const onPress = props.onPress;

  const google = hasGoogleMaps();

  /**
   * Measured width of the surface's own box.
   *
   * The schematic canvas needs a pixel width to project into, and callers on a
   * phone do not know theirs — a hardcoded `width ?? 360` default overflowed a
   * 360px viewport by exactly the page padding, which is how the console map
   * ended up horizontally scrollable on the smallest phones we support. The
   * box measures itself and the canvas uses the measurement until a caller
   * supplies an explicit width.
   */
  const [measured, setMeasured] = React.useState<number | null>(null);

  // Real road geometry when a Directions key exists; null means "draw the
  // schematic corridor", which is also what happens if the API errors.
  const [resolved, setResolved] = React.useState<RouteResult | null>(null);
  const [routing, setRouting] = React.useState(false);

  React.useEffect(() => {
    if (!route || !hasDirections()) {
      setResolved(null);
      return;
    }
    const controller = new AbortController();
    setRouting(true);
    fetchRoute(route.from, route.to, controller.signal)
      .then((r) => setResolved(r))
      .finally(() => setRouting(false));
    return () => controller.abort();
  }, [route?.from.lat, route?.from.lng, route?.to.lat, route?.to.lng]);

  const routePath = resolved?.path || (route ? [[route.from.lng, route.from.lat] as [number, number], [route.to.lng, route.to.lat] as [number, number]] : undefined);

  // The schematic canvas draws its own corridor from two endpoints rather than
  // taking a decoded path, so it is handed the same endpoints.
  const corridor = route ? { origin: route.from, destination: route.to } : null;

  // Google resolved a real road route: the corridor is superseded and must not
  // be shown beside it. Two routes on one screen — one dashed and one real —
  // is worse than either alone, because a crew has to work out which one is
  // the road.
  const showCorridorFallback = Boolean(route) && !routePath && !routing;

  return (
    <View
      style={{ gap: space.sm }}
      onLayout={(e) => {
        const w = e.nativeEvent.layout.width;
        if (Number.isFinite(w) && w > 0) setMeasured((prev) => (prev === w ? prev : w));
      }}
    >
      {google ? (
        <GoogleMap
          points={points}
          center={center}
          zoom={zoom}
          height={height}
          selectedId={selectedId}
          onSelect={onSelect}
          origin={origin}
          originLabel={originLabel}
          routePath={routePath}
          interactive={interactive}
          onPress={onPress}
        />
      ) : (
        <MapCanvas
          points={points}
          width={width ?? measured ?? 320}
          height={height}
          selectedId={selectedId}
          onSelect={onSelect}
          origin={origin}
          originLabel={originLabel}
          showLabels={showLabels}
          route={corridor}
          center={onPress ? (center ?? null) : null}
          zoom={onPress ? (zoom ?? null) : null}
          onPress={onPress}
        />
      )}



      {showLegend ? (
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
      ) : null}
    </View>
  );
}

function LegendDot({ tone, label }: { tone: keyof Tokens['status']; label: string }) {
  return (
    <Row gap={4} align="center">
      <StatusDot tone={tone} size={7} />
      <Small muted>{label}</Small>
    </Row>
  );
}

export const mapStyles = StyleSheet.create({});
