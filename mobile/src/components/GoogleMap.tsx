/**
 * Platform dispatch for the basemap.
 *
 * Metro resolves `GoogleMap.web.tsx` for the web bundle and
 * `GoogleMap.native.tsx` for Android/iOS; this file exists so TypeScript — which
 * does not apply platform resolution — has one concrete module to resolve, and
 * so a bundler configuration that ignores platform extensions still gets a
 * working map (the web implementation is the safe default: it degrades to the
 * schematic view when there is no key).
 *
 * Nothing should import `GoogleMap.web` or `GoogleMap.native` directly except
 * this file and the native build.
 */
export { GoogleMap } from './GoogleMap.web';
export type { GoogleMapProps } from './GoogleMap.web';
