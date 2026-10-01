import React from 'react';

import type { MapPoint } from './mapTypes';
import { freshnessOf, pinFill, pinOpacity, pinRadius, RING_COLOUR } from './mapTypes';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { DEFAULT_CENTER, DEFAULT_ZOOM, WEB_MAPS_KEY } from '../lib/maps';

/**
 * Google Maps basemap — web.
 *
 * Renders through the Maps JavaScript API directly rather than through a React
 * wrapper. The wrappers available today either lag the API or bundle a second
 * copy of the loader, and the surface here is small: a div, some markers, an
 * optional polyline. Owning those forty lines means the marker colours stay in
 * the same token system as the rest of the app.
 *
 * The script is loaded once per page and shared across mounts — loading it twice
 * logs a hard warning and breaks the second map.
 */

/// <reference types="google.maps" />

declare global {
  interface Window {
    google?: typeof google;
    __medmeshMapsPromise?: Promise<void>;
    __medmeshMapsReady?: () => void;
  }
}

let cachedPromise: Promise<void> | null = null;

function loadMapsApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.__medmeshMapsPromise) return window.__medmeshMapsPromise;

  cachedPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById('medmesh-gmaps');
    if (existing) {
      // Script tag already present: either it finished or it is still loading.
      if (window.google?.maps) resolve();
      else {
        window.__medmeshMapsReady = () => resolve();
        setTimeout(() => (window.google?.maps ? resolve() : reject(new Error('timeout'))), 12_000);
      }
      return;
    }

    const script = document.createElement('script');
    script.id = 'medmesh-gmaps';
    script.async = true;
    script.defer = true;
    // `callback` rather than polling: it is the documented handshake and it
    // fires even when the API is served from a cold cache.
    window.__medmeshMapsReady = () => resolve();
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(
      WEB_MAPS_KEY,
    )}&libraries=marker&loading=async&callback=__medmeshMapsReady`;
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(script);
  });

  window.__medmeshMapsPromise = cachedPromise;
  return cachedPromise;
}

export interface GoogleMapProps {
  points?: MapPoint[];
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: number;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  origin?: { lat: number; lng: number } | null;
  originLabel?: string;
  /** Route geometry: `[lng, lat]` pairs. */
  routePath?: [number, number][];
  /** Colour a route by day/night leg instead of the accent hue. */
  routeTone?: 'accent' | 'live' | 'warm';
  interactive?: boolean;
  /** Tap-to-place. Receives the geographic point under the tap. */
  onPress?: (point: { lat: number; lng: number }) => void;
}

export function GoogleMap({
  points = [],
  center,
  zoom = DEFAULT_ZOOM,
  height = 300,
  selectedId = null,
  onSelect,
  origin = null,
  originLabel = 'Scene',
  routePath,
  routeTone = 'accent',
  interactive = true,
  onPress,
}: GoogleMapProps) {
  const { t } = useTheme();
  const divRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<google.maps.Map | null>(null);
  const markersRef = React.useRef<google.maps.Marker[]>([]);
  const lineRef = React.useRef<google.maps.Polyline | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Kept in a ref so the marker click handlers never close over a stale prop.
  const selectRef = React.useRef(onSelect);
  const pressRef = React.useRef<((point: { lat: number; lng: number }) => void) | undefined>(undefined);
  selectRef.current = onSelect;
  pressRef.current = onPress;

  React.useEffect(() => {
    let cancelled = false;
    loadMapsApi()
      .then(() => {
        if (cancelled || !divRef.current || !window.google?.maps) return;
        const map = new window.google.maps.Map(divRef.current, {
          center: center ?? DEFAULT_CENTER,
          zoom,
          disableDefaultUI: !interactive,
          zoomControl: interactive,
          streetViewControl: false,
          mapTypeControl: false,
          fullscreenControl: interactive,
          clickableIcons: false,
          gestureHandling: interactive ? 'auto' : 'none',
          // Keeps the basemap quiet so state colour reads as data, not decoration.
          styles: QUIET_BASEMAP,
        });
        mapRef.current = map;
        // Tap-to-place. Registered once on the map rather than per-marker, so a
        // tap anywhere — including on empty ground — reports a point. The
        // location picker is the only consumer, and it needs the empty ground.
        map.addListener('click', (event: google.maps.MapMouseEvent) => {
          const handler = pressRef.current;
          const position = event.latLng;
          if (handler && position) handler({ lat: position.lat(), lng: position.lng() });
        });
        setFailed(false);
        renderMarkers();
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Markers: rebuilt whenever the facility set changes. At pilot scale (tens of
  // facilities) a rebuild is cheaper than diffing, and far less code to get
  // wrong. Above ~500 pins this becomes a MarkerClusterer or a deck.gl layer.
  const renderMarkers = React.useCallback(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;

    markersRef.current.forEach((m) => m.setMap(null));
    markersRef.current = [];

    // --- clustering ---------------------------------------------------- #
    // 152 facilities on a state-wide view overlap into a smear of dots, and a
    // smear cannot be read or clicked. Pins that are close on screen collapse to
    // one marker carrying the count; zooming in splits them back apart. The test
    // is done in projected pixels rather than degrees, so the same threshold
    // looks the same at every latitude this state spans.
    //
    // The labels are the tell-tale of every hospital in the cluster, so clicking
    // one still resolves to a real facility.
    //
    // Above ~500 pins this should become google.maps.marker.Clusterer; the shape
    // of the call below is already the clusterer's, so the swap is local.
    const zoom = map.getZoom() ?? 7;
    const threshold = zoom <= 6 ? 90 : zoom === 7 ? 62 : zoom === 8 ? 44 : 0;
    const clusters: { x: number; y: number; members: typeof points }[] = [];
    const projectionForCluster = map.getProjection();
    const scale = 256 * 2 ** zoom;

    const project = (lat: number, lng: number) => {
      if (projectionForCluster) {
        const worldPoint = projectionForCluster.fromLatLngToPoint(
          new window.google.maps.LatLng(lat, lng),
        );
        if (worldPoint) return { x: worldPoint.x * scale, y: worldPoint.y * scale };
      }
      // Fall back to a plain equirectangular spread, which is within a pixel or
      // two across Tamil Nadu and only runs while the projection is still
      // warming up.
      return { x: ((lng + 180) / 360) * scale, y: ((90 - lat) / 180) * scale };
    };

    for (const f of points) {
      if (f.id === selectedId || threshold === 0) {
        clusters.push({ ...project(f.lat, f.lng), members: [f] });
        continue;
      }
      const at = project(f.lat, f.lng);
      const near = clusters.find((c) => Math.hypot(c.x - at.x, c.y - at.y) < threshold);
      if (near) {
        near.members.push(f);
        // Re-centre on the group so a chain of near pins gathers into one
        // marker instead of splitting arbitrarily.
        near.x = (near.x * (near.members.length - 1) + at.x) / near.members.length;
        near.y = (near.y * (near.members.length - 1) + at.y) / near.members.length;
      } else {
        clusters.push({ ...at, members: [f] });
      }
    }

    for (const cluster of clusters) {
      if (cluster.members.length === 1) {
        const f = cluster.members[0];
        const selected = f.id === selectedId;
        const marker = new window.google.maps.Marker({
          position: { lat: f.lat, lng: f.lng },
          map,
          title: f.name ? `${f.short_name} — ${f.name}` : f.short_name,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            scale: selected ? pinRadius(f) + 3 : pinRadius(f) + 1.5,
            fillColor: pinFill(f),
            fillOpacity: pinOpacity(f),
            // Outline carries freshness, fill carries capacity — same split as
            // the schematic canvas, from the same table.
            strokeColor: RING_COLOUR[freshnessOf(f)],
            strokeWeight: selected ? 2.6 : 1.6,
          },
          zIndex: selected ? 999 : 1,
        });
        marker.addListener('click', () => selectRef.current?.(f.id));
        markersRef.current.push(marker);
        continue;
      }

      // A cluster is drawn as a labelled count, sized by what it contains. The
      // fill is the worst state in the group, because "somewhere in here is a
      // hospital with no ICU" is the fact a reader needs first.
      const worst = cluster.members.some((m) => pinFill(m) === '#a32217')
        ? '#a32217'
        : cluster.members.some((m) => pinFill(m) === '#8a5a00')
          ? '#8a5a00'
          : '#137547';
      const lat = cluster.members.reduce((sum, m) => sum + m.lat, 0) / cluster.members.length;
      const lng = cluster.members.reduce((sum, m) => sum + m.lng, 0) / cluster.members.length;
      const marker = new window.google.maps.Marker({
        position: { lat, lng },
        map,
        title: `${cluster.members.length} facilities — zoom in to separate them`,
        label: {
          text: String(cluster.members.length),
          color: '#ffffff',
          fontSize: '11px',
          fontWeight: '600',
        },
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 9 + Math.min(7, Math.log2(cluster.members.length) * 2),
          fillColor: worst,
          fillOpacity: 0.82,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
        zIndex: 500,
      });
      // Clicking a cluster zooms into it rather than doing nothing, so a reader
      // chasing one facility can drill in without touching the zoom control.
      marker.addListener('click', () => {
        const bounds = new window.google.maps.LatLngBounds();
        cluster.members.forEach((m) => bounds.extend({ lat: m.lat, lng: m.lng }));
        map.fitBounds(bounds, 60);
      });
      markersRef.current.push(marker);
    }

    // The scene marker sits above the pin layer.
    if (origin) {
      markersRef.current.push(
        new window.google.maps.Marker({
          position: origin,
          map,
          title: originLabel,
          zIndex: 1000,
          icon: {
            path: window.google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
            scale: 6,
            fillColor: t.accent.base,
            fillOpacity: 1,
            strokeColor: '#ffffff',
            strokeWeight: 2,
          },
        }),
      );
    }
  }, [points, selectedId, origin, originLabel, t.accent.base]);

  React.useEffect(() => {
    renderMarkers();
  }, [renderMarkers]);

  // Clusters are a function of the zoom level, so crossing a zoom threshold has
  // to rebuild the pin layer or the map keeps showing the previous level's
  // grouping. Debounced through a frame so a pinch does not rebuild the whole
  // layer sixty times a second.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    let frame: number | null = null;
    const listener = map.addListener('zoom_changed', () => {
      if (frame !== null) return;
      frame = window.setTimeout(() => {
        frame = null;
        renderMarkers();
      }, 90);
    });
    return () => {
      if (frame !== null) window.clearTimeout(frame);
      listener.remove();
    };
  }, [renderMarkers]);

  // Route line: replaced wholesale on each change, same reasoning as markers.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps) return;
    lineRef.current?.setMap(null);
    lineRef.current = null;
    if (!routePath || routePath.length < 2) return;

    lineRef.current = new window.google.maps.Polyline({
      path: routePath.map(([lng, lat]) => ({ lat, lng })),
      map,
      strokeColor: routeTone === 'accent' ? t.accent.base : t.status[routeTone].base,
      strokeOpacity: 0.92,
      strokeWeight: 4,
    });
  }, [routePath, routeTone, t.accent.base, t.status]);

  // Follow a changing scene without yanking the operator's view around: only
  // recentre when the camera target actually moves.
  const lastCenter = React.useRef<string>('');
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    const key = `${center.lat.toFixed(4)},${center.lng.toFixed(4)}`;
    if (key === lastCenter.current) return;
    lastCenter.current = key;
    map.panTo(center);
  }, [center]);

  /**
   * Fit the camera to what is actually on the map.
   *
   * The map used to open on a fixed coordinate in Coimbatore regardless of what
   * it was being asked to show — so a reader who filtered to Kanniyakumari got
   * four pins off the edge of a map centred 500 kilometres away, and a reader
   * looking at one district saw the whole state with eleven dots in it. This
   * computes the bounds of the visible facilities (and the scene, when there is
   * one) and fits to them.
   *
   * It re-fits when the *set* changes — a filter, a district, a new shortlist —
   * and not on every capacity tick, because a map that re-frames itself while
   * somebody is reading it is worse than one that is slightly off centre.
   */
  const lastFitKey = React.useRef<string>('');
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !window.google?.maps || points.length === 0) return;

    const key = [
      points.length,
      points[0]?.id,
      points[points.length - 1]?.id,
      origin ? `${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}` : '',
    ].join('|');
    if (key === lastFitKey.current) return;
    lastFitKey.current = key;

    const bounds = new window.google.maps.LatLngBounds();
    points.forEach((f) => bounds.extend({ lat: f.lat, lng: f.lng }));
    if (origin) bounds.extend(origin);

    // One facility has no extent to fit; it needs a centre and a zoom instead,
    // or fitBounds throws the camera at street level.
    const single = points.length === 1 && !origin;
    if (single) {
      map.setCenter({ lat: points[0].lat, lng: points[0].lng });
      map.setZoom(12);
      return;
    }

    // A facility cluster inside one district still wants a city-level view; the
    // generous padding keeps the pins off the frame edge on a phone.
    map.fitBounds(bounds, { top: 40, right: 40, bottom: 40, left: 40 });
    const listener = window.google.maps.event.addListenerOnce(map, 'idle', () => {
      const z = map.getZoom();
      if (z !== undefined && z > 13) map.setZoom(13);
    });
    return () => listener?.remove?.();
  }, [points, origin]);

  if (failed) {
    return (
      <div
        style={{
          height,
          borderRadius: radius.lg,
          border: `1px solid ${t.line.base}`,
          background: t.bg.sunken,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: t.fg.muted,
          fontSize: 12.5,
          padding: 16,
          textAlign: 'center',
        }}
      >
        Google Maps could not be loaded — showing the schematic view instead.
        <br />
        Check that this origin is allowed to use the API key.
      </div>
    );
  }

  return (
    <div
      ref={divRef}
      style={{
        height,
        width: '100%',
        borderRadius: radius.lg,
        overflow: 'hidden',
        border: `1px solid ${t.line.base}`,
        background: t.bg.sunken,
      }}
    />
  );
}

/**
 * A desaturated basemap so hospital state colour is the only saturated thing on
 * screen. This is the same reason the schematic fallback exists: on an ops
 * console, the map is a data layer, not scenery.
 */
const QUIET_BASEMAP = [
  { elementType: 'geometry', stylers: [{ saturation: -70 }, { lightness: 12 }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#5b6472' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#f7f8fa' }, { weight: 2 }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.park', elementType: 'geometry', stylers: [{ visibility: 'on' }, { saturation: -60 }, { lightness: 20 }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ lightness: 32 }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ lightness: 20 }, { weight: 1.2 }] },
  { featureType: 'road.arterial', elementType: 'labels', stylers: [{ visibility: 'simplified' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cfd8e3' }, { lightness: 10 }] },
];
