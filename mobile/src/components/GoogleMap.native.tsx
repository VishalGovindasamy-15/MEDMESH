import React from 'react';
import { StyleSheet, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';

import type { MapPoint } from './mapTypes';
import { pinFill, pinOpacity } from './mapTypes';
import { useTheme } from '../theme/ThemeProvider';
import { radius } from '../theme/tokens';
import { DEFAULT_CENTER, DEFAULT_ZOOM } from '../lib/maps';

/**
 * Google Maps basemap — Android and iOS.
 *
 * `PROVIDER_GOOGLE` is passed explicitly. On Android that is the only provider
 * and it is what the APK ships; on iOS it forces Google tiles rather than
 * Apple's, so a dispatch console and a crew phone show the same basemap and the
 * same road names — which matters when two people are describing the same
 * junction on a call.
 *
 * Coordinates are kept in `{ latitude, longitude }` at this boundary and
 * converted from the app's `{ lat, lng }` in one place, so a mix-up cannot
 * propagate inward.
 */

export interface GoogleMapProps {
  points?: MapPoint[];
  center?: { lat: number; lng: number };
  zoom?: number;
  height?: number;
  selectedId?: number | null;
  onSelect?: (id: number) => void;
  origin?: { lat: number; lng: number } | null;
  originLabel?: string;
  routePath?: [number, number][];
  routeTone?: 'accent' | 'live' | 'warm';
  interactive?: boolean;
}

function toLatLng(p: { lat: number; lng: number }) {
  return { latitude: p.lat, longitude: p.lng };
}

/** Zoom → latitudeDelta, good enough for the fixed-height map cards used here. */
function deltaForZoom(zoom: number) {
  return 360 / Math.pow(2, zoom);
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
  const camera = center ?? DEFAULT_CENTER;
  const delta = deltaForZoom(zoom);

  return (
    <View style={{ height, borderRadius: radius.lg, overflow: 'hidden' }}>
      <MapView
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
        initialRegion={{
          latitude: camera.lat,
          longitude: camera.lng,
          latitudeDelta: delta,
          longitudeDelta: delta,
        }}
        region={
          center
            ? {
                latitude: camera.lat,
                longitude: camera.lng,
                latitudeDelta: delta,
                longitudeDelta: delta,
              }
            : undefined
        }
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={false}
        pitchEnabled={false}
        toolbarEnabled={false}
        showsUserLocation={false}
        showsMyLocationButton={false}
        showsPointsOfInterests={false}
        showsCompass={interactive}
        // Kept in step with the web basemap style so the two surfaces read alike.
        customMapStyle={QUIET_BASEMAP}
      >
        {points.map((f) => (
          <Marker
            key={f.id}
            coordinate={toLatLng(f)}
            title={f.short_name}
            description={f.name}
            onPress={() => onSelect?.(f.id)}
            pinColor={pinFill(f)}
            opacity={pinOpacity(f)}
            zIndex={f.id === selectedId ? 999 : 1}
          />
        ))}

        {origin ? (
          <Marker
            coordinate={toLatLng(origin)}
            title={originLabel}
            pinColor={t.accent.base}
            zIndex={1000}
          />
        ) : null}

        {routePath && routePath.length > 1 ? (
          <Polyline
            coordinates={routePath.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))}
            strokeColor={routeTone === 'accent' ? t.accent.base : t.status[routeTone].base}
            strokeWidth={4}
          />
        ) : null}
      </MapView>
    </View>
  );
}

const QUIET_BASEMAP = [
  { elementType: 'geometry', stylers: [{ saturation: -70 }, { lightness: 12 }] },
  { elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ lightness: 32 }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#cfd8e3' }] },
];
