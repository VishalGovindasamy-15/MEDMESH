/**
 * Geometry the client is allowed to do.
 *
 * Everything that decides where a patient goes is resolved on the server against
 * the road network — see `backend/app/services/routing.py`. The client keeps one
 * measurement of its own for the cases where a road distance would be wrong to
 * show: it is a great-circle line between two points, it is labelled as such
 * wherever it is rendered, and it is never used to rank anything.
 */

/** Great-circle distance in kilometres. */
export function straightKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Round-trip time in minutes at an assumed average speed. */
export function straightMinutes(a: { lat: number; lng: number }, b: { lat: number; lng: number }, kmph = 34): number {
  return Math.max(1, Math.round((straightKm(a, b) / kmph) * 60));
}
