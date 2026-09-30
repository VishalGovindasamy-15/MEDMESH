import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Banner, Button, Label, Num, Row, Small, Stack, TextField } from '../ui';
import { Icon } from '../ui/Icon';
import { MapSurface } from './MapSurface';

/**
 * Where the emergency is.
 *
 * This replaced a single `districtLatLng()` lookup, which meant every incident
 * raised in Coimbatore was recorded at the centre of Coimbatore district — the
 * collectors' office on State Bank Road — regardless of where the caller
 * actually was. Two consequences, and the second is the serious one:
 *
 *   The map showed an incident marker in the same place every time, so the
 *   dispatcher learned to ignore it; the real location only existed in the
 *   landmark string, which the routing engine cannot read.
 *
 *   The matching engine ranks facilities by road ETA *from the incident's
 *   coordinates*. A call from Pollachi — 40 km south of the district centre —
 *   was matched, ranked and ambulanced as though it were in the middle of
 *   Coimbatore city. The shortlist it produced was for a different journey.
 *
 * A 108 call-taker knows the location. This control asks them for it in the
 * order of how good the answer is:
 *
 *   1. A pasteable coordinates field. Most Indian emergency call-takers receive
 *      an AML fix on the call, and the fastest thing they can do is paste it.
 *   2. A map the operator taps to drop a pin, for a caller who can describe
 *      where they are but has no coordinates.
 *   3. The device's own location, for the case where the dispatcher is the
 *      person at the scene (a supervisor responding directly).
 *   4. District centre, as an explicitly-labelled last resort — never silent.
 *
 * Whatever the source, the control states the provenance and, when the fix is
 * the district centre, says so in the same visual weight as the coordinates.
 * The one outcome that must not happen is a placeholder being mistaken for a fix.
 */

/**
 * How the fix was taken down at the console. Deliberately wider than the value
 * the API stores: an operator who pasted an AML string and one who read an
 * address off a map and clicked the correct spot are both "manual" to the
 * record, but the UI copy differs, and the offset warning is only meaningful
 * for the pasted case.
 */
export type CaptureMethod = 'coordinates' | 'map' | 'device' | 'district';

/** What gets persisted. Must match `LocationSource` in backend/app/models.py. */
export type LocationSource = 'gps' | 'map' | 'manual' | 'district';

export const CAPTURE_TO_SOURCE: Record<CaptureMethod, LocationSource> = {
  coordinates: 'manual',
  map: 'map',
  device: 'gps',
  district: 'district',
};

export interface IncidentLocation {
  lat: number;
  lng: number;
  /** What was taken down here, drives the copy. */
  method: CaptureMethod;
  /** What will be stored, and what the map banner keys off. */
  source: LocationSource;
  /** How far the pin is from the district centre, for the discipline check. */
  offsetKm: number | null;
}

