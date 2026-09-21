import type { ExpoConfig } from 'expo/config';

/**
 * Build-time configuration.
 *
 * The map keys are read from the environment rather than committed, for two
 * reasons that matter more than convenience:
 *
 *  - **They are per-platform and per-origin.** An Android Maps key is bound to
 *    the app's package name plus signing certificate; a web key is bound to an
 *    HTTP referrer. They are not interchangeable, and publishing one key that
 *    "works everywhere" is how a project ends up with an unrestricted key.
 *  - **The app must build without them.** A district pilot with no Maps billing
 *    account still gets a working platform: `nativeMaps` is false, the native
 *    map view is not mounted, and every screen falls back to the schematic
 *    renderer instead of showing a grey rectangle.
 *
 * Set at build time:
 *   MEDMESH_GOOGLE_MAPS_ANDROID_KEY   — Android Maps SDK key (restrict by package + SHA-1)
 *   MEDMESH_GOOGLE_MAPS_IOS_KEY       — iOS Maps SDK key (restrict by bundle id)
 *   EXPO_PUBLIC_GOOGLE_MAPS_API_KEY   — web JavaScript API key (restrict by referrer)
 */

const androidKey = process.env.MEDMESH_GOOGLE_MAPS_ANDROID_KEY ?? '';
const iosKey = process.env.MEDMESH_GOOGLE_MAPS_IOS_KEY ?? '';

/** The production API origin; overridable so a staging build can point elsewhere. */
const apiUrl = process.env.EXPO_PUBLIC_API_URL ?? '';

const config: ExpoConfig = {
  name: 'MedMesh',
  slug: 'medmesh',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',

  scheme: 'medmesh',

  // A splash image is configured through the `expo-splash-screen` plugin rather
  // than the legacy top-level `splash` key, which the typed config no longer
  // accepts. Left to the plugin defaults until the brand assets are final.

  ios: {
    supportsTablet: true,
    bundleIdentifier: 'in.medmesh.app',
    // Only attach a key when one was supplied — an empty string makes the native
    // SDK fail at runtime with a warning nobody reads.
    ...(iosKey
      ? {
          config: {
            googleMapsApiKey: iosKey,
          },
        }
      : {}),
    infoPlist: {
      NSLocationWhenInUseUsageDescription:
        'MedMesh uses your location to show the nearest facilities with available capacity and to route an ambulance to a scene. Location is never stored against a patient record.',
    },
  },

  android: {
    package: 'in.medmesh.app',
    versionCode: 1,
    adaptiveIcon: {
      backgroundColor: '#E6F4FE',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
    predictiveBackGestureEnabled: false,
    permissions: [
      'android.permission.INTERNET',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.CALL_PHONE',
    ],
    ...(androidKey
      ? {
          config: {
            googleMaps: { apiKey: androidKey },
          },
        }
      : {}),
  },

  web: {
    favicon: './assets/favicon.png',
    bundler: 'metro',
    output: 'single',
  },

  plugins: ['expo-router', 'expo-status-bar'],

  extra: {
    /** Read back by src/lib/maps.ts to decide whether to mount the native SDK view. */
    nativeMaps: Boolean(androidKey || iosKey),
    apiUrl,
  },
};

export default config;
