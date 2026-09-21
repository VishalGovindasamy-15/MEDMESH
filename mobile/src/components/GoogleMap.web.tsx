import React from 'react';

import type { MapPoint } from './mapTypes';
import { pinFill, pinOpacity, pinRadius } from './mapTypes';
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
}: GoogleMapProps) {
  const { t } = useTheme();
  const divRef = React.useRef<HTMLDivElement | null>(null);
  const mapRef = React.useRef<google.maps.Map | null>(null);
  const markersRef = React.useRef<google.maps.Marker[]>([]);
  const lineRef = React.useRef<google.maps.Polyline | null>(null);
  const [failed, setFailed] = React.useState(false);
  // Kept in a ref so the marker click handlers never close over a stale prop.
  const selectRef = React.useRef(onSelect);
  selectRef.current = onSelect;

  React.useEffect(() => {
    let cancelled = false;
    loadMapsApi()
      .then(() => {
        if (cancelled || !divRef.current || !window.google?.maps) return;
        mapRef.current = new window.google.maps.Map(divRef.current, {
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

    // Coordinates are guaranteed by MapPoint, so a missing pin is no longer
    // possible; what remains is the colour and size vocabulary, shared with the
    // schematic canvas through mapTypes so the two never drift apart.
    for (const f of points) {
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
          strokeColor: '#ffffff',
          strokeWeight: selected ? 2.6 : 1.6,
        },
        zIndex: selected ? 999 : 1,
      });
      marker.addListener('click', () => selectRef.current?.(f.id));
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
