import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import { useTheme } from '../theme/ThemeProvider';

/**
 * Hand-built icon set. Stroke geometry on a 24px grid at a consistent 1.7
 * weight — mixing icon families at different optical weights is the fastest way
 * to make an interface look assembled rather than designed.
 */
const PATHS: Record<string, string> = {
  pulse: 'M3 12h3.5l2-5.5 3.5 11 2.5-5.5H21',
  hospital:
    'M4 21V7.5a1 1 0 0 1 1-1h4M4 21h16M20 21V10.5a1 1 0 0 0-1-1h-4M12 3v6M9 6h6M8 14h2M8 17.5h2M14 14h2M14 17.5h2',
  ambulance:
    'M2 16.5V9a1 1 0 0 1 1-1h9v8.5M12 10.5h4.6a2 2 0 0 1 1.7 1l1.7 2.6V16.5M2 16.5h1.5M19.5 16.5H20M9 16.5h6M13.5 6.5h3.5M15.25 4.75v3.5',
  pin: 'M12 21s6.2-5.5 6.2-10.2A6.2 6.2 0 0 0 5.8 10.8C5.8 15.5 12 21 12 21Z|M12 13.1a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4.2-4.2',
  chevronRight: 'M9.5 6l6 6-6 6',
  chevronLeft: 'M14.5 6l-6 6 6 6',
  chevronDown: 'M6 9.5l6 6 6-6',
  chevronUp: 'M6 14.5l6-6 6 6',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  moreHorizontal: 'M6 12h.01M12 12h.01M18 12h.01',
  keyboard: 'M3 6.5h18v11H3zM7 10h.01M11 10h.01M15 10h.01M7.5 14h9',
  crosshair: 'M12 3v3M12 18v3M3 12h3M18 12h3M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
  siren: 'M12 3a5 5 0 0 0-5 5v6h10V8a5 5 0 0 0-5-5ZM4 18h16M6.5 21h11',
  phoneOff: 'M3 3l18 18M6.6 6.7a15 15 0 0 0 10.7 10.7M9.5 4.6 8 3.2a1.6 1.6 0 0 0-2.2.1L4.4 4.8c-.9.9-1.2 2.3-.6 3.4',
  alert: 'M12 8v5M12 16.6v.1M10.3 3.7 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5.2l3.4 2',
  phone:
    'M5 3.5h3.2l1.6 4-2 1.4a12.5 12.5 0 0 0 6.3 6.3l1.4-2 4 1.6V18a2.5 2.5 0 0 1-2.7 2.5A16.8 16.8 0 0 1 2.5 6.2 2.5 2.5 0 0 1 5 3.5Z',
  user: 'M12 12.4a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20.5a7.5 7.5 0 0 1 15 0',
  users:
    'M9 12a3.8 3.8 0 1 0 0-7.6A3.8 3.8 0 0 0 9 12ZM2.5 20.2A6.5 6.5 0 0 1 15.5 20M16 4.6a3.8 3.8 0 0 1 0 7.3M17.5 14.2a6.5 6.5 0 0 1 4 6',
  shield: 'M12 21s7-3.2 7-9V5.8l-7-2.6-7 2.6V12c0 5.8 7 9 7 9Z|M9 11.8l2.2 2.2 4-4.2',
  bed: 'M3 19v-9M3 13h18v6M3 13a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3M21 19v-3.5a2.5 2.5 0 0 0-2.5-2.5H13M6.5 10a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2Z',
  activity: 'M4 4v16h16|M7.5 15l3-4 2.6 2.4L17 8',
  download: 'M12 3.5v11M7.5 10.5 12 15l4.5-4.5M4.5 19.5h15',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  check: 'M4.5 12.6l5 5 10-11',
  x: 'M6 6l12 12M18 6 6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 6.3M20 5v6h-6',
  wifi: 'M5 12.5a10 10 0 0 1 14 0M8.2 15.7a5.4 5.4 0 0 1 7.6 0M12 19.2v.1M2 9.3a15 15 0 0 1 20 0',
  wifiOff: 'M2 3l19 19M8.8 15.9a5.4 5.4 0 0 1 6.4-1M5 12.5a10 10 0 0 1 4-2.4M15 10.3a10 10 0 0 1 4 2.2M12 19.2v.1|M2 9.3a15 15 0 0 1 5-3',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9ZM12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4',
  moon: 'M20 14.4A8.6 8.6 0 0 1 9.6 4a8.6 8.6 0 1 0 10.4 10.4Z',
  filter: 'M3.5 6h17M6.5 12h11M10 18h4',
  layers: 'M12 3 3 7.5l9 4.5 9-4.5L12 3ZM3 12.5 12 17l9-4.5M3 17l9 4.5 9-4.5',
  logout: 'M15 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-2M10 12h11M18 9l3 3-3 3',
  lock: 'M6 10.5V8a6 6 0 0 1 12 0v2.5M5 10.5h14v9H5z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8.2v.1',
  route: 'M6.5 8.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM17.5 20.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM6.5 8.5v4a4 4 0 0 0 4 4h3a4 4 0 0 1 4 4',
  clockFast:
    'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17ZM12 7.2V12l3.2 1.9M2.5 6.5 5 4M21.5 6.5 19 4',
  blood: 'M12 3.5s5.5 6 5.5 10a5.5 5.5 0 1 1-11 0c0-4 5.5-10 5.5-10Z',
  fan: 'M12 12.8a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM12 8V3.2M14.1 12.2l4.2 2.3M9.9 12.2 5.7 14.5',
  building: 'M5 20.5V4.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v16M14 20.5V9.5h4a1 1 0 0 1 1 1v10M8 7h3M8 11h3M8 15h3M17 13h1M17 16.5h1',
  dots: 'M6 12v.1M12 12v.1M18 12v.1',
  flag: 'M5 3.5v17M5 4.5h11l-1.6 4 1.6 4H5',
  swap: 'M7 5 4 8l3 3M4 8h11M17 19l3-3-3-3M20 16H9',
  upload: 'M12 20.5v-11M7.5 13.5 12 9l4.5 4.5M4.5 4.5h15',
  bell: 'M6.5 9.5a5.5 5.5 0 0 1 11 0c0 3.4 1.2 4.6 1.6 5.4H4.9c.4-.8 1.6-2 1.6-5.4ZM10 18.4a2.1 2.1 0 0 0 4 0',
  link: 'M10 13.6a3.6 3.6 0 0 0 5.2 0l2.6-2.6a3.7 3.7 0 0 0-5.2-5.2l-1 1M14 10.4a3.6 3.6 0 0 0-5.2 0l-2.6 2.6a3.7 3.7 0 0 0 5.2 5.2l1-1',
  key: 'M15.2 4.5a5 5 0 1 1-3.6 8.5L10 14.6l-1.6.3-.3 1.6-1.6.3-.3 1.6-1.7.3v-1.9l6-6a5 5 0 0 1 4.7-6.3Z|M16.2 8.2v.1',
  server: 'M4.5 5.5h15v5h-15zM4.5 13.5h15v5h-15zM7.5 8v.1M7.5 16v.1',
  userplus: 'M10 12.4a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2.8 20.5a7.8 7.8 0 0 1 14.4 0M18 8.5v5M15.5 11h5',
  shield2: 'M12 3.2 5 5.8V12c0 5.2 7 8.6 7 8.6s7-3.4 7-8.6V5.8Z',
  mic: 'M12 14.4a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5.4a3 3 0 0 0 3 3ZM5.5 11.6a6.5 6.5 0 0 0 13 0M12 18.1V21M8.8 21h6.4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3.4 9h17.2M3.4 15h17.2M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z',
  arrowleft: 'M19 12H5M10 7l-5 5 5 5',
  arrowright: 'M5 12h14M14 7l5 5-5 5',
};

interface IconProps {
  name: keyof typeof PATHS | string;
  size?: number;
  color?: string;
  strokeWidth?: number;
}

export function Icon({ name, size = 18, color, strokeWidth = 1.7 }: IconProps) {
  const { t } = useTheme();
  const spec = PATHS[name] ?? PATHS.info;
  const tint = color ?? t.fg.base;
  const segments = spec.split('|');

  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {segments.map((d, i) => (
        <Path
          key={i}
          d={d}
          stroke={tint}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      ))}
    </Svg>
  );
}

/** Filled status dot, for use inside an existing Svg or standalone. */
export function DotSvg({ color, size = 7 }: { color: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={size / 2} cy={size / 2} r={size / 2} fill={color} />
    </Svg>
  );
}

export function BrandMark({ size = 24, color }: { size?: number; color?: string }) {
  const { t } = useTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x={1.2} y={1.2} width={21.6} height={21.6} rx={6} stroke={color ?? t.accent.base} strokeWidth={1.6} />
      <Path
        d="M5.5 12h3l1.8-4.4 3.2 8.8 1.8-4.4h3.2"
        stroke={color ?? t.accent.base}
        strokeWidth={1.9}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
