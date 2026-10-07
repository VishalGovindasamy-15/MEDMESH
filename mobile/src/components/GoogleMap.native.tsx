import React, { useRef, useEffect } from 'react';
import { View } from 'react-native';
import WebView from 'react-native-webview';
import { useTheme } from '../theme/ThemeProvider';
import type { GoogleMapProps } from './GoogleMap.web';

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
  const webviewRef = useRef<any>(null);

  const defaultCenter = center || { lat: 10.9615, lng: 78.0807 };
  
  const polylinePositions = routePath ? routePath.map(p => [p[1], p[0]]) : [];

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
      <style>
        body { padding: 0; margin: 0; }
        #map { height: 100vh; width: 100vw; }
        .custom-marker {
          border-radius: 50%;
          border: 2px solid white;
          box-shadow: 0 0 4px rgba(0,0,0,0.5);
        }
      </style>
    </head>
    <body>
      <div id="map"></div>
      <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
      <script>
        const map = L.map('map', { zoomControl: false }).setView([${defaultCenter.lat}, ${defaultCenter.lng}], ${zoom});
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          attribution: '&copy; OpenStreetMap contributors'
        }).addTo(map);

        const markers = [];

        function createIcon(color, isSelected) {
          return L.divIcon({
            className: 'custom-marker',
            html: '<div style="background-color: ' + color + '; width: 100%; height: 100%; border-radius: 50%;"></div>',
            iconSize: isSelected ? [24, 24] : [16, 16],
            iconAnchor: isSelected ? [12, 12] : [8, 8]
          });
        }

        const points = ${JSON.stringify(points)};
        const selectedId = ${selectedId !== null ? selectedId : 'null'};
        const colors = {
          live: '${t.status.live.base}',
          warm: '${t.status.warm.base}',
          critical: '${t.status.critical.base}',
          muted: '${t.fg.muted}',
          accent: '${t.accent.base}'
        };

        points.forEach(p => {
          const isSelected = p.id === selectedId;
          const color = colors[p.tone] || colors.muted;
          const marker = L.marker([p.lat, p.lng], { icon: createIcon(color, isSelected) }).addTo(map);
          marker.bindPopup(p.label);
          marker.on('click', () => {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'select', id: p.id }));
          });
          markers.push(marker);
        });

        if (points.length > 0) {
          const bounds = L.latLngBounds(points.map(p => [p.lat, p.lng]));
          map.fitBounds(bounds, { padding: [20, 20], maxZoom: 12 });
        }

        const origin = ${origin ? JSON.stringify(origin) : 'null'};
        if (origin) {
          const oMarker = L.marker([origin.lat, origin.lng], { icon: createIcon(colors.accent, false) }).addTo(map);
          oMarker.bindPopup('${originLabel}');
        }

        const routePath = ${JSON.stringify(polylinePositions)};
        if (routePath.length > 0) {
          L.polyline(routePath, { color: colors.accent, weight: 4, opacity: 0.8 }).addTo(map);
        }
      </script>
    </body>
    </html>
  `;

  return (
    <View style={{ height, width: '100%', borderRadius: 12, overflow: 'hidden' }}>
      {/* @ts-ignore */}
      <WebView
        ref={webviewRef}
        style={{ flex: 1 }}
        source={{ html }}
        scrollEnabled={false}
        onMessage={(event: any) => {
          try {
            const data = JSON.parse(event.nativeEvent.data);
            if (data.type === 'select' && onSelect) {
              onSelect(data.id);
            }
          } catch (e) {}
        }}
      />
    </View>
  );
}
