/**
 * What a map pin actually is.
 *
 * The map components used to accept a whole `Facility`, which meant a screen
 * that only had a location and a live capacity — a crew's destination, a
 * shortlist candidate — had to fabricate the twenty-odd other fields, and one
 * that forgot crashed on `declared.beds`.
 *
 * Declaring the real requirement is better in every way: callers pass what they
 * have, the compiler enforces it, and the pin's size and colour are derived from
 * fields whose absence has a defined meaning rather than a crash.
 */

import type { Capacity, Facility } from '../api/types';

export interface MapPoint {
  id: number;
  /** Short label drawn beside the pin. */
  short_name: string;
  /** Long name, used as the marker's accessible title where the platform has one. */
  name?: string;
  lat: number;
  lng: number;
  /**
   * Drives the pin colour: ICU free / beds only / at capacity / no live data.
   * Absent is meaningful — it renders as "no live data", not as an error.
   */
  capacity?: Capacity | null;
  /**
   * Total declared beds, which scales the pin. Absent renders at the floor size;
   * a candidate's clinical importance is not a function of its bed count anyway.
   */
  declared_beds?: number;
}

/** Adapt full facility records — the directory and the facility page. */
export function toMapPoints(facilities: Facility[]): MapPoint[] {
  return facilities.map((f) => ({
    id: f.id,
    short_name: f.short_name,
    name: f.name,
    lat: f.lat,
    lng: f.lng,
    capacity: f.capacity,
    declared_beds: f.declared?.beds,
  }));
}

/** Pin radius: bigger hospital, bigger dot, within a fixed range. */
export function pinRadius(point: MapPoint): number {
  const beds = point.declared_beds ?? 0;
  return Math.max(4, Math.min(9, 3 + Math.sqrt(beds) / 9));
}

export interface PinTone {
  fill: string;
  ring: string;
  label: string;
}

/**
 * Pin colour, in the same visual language as the status dots elsewhere in the
 * app: green means ICU is free, amber means beds but no critical care, red means
 * full, grey means the numbers cannot be trusted. Grey for "no recent data" is
 * deliberate rather than alarming — a facility that has not reported is not in
 * trouble, we simply do not know, and those are different messages.
 */
export function pinTone(point: MapPoint): PinTone {
  const cap = point.capacity;
  const stale = !cap || ['stale', 'cold', 'unknown'].includes(cap.trust_state ?? 'unknown');
  if (stale) return { fill: 'transparent', ring: '#8b93a1', label: 'No recent data' };
  if (cap.icu_effective > 0) return { fill: '#137547', ring: '#0e5c37', label: 'ICU available' };
  if (cap.beds_effective > 0) return { fill: '#8a5a00', ring: '#6d4700', label: 'Beds only' };
  return { fill: '#a32217', ring: '#7d1a12', label: 'At capacity' };
}

/** Solid fill for tile-based maps, which cannot draw a hollow marker. */
export function pinFill(point: MapPoint): string {
  const tone = pinTone(point);
  return tone.fill === 'transparent' ? tone.ring : tone.fill;
}

export function pinOpacity(point: MapPoint): number {
  return pinTone(point).fill === 'transparent' ? 0.45 : 1;
}