export function LocationPicker({
  districts,
  districtId,
  value,
  onChange,
}: {
  districts: { id: number; name: string; lat: number; lng: number }[];
  districtId: string;
  value: IncidentLocation | null;
  onChange: (next: IncidentLocation | null) => void;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const [latText, setLatText] = useState('');
  const [lngText, setLngText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [mapCenter, setMapCenter] = useState<{ lat: number; lng: number } | null>(null);

  const district = useMemo(
    () => districts.find((d) => String(d.id) === districtId) ?? null,
    [districts, districtId],
  );

  /**
   * Reset when the district changes, because the coordinate is scoped to it:
   * carrying a Coimbatore pin into a Madurai incident would repeat exactly the
   * mistake this component exists to prevent, one layer up.
   */
  useEffect(() => {
    onChange(null);
    setLatText('');
    setLngText('');
    setProblem(null);
    setMapCenter(district ? { lat: district.lat, lng: district.lng } : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [districtId]);

  /** Rough great-circle distance, purely to sanity-check the pin. */
  const straightKm = useCallback(
    (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => {
      const R = 6371;
      const dLat = ((b.lat - a.lat) * Math.PI) / 180;
      const dLng = ((b.lng - a.lng) * Math.PI) / 180;
      const la1 = (a.lat * Math.PI) / 180;
      const la2 = (b.lat * Math.PI) / 180;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    },
    [],
  );

  const commit = useCallback(
    (lat: number, lng: number, method: CaptureMethod) => {
      const offset = district ? straightKm(district, { lat, lng }) : null;
      onChange({ lat, lng, method, source: CAPTURE_TO_SOURCE[method], offsetKm: offset });
    },
    [district, straightKm, onChange],
  );

  const applyTyped = () => {
    const lat = Number(latText.trim());
    const lng = Number(lngText.trim());
    if (!latText.trim() || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return setProblem('Latitude must be a number between -90 and 90.');
    }
    if (!lngText.trim() || !Number.isFinite(lng) || lng < -180 || lng > 180) {
      return setProblem('Longitude must be a number between -180 and 180.');
    }
    // Tamil Nadu is roughly 8.0–13.6 N, 76.2–80.4 E. A coordinate outside that
    // is almost always a transposition or a stray character, and catching it
    // here costs nothing while catching it from a wrong ambulance route does not.
    if (lat < 7.5 || lat > 14.5 || lng < 75.5 || lng > 81.0) {
      return setProblem(
        `That point is outside Tamil Nadu (${lat.toFixed(3)}, ${lng.toFixed(3)}). Check the digits — a transposed pair is the usual cause.`,
      );
    }
    setProblem(null);
    commit(lat, lng, 'coordinates');
  };

  const useDevice = async () => {
    setLocating(true);
    setProblem(null);
    try {
      const Location = require('expo-location');
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') {
        setProblem('Location permission was declined. Enter the coordinates or drop a pin instead.');
        return;
      }
      const fix = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy?.Balanced ?? 3 });
      const lat = fix.coords.latitude;
      const lng = fix.coords.longitude;
      setLatText(lat.toFixed(5));
      setLngText(lng.toFixed(5));
      setMapCenter({ lat, lng });
      commit(lat, lng, 'device');
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'Could not read the device location.');
    } finally {
      setLocating(false);
    }
  };

  const useDistrictCentre = () => {
    if (!district) return;
    setLatText(district.lat.toFixed(5));
    setLngText(district.lng.toFixed(5));
    setMapCenter({ lat: district.lat, lng: district.lng });
    commit(district.lat, district.lng, 'district');
  };

  const pinsHeld = useRef(false);
  const isPlaceholder = value?.source === 'district';
  const farFromDistrict = (value?.offsetKm ?? 0) > 120;

  return (
    <Stack gap="sm">
      <Label>Incident location</Label>

      <Row
        style={{
          alignItems: 'center',
          gap: space.sm,
          padding: space.md,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: value ? (isPlaceholder ? t.status.warm.base : t.line.base) : t.line.base,
          backgroundColor: t.bg.raised,
        }}
      >
        <Icon
          name={value ? (isPlaceholder ? 'alert' : 'pin') : 'search'}
          size={15}
          color={value ? (isPlaceholder ? t.status.warm.base : t.accent.base) : t.fg.faint}
        />
        <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
          {value ? (
            <>
              <Row gap="sm" align="baseline">
                <Num size={13}>
                  {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
                </Num>
                <Small muted style={{ fontSize: 11 }}>
                  {value.method === 'coordinates'
                    ? 'from the caller\'s coordinates'
                    : value.method === 'device'
                      ? 'from this device'
                      : value.method === 'map'
                        ? 'dropped on the map'
                        : 'district centre — approximate'}
                </Small>
              </Row>
              {value.offsetKm !== null ? (
                <Small muted style={{ fontSize: 11 }}>
                  {value.offsetKm < 0.5
                    ? `At the ${district?.name ?? 'district'} centre`
                    : `${Math.round(value.offsetKm)} km from the ${district?.name ?? 'district'} centre`}
                  {value.source === 'district' && value.offsetKm < 0.5
                    ? ' — the placeholder, not a fix'
                    : ''}
                </Small>
              ) : null}
            </>
          ) : (
            <Small muted style={{ fontSize: 12 }}>
              Not set. The matching engine ranks hospitals by drive time from this point, so an unset location produces a shortlist for the wrong journey.
            </Small>
          )}
        </Stack>
        <Button label={open ? 'Close' : 'Set location'} size="sm" onPress={() => setOpen((v) => !v)} />
      </Row>

      {isPlaceholder && !farFromDistrict ? (
        <Banner
          tone="warm"
          icon="alert"
          title="This is the district centre, not the caller"
          body={`Every emergency raised this way is routed as though it happened at ${district?.name ?? 'the district'} headquarters, which will pick the wrong hospital for anything outside the city. Paste the coordinates from the call, or drop a pin on the map.`}
        />
      ) : null}

      {farFromDistrict ? (
        <Banner
          tone="critical"
          icon="alert"
          title="That pin is a long way from the district"
          body={`${Math.round(value?.offsetKm ?? 0)} km from the ${district?.name ?? 'selected'} centre. Check the district selection, or confirm the coordinates before dispatching.`}
        />
      ) : null}

      {open ? (
        <View
          style={{
            padding: space.md,
            borderRadius: radius.md,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.line.base,
            backgroundColor: t.bg.raised,
            gap: space.md,
          }}
        >
          {problem ? <Banner tone="critical" icon="alert" title="Not accepted" body={problem} /> : null}

          <Stack gap="xs">
            <Label>Coordinates from the call</Label>
            <Row gap="sm" wrap>
              <TextField
                label="Latitude"
                value={latText}
                onChangeText={setLatText}
                placeholder="11.01684"
                keyboardType="numeric"
                style={{ flex: 1, minWidth: 130 }}
              />
              <TextField
                label="Longitude"
                value={lngText}
                onChangeText={setLngText}
                placeholder="76.95583"
                keyboardType="numeric"
                style={{ flex: 1, minWidth: 130 }}
              />
              <View style={{ justifyContent: 'flex-end', paddingBottom: 2 }}>
                <Button label="Use these" size="md" variant="primary" onPress={applyTyped} />
              </View>
            </Row>
          </Stack>

          <Row gap="xs" style={{ flexWrap: 'wrap' }}>
            <Button
              label={locating ? 'Locating…' : 'Use this device\'s location'}
              icon="pin"
              size="sm"
              loading={locating}
              onPress={useDevice}
            />
            <Button
              label="District centre (approximate)"
              size="sm"
              variant="ghost"
              onPress={useDistrictCentre}
              disabled={!district}
            />
            <Button
              label="Clear"
              size="sm"
              variant="ghost"
              onPress={() => {
                setLatText('');
                setLngText('');
                onChange(null);
              }}
            />
          </Row>

          <Stack gap="xs">
            <Label>Or drop a pin</Label>
            <Small muted style={{ fontSize: 11.5 }}>
              Tap the map where the caller is. Zoom in before tapping — at this scale a few pixels is a kilometre.
            </Small>
            <MapSurface
              center={mapCenter ?? (district ? { lat: district.lat, lng: district.lng } : { lat: 11.0168, lng: 76.9558 })}
              zoom={12}
              height={240}
              points={
                value
                  ? [
                      {
                        id: -1,
                        short_name: 'Incident',
                        name: 'Incident location',
                        lat: value.lat,
                        lng: value.lng,
                        capacity: null,
                      },
                    ]
                  : []
              }
              origin={district ? { lat: district.lat, lng: district.lng } : undefined}
              onPress={(point) => {
                pinsHeld.current = true;
                setLatText(point.lat.toFixed(5));
                setLngText(point.lng.toFixed(5));
                setMapCenter(point);
                commit(point.lat, point.lng, 'map');
              }}
            />
          </Stack>
        </View>
      ) : null}
    </Stack>
  );
}
