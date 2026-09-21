/**
 * MedMesh design tokens.
 *
 * Rules this file exists to enforce:
 *  - No screen may hardcode a colour, radius or font size. Everything resolves
 *    through here, which is what makes the dark variant a token swap rather
 *    than a rewrite.
 *  - One accent hue. Status colour is semantic and never decorative: green
 *    means live, amber means ageing, red means act now. Nothing else is allowed
 *    to be red.
 *  - 4px spatial grid, 1px hairlines, tight radii. Dense operational software,
 *    not a marketing page.
 *
 * Type scale is deliberately short. Five sizes cover every surface in the app.
 */

import { Platform } from 'react-native';

export const space = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  xxl: 30,
  xxxl: 40,
} as const;

export const radius = {
  sm: 4,
  md: 6,
  lg: 9,
  xl: 14,
  pill: 999,
} as const;

export const type = {
  display: { fontSize: 27, lineHeight: 32, fontWeight: '600' as const, letterSpacing: -0.6 },
  title: { fontSize: 19, lineHeight: 25, fontWeight: '600' as const, letterSpacing: -0.3 },
  heading: { fontSize: 15.5, lineHeight: 21, fontWeight: '600' as const, letterSpacing: -0.1 },
  body: { fontSize: 14.5, lineHeight: 21, fontWeight: '400' as const },
  small: { fontSize: 13, lineHeight: 18, fontWeight: '400' as const },
  micro: { fontSize: 11.5, lineHeight: 15, fontWeight: '600' as const, letterSpacing: 0.5 },
  nano: { fontSize: 10.5, lineHeight: 14, fontWeight: '600' as const, letterSpacing: 0.6 },
} as const;

export const mono = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
}) as string;

export const sans = Platform.select({
  ios: 'System',
  android: 'sans-serif',
  default:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif',
}) as string;

export type ThemeMode = 'light' | 'dark';

export interface Tokens {
  mode: ThemeMode;
  /** Backgrounds, back to front. */
  bg: { app: string; surface: string; raised: string; sunken: string; inverse: string };
  /** Foreground text, strongest to faintest. */
  fg: { strong: string; base: string; muted: string; faint: string; inverse: string };
  line: { subtle: string; base: string; strong: string };
  accent: { base: string; strong: string; soft: string; wash: string; on: string };
  /** Semantic status. `soft` is the tinted fill, `base` the text/stroke. */
  status: {
    live: { base: string; soft: string };
    warm: { base: string; soft: string };
    stale: { base: string; soft: string };
    critical: { base: string; soft: string };
    info: { base: string; soft: string };
    neutral: { base: string; soft: string };
  };
  chart: { grid: string; series: string[] };
  shadow: { color: string; opacity: number; radius: number; offsetY: number; elevation: number };
}

const lightStatus = {
  live: { base: '#137547', soft: '#e6f4ec' },
  warm: { base: '#8a5a00', soft: '#fdf1dc' },
  stale: { base: '#a13a2a', soft: '#fbe9e6' },
  critical: { base: '#a32217', soft: '#fbe4e1' },
  info: { base: '#12459f', soft: '#e6eefc' },
  neutral: { base: '#5c6572', soft: '#eef0f4' },
};

const darkStatus = {
  live: { base: '#4ecb86', soft: '#10291d' },
  warm: { base: '#e0a33c', soft: '#2b2113' },
  stale: { base: '#e8796a', soft: '#2d1a17' },
  critical: { base: '#f26d5e', soft: '#331a16' },
  info: { base: '#7aabf7', soft: '#141f33' },
  neutral: { base: '#98a1b0', soft: '#1c2028' },
};

export const themes: Record<ThemeMode, Tokens> = {
  light: {
    mode: 'light',
    bg: {
      app: '#f4f5f7',
      surface: '#ffffff',
      raised: '#ffffff',
      sunken: '#fafbfc',
      inverse: '#141a22',
    },
    fg: {
      strong: '#0e1218',
      base: '#242c37',
      muted: '#5c6572',
      faint: '#8b93a1',
      inverse: '#f4f5f7',
    },
    line: { subtle: '#e8eaee', base: '#dcdfe5', strong: '#c3c8d1' },
    accent: { base: '#1b57c4', strong: '#12459f', soft: '#e6eefc', wash: '#f5f8fd', on: '#ffffff' },
    status: lightStatus,
    chart: { grid: '#e8eaee', series: ['#1b57c4', '#137547', '#8a5a00', '#a32217'] },
    shadow: { color: '#0e1218', opacity: 0.06, radius: 12, offsetY: 2, elevation: 2 },
  },
  dark: {
    mode: 'dark',
    bg: {
      app: '#0d1116',
      surface: '#151a21',
      raised: '#1a2028',
      sunken: '#11161c',
      inverse: '#f4f5f7',
    },
    fg: {
      strong: '#f2f4f7',
      base: '#d3d8e0',
      muted: '#98a1b0',
      faint: '#6e7787',
      inverse: '#0e1218',
    },
    line: { subtle: '#212833', base: '#2a323e', strong: '#3a4351' },
    accent: { base: '#5b8ff0', strong: '#7aa8f5', soft: '#182437', wash: '#131a24', on: '#0d1116' },
    status: darkStatus,
    chart: { grid: '#212833', series: ['#5b8ff0', '#4ecb86', '#e0a33c', '#f26d5e'] },
    shadow: { color: '#000000', opacity: 0.4, radius: 14, offsetY: 2, elevation: 3 },
  },
};

/** Freshness → status key. Single mapping, used by every surface. */
export const freshnessStatus = (state?: string | null): keyof Tokens['status'] => {
  switch (state) {
    case 'live':
      return 'live';
    case 'warm':
      return 'warm';
    case 'stale':
      return 'stale';
    case 'cold':
    case 'unknown':
      return 'critical';
    default:
      return 'neutral';
  }
};

export const congestionStatus = (level?: string | null): keyof Tokens['status'] => {
  switch (level) {
    case 'low':
      return 'live';
    case 'moderate':
      return 'warm';
    case 'high':
      return 'stale';
    case 'critical':
      return 'critical';
    default:
      return 'neutral';
  }
};

export const trustStatus = (score?: number | null): keyof Tokens['status'] => {
  if (score == null) return 'neutral';
  if (score >= 80) return 'live';
  if (score >= 55) return 'warm';
  return 'stale';
};

export const urgencyStatus = (urgency?: string | null): keyof Tokens['status'] =>
  urgency === 'P1' ? 'critical' : urgency === 'P2' ? 'warm' : 'neutral';
