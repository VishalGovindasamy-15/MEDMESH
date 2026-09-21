import { Platform } from 'react-native';

export const CATEGORY_LABELS: Record<string, string> = {
  road_accident: 'Road accident',
  cardiac: 'Cardiac',
  stroke: 'Stroke',
  obstetric: 'Obstetric',
  paediatric: 'Paediatric',
  burns: 'Burns',
  trauma_fall: 'Fall / trauma',
  snakebite: 'Snakebite',
  poisoning: 'Poisoning',
  respiratory: 'Respiratory',
  dialysis: 'Dialysis',
  other: 'Other',
};

export const STATUS_LABELS: Record<string, string> = {
  open: 'Awaiting dispatch',
  dispatched: 'Ambulance assigned',
  en_route: 'En route to scene',
  arrived: 'Patient on board',
  handed_over: 'Handed over',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export const SPECIALTY_LABELS: Record<string, string> = {
  general_medicine: 'General medicine',
  general_surgery: 'General surgery',
  orthopaedics: 'Orthopaedics',
  cardiology: 'Cardiology',
  neurology: 'Neurology',
  neurosurgery: 'Neurosurgery',
  paediatrics: 'Paediatrics',
  obstetrics: 'Obstetrics',
  gynaecology: 'Gynaecology',
  burns: 'Burns',
  plastic_surgery: 'Plastic surgery',
  nephrology: 'Nephrology',
  pulmonology: 'Pulmonology',
  critical_care: 'Critical care',
  trauma: 'Trauma',
  urology: 'Urology',
  gastroenterology: 'Gastroenterology',
  oncology: 'Oncology',
  psychiatry: 'Psychiatry',
};

export const CAPABILITY_LABELS: Record<string, string> = {
  blood_bank: 'Blood bank',
  trauma_centre: 'Trauma centre',
  cath_lab: 'Cath lab',
  burn_unit: 'Burns unit',
  dialysis: 'Dialysis',
  neonatal_icu: 'Neonatal ICU',
};

export const specialtyLabel = (key: string) =>
  SPECIALTY_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const categoryLabel = (key: string) =>
  CATEGORY_LABELS[key] ?? key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

/** Elapsed time phrased the way a dispatcher says it out loud. */
export function elapsed(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.floor(seconds % 60).toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export function clockTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function dateTime(iso?: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toLocaleDateString([], { day: '2-digit', month: 'short' })} ${d.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })}`;
}

export function relativeFromIso(iso?: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return 'never';
  return ageFromSeconds(Math.max(0, Math.floor(ms / 1000)));
}

export function ageFromSeconds(seconds: number): string {
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

/** "14 min" / "1 h 05 m" — for countdowns. */
export function countdown(seconds: number): string {
  if (seconds <= 0) return 'expired';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}:${s.toString().padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0];
  const second = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + second).toUpperCase();
}

export function titleCase(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initialsOf(name: string): string {
  const cleaned = name.replace(/\b(Dr|Mr|Ms|Mrs)\.?\s*/gi, '').trim();
  const parts = cleaned.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '—';
}

/**
 * Deterministic pseudo-map projection.
 *
 * The pilot renders its own map canvas instead of pulling a tile provider, so
 * the same coordinates must project to the same pixels on every device and in
 * every snapshot test. Web Mercator at a fixed zoom, no camera state.
 */
export function projectToCanvas(
  points: { lat: number; lng: number }[],
  width: number,
  height: number,
  padding = 26,
): { x: number; y: number }[] {
  if (!points.length) return [];
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  const spanLat = maxLat - minLat || 0.02;
  const spanLng = maxLng - minLng || 0.02;
  const scale = Math.min((width - padding * 2) / spanLng, (height - padding * 2) / spanLat);
  const offsetX = (width - spanLng * scale) / 2;
  const offsetY = (height - spanLat * scale) / 2;

  return points.map((p) => ({
    x: offsetX + (p.lng - minLng) * scale,
    y: height - (offsetY + (p.lat - minLat) * scale),
  }));
}

export const isWeb = Platform.OS === 'web';
