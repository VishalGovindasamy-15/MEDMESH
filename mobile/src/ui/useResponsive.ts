import { useWindowDimensions } from 'react-native';

/**
 * Breakpoints. Three widths matter:
 *   < 620   phone         — single column, bottom tab bar, full-bleed lists
 *   < 1024  tablet/small  — two-column grids, still a bottom bar
 *   >= 1024 desktop       — persistent left rail, multi-column ops layouts
 *
 * Named for what the layout does, not for a device, because a desktop browser
 * window resized to 700px should behave like a tablet, not like a squeezed
 * desktop.
 */
export const BREAKPOINT = { phone: 620, desktop: 1024 } as const;

export interface Responsive {
  width: number;
  height: number;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
  /** Suggested number of columns for card grids at the current width. */
  columns: number;
  /** Horizontal page padding. Keeps content off the bezel without shrinking
   *  the usable width on a phone. */
  gutter: number;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const isPhone = width < BREAKPOINT.phone;
  const isDesktop = width >= BREAKPOINT.desktop;
  const isTablet = !isPhone && !isDesktop;

  const columns = isDesktop ? (width >= 1500 ? 3 : 2) : isPhone ? 1 : 2;
  const gutter = isPhone ? 12 : isDesktop ? 28 : 18;

  return { width, height, isPhone, isTablet, isDesktop, columns, gutter };
}
