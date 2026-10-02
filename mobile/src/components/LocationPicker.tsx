import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';

import { straightKm } from '../lib/geo';
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
 * A 108 call-taker knows the location, and — this is the part the second
 * design got wrong — knows *how* they know it. This control asks the question
 * outright, in the order of how good the answer is:
 *
 *   1. The caller gave coordinates (most Indian emergency call-takers receive
 *      an AML fix on the call; the fastest thing they can do is paste it).
 *   2. A pin dropped on the map, for a caller who can describe where they are.
 *   3. The device's own location, for the case where the dispatcher is the
 *      person at the scene (a supervisor responding directly).
 *   4. District centre — approximate, and labelled approximate everywhere it
 *      appears, never silent.
 *
 * The first three are marked ● EXACT and the fourth ○ APPROXIMATE on the
 * chooser row itself, before anything is picked, and the badge travels with
 * the value: a dispatcher who is about to dispatch to a district centre can
 * see that fact in the same glance as the coordinates. The one outcome that
 * must not happen is a placeholder being mistaken for a fix.
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

/**
 * One row of the "how do you know the location?" chooser.
 *
 * A row rather than a button because the row carries the exactness badge and a
 * line of copy — the two things that stop a dispatcher tapping "district
 * centre" believing it is a fix. The badge is ● EXACT for the three real
 * sources and ○ APPROXIMATE for the fallback, in the warm tone, so the
 * difference is readable at a glance and in peripheral vision.
 */
