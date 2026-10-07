import React, { useEffect } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import { useTheme } from '../theme/ThemeProvider';
import { View } from 'react-native';

export interface GoogleMapProps {
  points?: any[];
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
  onPress?: (point: { lat: number; lng: number }) => void;
}

function MapUpdater({ points, center, zoom, origin }: { points?: any[]; center?: { lat: number; lng: number }; zoom?: number; origin?: { lat: number; lng: number } | null }) {
  const map = useMap();
  useEffect(() => {
    if ((points && points.length > 0) || origin) {
      const allPoints = [...(points || [])];
      if (origin) {
        allPoints.push(origin);
      }
      const bounds = L.latLngBounds(allPoints.map(p => [p.lat, p.lng]));
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 14 });
    } else if (center) {
      map.setView([center.lat, center.lng], zoom || 15);
    }
  }, [points, center, zoom, origin, map]);
  return null;
}

export function GoogleMap({
  points = [],
  center,
  zoom = 10,
  height = 300,
  selectedId = null,
  onSelect,
  origin = null,
  originLabel = 'Scene',
  routePath,
}: GoogleMapProps) {
  const { t } = useTheme();

  // Create custom icon
  const createIcon = (color: string, isSelected: boolean) => {
    return L.divIcon({
      className: 'custom-marker',
      html: `<div style="
        background-color: ${color};
        width: ${isSelected ? '24px' : '16px'};
        height: ${isSelected ? '24px' : '16px'};
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 0 0 4px rgba(0,0,0,0.5);
      "></div>`,
      iconSize: isSelected ? [24, 24] : [16, 16],
      iconAnchor: isSelected ? [12, 12] : [8, 8],
    });
  };

  const defaultCenter = center || { lat: 10.9615, lng: 78.0807 };

  const polylinePositions = routePath ? routePath.map(p => [p[1], p[0]] as [number, number]) : [];

  return (
    <View style={{ height, width: '100%', borderRadius: 12, overflow: 'hidden' }}>
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <MapContainer 
        center={[defaultCenter.lat, defaultCenter.lng]} 
        zoom={zoom} 
        style={{ height: '100%', width: '100%' }}
        scrollWheelZoom={false}
      >
        <MapUpdater points={points} center={defaultCenter} zoom={zoom} origin={origin} />
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution="&copy; OpenStreetMap contributors"
        />
        {points.map((p) => {
          const isSelected = selectedId === p.id;
          const color = p.tone === 'live' ? t.status.live.base : 
                        p.tone === 'warm' ? t.status.warm.base : 
                        p.tone === 'critical' ? t.status.critical.base : t.fg.muted;
          return (
            <Marker 
              key={p.id}
              position={[p.lat, p.lng]} 
              icon={createIcon(color, isSelected)}
              eventHandlers={{
                click: () => onSelect && onSelect(p.id)
              }}
            >
              <Popup>{p.label}</Popup>
            </Marker>
          );
        })}
        {origin && (
          <Marker position={[origin.lat, origin.lng]} icon={createIcon(t.accent.base, false)}>
            <Popup>{originLabel}</Popup>
          </Marker>
        )}
        {polylinePositions.length > 0 && (
          <Polyline positions={polylinePositions} color={t.accent.base} weight={4} opacity={0.8} />
        )}
      </MapContainer>
    </View>
  );
}
