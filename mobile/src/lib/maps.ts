/**
 * Google Maps configuration.
 *
 * Two independent capabilities, because they fail independently:
 *
 *  - **Tiles / basemap.** Android and iOS use the native Maps SDK, which takes
 *    its key from `app.json` at build time (see `android.config.googleMaps`).
 *    Web needs the JavaScript API key, which must be restricted by HTTP referrer
 *    and therefore cannot be the same key as the Android/iOS ones.
 *  - **Directions.** Optional and separate. Without it the app still draws the
 *    schematic corridor and still hands off to the device's navigation app;
 *    with it the corridor becomes the real road geometry.
 *
 * The whole layer is optional by design. A pilot district with no Maps billing
 * account must still be able to run MedMesh — so every map surface has a
 * schematic fallback that is explicitly labelled as an estimate rather than
 * quietly pretending to be a basemap. What must never happen is an ambulance
 * crew believing a hand-drawn line is turn-by-turn.
 */

import { Platform } from 'react-native';

/** Web: Google Maps JavaScript API key. Set `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY`. */
export const WEB_MAPS_KEY = (process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '').trim();

/** Directions API key — may be the same key as the platform's map key. */
const DIRECTIONS_KEY = (
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_DIRECTIONS_KEY ??
  process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ??
  ''
).trim();

export function hasMapsKey(): boolean {
  if (Platform.OS === 'web') return WEB_MAPS_KEY.length > 0;
  // Native keys live in the native manifest, so the JS side cannot read them
  // back; presence is declared at build time instead.
  return NATIVE_MAPS_ENABLED;
}

export function hasDirections(): boolean {
  return DIRECTIONS_KEY.length > 0;
}

/**
 * Set to true in `app.json` → `extra.nativeMaps`, and kept in step with
 * `android.config.googleMaps.apiKey`. Reading it from config rather than
 * hardcoding means a build with no key falls back cleanly instead of rendering
 * a grey rectangle where a map should be.
 */
export const NATIVE_MAPS_ENABLED: boolean = Boolean(
  (require('expo-constants').default as { expoConfig?: { extra?: { nativeMaps?: boolean } } })
    .expoConfig?.extra?.nativeMaps,
);

/** Alias kept for callers that read better as a question. */
export const hasGoogleMaps = hasMapsKey;

/** Default camera: the pilot region, centred on Coimbatore. */
export const DEFAULT_CENTER = { lat: 11.0168, lng: 76.9558 };
export const DEFAULT_ZOOM = 10;

export interface RouteResult {
  /** [lng, lat] pairs, Google's own order, ready for a Polyline path. */
  path: [number, number][];
  distanceKm: number;
  durationMinutes: number;
  /** The provider's own summary, e.g. "NH948". Shown so a crew can sanity-check. */
  summary?: string;
  source: 'google' | 'estimate';
}

/**
 * Directions lookup.
 *
 * Returns `null` when no key is configured or the call fails, so callers fall
 * back to the schematic corridor instead of showing an error. A failed routing
 * lookup is not an operational failure — the crew still has coordinates, a
 * bearing and a handoff to their own navigation app.
 */
export async function fetchRoute(
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
  signal?: AbortSignal,
): Promise<RouteResult | null> {
  if (!hasDirections()) return null;

  const url =
    'https://maps.googleapis.com/maps/api/directions/json' +
    `?origin=${origin.lat},${origin.lng}` +
    `&destination=${destination.lat},${destination.lng}` +
    '&mode=driving&departure_time=now&traffic_model=best_guess' +
    `&key=${DIRECTIONS_KEY}`;

  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status: string;
      routes?: {
        summary?: string;
        legs?: { distance?: { value: number }; duration?: { value: number; text?: string } }[];
        overview_polyline?: { points: string };
      }[];
    };
    if (body.status !== 'OK' || !body.routes?.length) return null;

    const route = body.routes[0];
    const leg = route.legs?.[0];
    const encoded = route.overview_polyline?.points ?? '';

    return {
      path: decodePolyline(encoded),
      distanceKm: (leg?.distance?.value ?? 0) / 1000,
      durationMinutes: Math.max(1, Math.round((leg?.duration?.value ?? 0) / 60)),
      summary: route.summary,
      source: 'google',
    };
  } catch {
    return null;
  }
}

/**
 * Google's encoded polyline algorithm. Implemented here rather than pulled from
 * a package: it is fifteen lines, and a routing dependency that must match the
 * server's encoding exactly is not one to take on trust.
 */
export function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lng / 1e5, lat / 1e5]);
  }
  return points;
}

/** Hand off to the platform's own navigation app — the correct destination UI. */
export function navigationUrl(
  destination: { lat: number; lng: number },
  label?: string,
  origin?: { lat: number; lng: number } | null,
): string {
  const dest = `${destination.lat},${destination.lng}`;
  if (Platform.OS === 'ios') {
    const q = origin ? `saddr=${origin.lat},${origin.lng}&daddr=${dest}` : `daddr=${dest}`;
    return `https://maps.apple.com/?${q}${label ? `&q=${encodeURIComponent(label)}` : ''}`;
  }
  const params = new URLSearchParams({
    api: '1',
    destination: dest,
    travelmode: 'driving',
  });
  if (origin) params.set('origin', `${origin.lat},${origin.lng}`);
  if (label) params.set('destination_place_id', '');
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}