function SourceRow({
  icon,
  title,
  subtitle,
  exact,
  active,
  busy,
  disabled,
  onPress,
}: {
  icon: 'keyboard' | 'crosshair' | 'pin' | 'grid';
  title: string;
  subtitle: string;
  exact: boolean;
  active?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={() => !disabled && !busy && onPress()}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled || !!busy, selected: !!active }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.sm,
        paddingVertical: 9,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: active ? t.accent.base : exact ? t.line.base : t.status.warm.base,
        backgroundColor: active ? t.accent.soft : exact ? t.bg.surface : t.status.warm.soft,
        opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
      })}
    >
      <Icon
        name={icon}
        size={15}
        color={active ? t.accent.base : exact ? t.fg.muted : t.status.warm.base}
      />
      <Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
        <Small style={{ fontSize: 12.5, fontWeight: '600', color: t.fg.strong }} numberOfLines={1}>
          {title}
        </Small>
        <Small muted style={{ fontSize: 11 }} numberOfLines={2}>
          {subtitle}
        </Small>
      </Stack>
      {busy ? (
        <Small muted style={{ fontSize: 11 }}>…</Small>
      ) : (
        <Small
          style={{
            fontSize: 10.5,
            fontWeight: '700',
            letterSpacing: 0.4,
            color: exact ? t.fg.muted : t.status.warm.base,
          }}
        >
          {exact ? '● EXACT' : '○ APPROX'}
        </Small>
      )}
    </Pressable>
  );
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
  /**
   * Which capture control is showing, if any.
   *
   * This used to be a single boolean behind a "Set location" button, and the
   * audit's complaint was fair: the first action of an emergency console was a
   * button that opened a panel that contained four more buttons, and an operator
   * who did not already know that "district centre" was an option read the
   * screen as blocked. The three ways of getting a coordinate are now visible
   * from the start, and the approximate fallback is a labelled row underneath
   * them rather than a hole an operator has to find.
   */
  const [mode, setMode] = useState<'none' | 'coordinates' | 'map'>('none');
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

  const commit = useCallback(
    (lat: number, lng: number, method: CaptureMethod) => {
      // Guard against a NaN pin from the canvas handler: `toFixed(5)` on NaN
      // renders "NaN" in the summary row and posts `lat: NaN` to the API,
      // which is worse than refusing the fix.
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        setProblem('That point did not resolve to a coordinate. Try again, or enter the numbers by hand.');
        return;
      }
      const offset = district ? straightKm(district, { lat, lng }) : null;
      onChange({ lat, lng, method, source: CAPTURE_TO_SOURCE[method], offsetKm: offset });
    },
    [district, onChange],
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
              <Row gap="sm" align="center" wrap>
                {/* The badge is the whole point of #14: exactness has to be
                    visible in the same glance as the digits, not implied by
                    which button was pressed three interactions ago. */}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 5,
                    paddingHorizontal: 7,
                    paddingVertical: 2,
                    borderRadius: radius.sm,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: isPlaceholder ? t.status.warm.base : t.line.base,
                    backgroundColor: isPlaceholder ? t.status.warm.soft : t.bg.sunken,
                  }}
                >
                  <Small
                    style={{
                      fontSize: 10.5,
                      fontWeight: '700',
                      letterSpacing: 0.5,
                      color: isPlaceholder ? t.status.warm.base : t.fg.muted,
                    }}
                  >
                    {isPlaceholder ? '○ APPROXIMATE' : '● EXACT'}
                  </Small>
                </View>
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
                        : 'district centre'}
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
      </Row>

      {/* #14: the question is asked outright. Four rows, one per way a
          call-taker can know a location, each labelled with the exactness of
          its answer *before* it is chosen — so the district centre can never
          be tapped in the belief that it is a fix. */}
      <Stack gap={4}>
        <Label>How do you know the location?</Label>
        <SourceRow
          icon="keyboard"
          title="Caller gave coordinates"
          subtitle="Paste the AML fix or the numbers the caller read out"
          exact
          active={mode === 'coordinates'}
          onPress={() => setMode(mode === 'coordinates' ? 'none' : 'coordinates')}
        />
        <SourceRow
          icon="crosshair"
          title="Device location"
          subtitle={locating ? 'Reading this device’s position…' : 'Use this console’s own GPS — you are at the scene'}
          exact
          busy={locating}
          onPress={useDevice}
        />
        <SourceRow
          icon="pin"
          title="Drop a pin on the map"
          subtitle="The caller can describe the place; you place the point"
          exact
          active={mode === 'map'}
          onPress={() => setMode(mode === 'map' ? 'none' : 'map')}
        />
        <SourceRow
          icon="grid"
          title={`District centre — ${district?.name ?? 'the district'}`}
          subtitle="Only when nothing better exists. Dispatch will be ranked from headquarters, not the caller."
          exact={false}
          disabled={!district}
          onPress={useDistrictCentre}
        />
      </Stack>

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

      {problem ? <Banner tone="critical" icon="alert" title="Not accepted" body={problem} /> : null}

      {mode !== 'none' ? (
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
          <Row justify="space-between" align="center">
            <Label>{mode === 'map' ? 'Drop a pin where the caller is' : 'Coordinates from the call'}</Label>
            <Button label="Close" size="sm" variant="ghost" onPress={() => setMode('none')} />
          </Row>

          {mode === 'coordinates' ? (
            <Stack gap="xs">
              <Label>Latitude and longitude</Label>
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
              <Row gap="xs" wrap>
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
            </Stack>
          ) : null}

          {mode === 'map' ? (
          <Stack gap="xs">
            <Small muted style={{ fontSize: 11.5 }}>
              {/* #8: the instruction has to match the gesture. On the web build
                  a click places the pin; on a phone the map view reserves taps
                  for panning and marker selection, so placement is a long
                  press. Telling a phone operator to "tap" produced taps that
                  did nothing, which reads as a broken map. */}
              {Platform.OS === 'web'
                ? 'Tap the map where the caller is. Zoom in before tapping — at this scale a few pixels is a kilometre.'
                : 'Press and hold the map where the caller is. Zoom in first — at this scale a few pixels is a kilometre.'}
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
          ) : null}
        </View>
      ) : null}
    </Stack>
  );
}
