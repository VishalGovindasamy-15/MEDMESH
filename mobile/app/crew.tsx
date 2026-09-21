import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../src/api/client';
import type { CrewAssignment, ShortlistCandidate } from '../src/api/types';
import { MapSurface } from '../src/components/MapSurface';
import type { MapPoint } from '../src/components/mapTypes';
import { countdown, elapsed, STATUS_LABELS } from '../src/lib/format';
import { hasDirections, navigationUrl } from '../src/lib/maps';
import { useAuth } from '../src/state/AuthProvider';
import { useLive } from '../src/state/LiveProvider';
import { congestionStatus, useTheme } from '../src/theme/ThemeProvider';
import { radius, space, urgencyStatus } from '../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  Divider,
  EmptyState,
  Heading,
  Label,
  Loading,
  Meter,
  Num,
  Pill,
  Row,
  Small,
  Stack,
  Stat,
  Title,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';
import { useResponsive } from '../src/ui/useResponsive';

/**
 * Crew app.
 *
 * Design constraints taken from §6.7 of the architecture report and treated as
 * hard requirements rather than suggestions:
 *   - Large touch targets. The crew is stationary at a roadside, often in rain,
 *     often one-handed.
 *   - Minimum text. Anything that is not a number, a place or an action is
 *     secondary and gets demoted.
 *   - Offline tolerance. The assignment payload is cached to AsyncStorage on
 *     every successful load, so a dead zone shows the last known route and
 *     destination capacity rather than an empty screen.
 *   - One tap to re-route, because "the ICU just filled up" is a normal event.
 */

const CACHE_KEY = 'medmesh.crew.assignment';

// The driver's three progress reports. Ordered: index i can be claimed as soon
// as the case has reached stage i-1, so a crew that forgets a tap can still
// report the stage they are actually at.
const STAGES = [
  { key: 'en_route', label: 'En route to scene' },
  { key: 'arrived', label: 'Patient on board' },
  { key: 'handed_over', label: 'Confirm handover' },
];

export default function CrewScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { token, user } = useAuth();
  const { subscribe, connected, facilities } = useLive();
  const { isDesktop } = useResponsive();

  const [data, setData] = useState<CrewAssignment | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await api.get<CrewAssignment>('/crew/assignment', { token });
        setData(res);
        setOffline(false);
        setCachedAt(Date.now());
        setError(null);
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), payload: res }));
      } catch (err) {
        // Fall back to the last cached assignment rather than an error screen.
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const cached = await AsyncStorage.getItem(CACHE_KEY);
        if (cached) {
          const parsed = JSON.parse(cached);
          setData(parsed.payload);
          setCachedAt(parsed.at);
          setOffline(true);
        } else {
          setError(err instanceof ApiError ? err.message : 'Could not load your assignment');
        }
      } finally {
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 25_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const off = subscribe('*', (event) => {
      if (event.event.startsWith('incident.') || event.event.startsWith('capacity.')) load(true);
    });
    return off;
  }, [subscribe, load]);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const advance = async (status: string) => {
    if (!data?.assignment) return;
    setBusy(status);
    try {
      await api.post(`/incidents/${data.assignment.id}/status`, { status }, { token });
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update the trip');
    } finally {
      setBusy(null);
    }
  };

  const reroute = async (candidate: ShortlistCandidate) => {
    if (!data?.assignment) return;
    setBusy(`reroute:${candidate.hospital_id}`);
    try {
      await api.post(
        `/incidents/${data.assignment.id}/reroute`,
        { hospital_id: candidate.hospital_id, hold_resource: data.destination_capacity ? 'icu' : 'bed' },
        { token },
      );
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Re-route failed — call the console');
    } finally {
      setBusy(null);
    }
  };

  if (error && !data) {
    return (
      <AppShell title="Crew" subtitle={user?.full_name ?? ''}>
        <EmptyState
          icon="alert"
          title="Cannot reach dispatch"
          body={`${error}. If you are in a dead zone, the last assignment is stored locally — it will appear as soon as one has been cached.`}
          action={<Button label="Retry" icon="refresh" onPress={() => load()} />}
        />
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title="Crew" subtitle="Loading assignment">
        <Loading label="Fetching assignment…" />
      </AppShell>
    );
  }

  const assignment = data.assignment;
  const destination = data.destination;
  const stageIndex = assignment ? STAGES.findIndex((s) => s.key === assignment.status) : -1;
  const destLive = destination ? facilities[destination.id]?.capacity : null;
  const cap = destLive ?? data.destination_capacity;

  /**
   * The crew's destination as a map pin. The assignment payload carries a
   * location and a live capacity, which is exactly what a pin needs — the pin
   * colour is what tells a crew the receiving hospital still has the bed they
   * were promised.
   */
  const destinationPoint: MapPoint | null = destination
    ? {
        id: destination.id,
        short_name: destination.short_name,
        name: destination.name,
        lat: destination.lat,
        lng: destination.lng,
        capacity: cap,
      }
    : null;

  // Standing by -----------------------------------------------------------
  if (!assignment || !destination) {
    return (
      <AppShell
        title="Standing by"
        subtitle={data.ambulance ? `${data.ambulance.call_sign} · ${data.ambulance.capability_label}` : 'No vehicle linked'}
        maxWidth={720}
      >
        <Stack gap="lg">
          <Card style={{ gap: space.md }}>
            <Row justify="space-between" align="center">
              <Stack gap="xxs">
                <Heading>No active assignment</Heading>
                <Small muted>{data.message ?? 'Waiting for the next dispatch from the 108 console.'}</Small>
              </Stack>
              <Pill label={connected ? 'connected' : 'offline'} tone={connected ? 'live' : 'stale'} icon={connected ? 'wifi' : 'wifiOff'} compact />
            </Row>
            <Divider />
            {data.ambulance ? (
              <Stack gap="xxs">
                <Stat label="Vehicle" value={data.ambulance.call_sign} sub={data.ambulance.operator_name} />
              </Stack>
            ) : null}
            <Button label="Refresh" icon="refresh" onPress={() => load()} />
          </Card>
          <Button label="Open the public directory" icon="hospital" onPress={() => router.push('/')} />
        </Stack>
      </AppShell>
    );
  }

  const statusLabel = STATUS_LABELS[assignment.status] ?? assignment.status;

  return (
    <AppShell
      title={assignment.category_label}
      subtitle={`${assignment.reference} · ${statusLabel}`}
      maxWidth={900}
      actions={
        <Pill
          label={offline ? 'cached' : connected ? 'live' : 'offline'}
          tone={offline ? 'warm' : connected ? 'live' : 'stale'}
          icon={offline ? 'wifiOff' : 'wifi'}
          compact
        />
      }
      footerNote={
        hasDirections()
          ? 'Route geometry is resolved by Google Directions. Traffic-aware ETA to the receiving desk. Navigation opens in your own maps app.'
          : 'Route shown is an estimated corridor for situational awareness, not turn-by-turn navigation. Set EXPO_PUBLIC_GOOGLE_MAPS_API_KEY to resolve live road routes.'
      }
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
      >
        {offline ? (
          <Banner
            tone="warm"
            icon="wifiOff"
            title="Working from the last received assignment"
            body={`Cached ${cachedAt ? elapsed((Date.now() - cachedAt) / 1000) : '—'} ago. Reconnecting automatically. Capacity figures may be out of date — call the facility if the situation is time-critical.`}
          />
        ) : null}

        {error ? <Banner tone="critical" icon="alert" title="Action failed" body={error} /> : null}

        {/* Priority banner -------------------------------------------------- */}
        <Card
          tone={assignment.urgency === 'P1' ? 'critical' : 'warm'}
          style={{ gap: space.md }}
        >
          <Row justify="space-between" align="flex-start" gap="md" style={{ flexWrap: 'wrap' }}>
            <Stack gap="xs" style={{ flex: 1, minWidth: 220 }}>
              <Row gap="sm" align="center" wrap>
                <Pill label={assignment.urgency} tone={urgencyStatus(assignment.urgency)} compact />
                <Pill label={statusLabel} tone="info" compact />
                {assignment.requires.icu ? <Pill label="ICU needed" tone="critical" compact outline /> : null}
                {assignment.requires.ventilator ? <Pill label="Ventilator" tone="warm" compact outline /> : null}
                {assignment.requires.blood ? <Pill label="Blood" tone="info" compact outline /> : null}
              </Row>
              <Title style={{ fontSize: isDesktop ? 24 : 20 }}>
                {destination.short_name}
              </Title>
              <Small muted>{destination.address}</Small>
            </Stack>

            <Stack gap="xs" align="flex-end">
              <Num size={isDesktop ? 40 : 32} color={t.fg.strong}>
                {destination.eta_minutes}
              </Num>
              <Label style={{ fontSize: 10 }}>minutes to hospital</Label>
              <Num size={12.5} color={t.fg.muted}>
                {destination.distance_label}
              </Num>
            </Stack>
          </Row>

          <Row gap="md" align="center" style={{ flexWrap: 'wrap' }}>
            {/* The primary action on this screen. Google Maps turn-by-turn is a
                handoff, not an embed: a crew wants the app with the voice
                prompts, offline tiles and live traffic they already trust. */}
            <Button
              label="Navigate"
              icon="route"
              variant="primary"
              size="lg"
              onPress={() =>
                Linking.openURL(
                  navigationUrl(
                    { lat: destination.lat, lng: destination.lng },
                    destination.short_name,
                    data.route?.origin ?? (assignment.lat && assignment.lng
                      ? { lat: assignment.lat, lng: assignment.lng }
                      : null),
                  ),
                )
              }
            />
            <Button
              label={`Call ${destination.short_name}`}
              icon="phone"
              variant="secondary"
              size="lg"
              onPress={() => Linking.openURL(`tel:${destination.phone.replace(/[^\d+]/g, '')}`)}
            />
            <Button
              label="Handoff to hospital desk"
              icon="flag"
              size="lg"
              onPress={() => Linking.openURL('tel:108')}
            />
            <Small muted style={{ fontSize: 11.5, flex: 1, minWidth: 160 }}>
              {destination.traffic_note}
            </Small>
          </Row>
        </Card>

        {/* Route ----------------------------------------------------------- */}
        <MapSurface
          center={{ lat: destination.lat, lng: destination.lng }}
          zoom={11}
          points={destinationPoint ? [destinationPoint] : []}
          height={isDesktop ? 280 : 220}
          origin={data.route?.origin ?? { lat: assignment.lat, lng: assignment.lng }}
          originLabel={data.ambulance?.call_sign ?? 'Unit'}
          route={{
            from: data.route?.origin ?? { lat: assignment.lat, lng: assignment.lng },
            to: { lat: destination.lat, lng: destination.lng },
          }}
        />


        {/* Trip controls --------------------------------------------------- */}
        <Card style={{ gap: space.md }}>
          <Heading>Trip</Heading>
          <Row gap="sm" wrap>
            {STAGES.map((stage, i) => {
              const isNext = i === Math.min(stageIndex + 1, STAGES.length - 1) && stageIndex < STAGES.length - 1;
              return (
                <Button
                  key={stage.key}
                  label={stage.label}
                  size="lg"
                  /* The stage already reached is inert: pressing it again would
                     be a backwards move, and a driver should not have to reason
                     about which of three buttons is live. Exactly one button is
                     the accent-blue next step, so a driver mid-run can tap the
                     obvious thing without reading the rest. */
                  variant={isNext ? 'primary' : 'secondary'}
                  disabled={i <= stageIndex || busy !== null}
                  loading={busy === stage.key}
                  onPress={() => advance(stage.key)}
                  style={{ flexGrow: 1, minWidth: 150 }}
                />
              );
            })}
          </Row>
          <Small muted style={{ fontSize: 11.5 }}>
            Marking handover passes the case to the receiving ward and releases the reserved bed if one was held.
          </Small>
        </Card>

        {/* Destination capacity + alternatives ----------------------------- */}
        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          <Card style={{ flex: 1, minWidth: 280, gap: space.md }}>
            <Row justify="space-between" align="center">
              <Heading>What to expect on arrival</Heading>
              {cap ? (
                <Pill
                  label={`ED ${cap.ed_congestion}`}
                  tone={congestionStatus(cap.ed_congestion)}
                  compact
                />
              ) : null}
            </Row>

            {cap ? (
              <>
                <Row gap="xl" wrap>
                  <Stack gap="xs" style={{ flex: 1, minWidth: 88 }}>
                    <Label>Beds</Label>
                    <Num size={20} color={cap.beds_effective > 0 ? t.fg.strong : t.status.critical.base}>
                      {cap.beds_effective}
                    </Num>
                    <Meter value={cap.beds_effective} total={cap.total_beds} tone="live" height={3} />
                  </Stack>
                  <Stack gap="xs" style={{ flex: 1, minWidth: 88 }}>
                    <Label>ICU</Label>
                    <Num size={20} color={cap.icu_effective > 0 ? t.fg.strong : t.status.critical.base}>
                      {cap.icu_effective}
                    </Num>
                    <Meter value={cap.icu_effective} total={cap.total_icu} tone="info" height={3} />
                  </Stack>
                  <Stack gap="xs" style={{ flex: 1, minWidth: 88 }}>
                    <Label>Vents</Label>
                    <Num size={20} color={cap.vent_effective > 0 ? t.fg.strong : t.status.warm.base}>
                      {cap.vent_effective}
                    </Num>
                    <Meter value={cap.vent_effective} total={cap.total_ventilators} tone="warm" height={3} />
                  </Stack>
                </Row>
                <Divider />
                <Row gap="lg" wrap>
                  <Stack gap="xxs">
                    <Label style={{ fontSize: 9.5 }}>Waiting in ED</Label>
                    <Num size={14}>{cap.ed_waiting}</Num>
                  </Stack>
                  <Stack gap="xxs">
                    <Label style={{ fontSize: 9.5 }}>Blood units</Label>
                    <Num size={14}>{cap.blood_units}</Num>
                  </Stack>
                  <Stack gap="xxs">
                    <Label style={{ fontSize: 9.5 }}>Antivenom</Label>
                    <Num size={14}>{cap.antivenom_vials}</Num>
                  </Stack>
                  {cap.holds_active > 0 ? (
                    <Stack gap="xxs">
                      <Label style={{ fontSize: 9.5 }}>Held</Label>
                      <Num size={14} color={t.status.info.base}>
                        {cap.holds_active}
                      </Num>
                    </Stack>
                  ) : null}
                </Row>
                <Row gap="xs" wrap>
                  {Object.entries(destination.capabilities)
                    .filter(([, v]) => v)
                    .map(([k]) => (
                      <Pill key={k} label={k.replace(/_/g, ' ')} tone="neutral" compact outline />
                    ))}
                </Row>
              </>
            ) : (
              <Small muted>No live capacity for this facility. Call the desk before arrival.</Small>
            )}
          </Card>

          <Card style={{ flex: 1, minWidth: 280, gap: space.md }}>
            <Row justify="space-between" align="center">
              <Heading>If the destination changes</Heading>
              <Label>one tap</Label>
            </Row>
            <Small muted style={{ fontSize: 12 }}>
              Ranked live. Pressing re-route notifies the console and releases the bed held at the old facility.
            </Small>
            <Stack gap="sm">
              {(data.alternatives ?? []).map((alt) => (
                <View
                  key={alt.hospital_id}
                  style={{
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.line.base,
                    borderRadius: radius.md,
                    padding: space.md,
                    gap: space.sm,
                  }}
                >
                  <Row justify="space-between" align="flex-start" gap="sm">
                    <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                      <Body style={{ fontWeight: '600', fontSize: 13.5 }}>{alt.short_name}</Body>
                      <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
                        {alt.reasons.slice(0, 2).join(' · ') || alt.name}
                      </Small>
                    </Stack>
                    <Stack gap="xxs" align="flex-end">
                      <Num size={15}>{alt.eta_minutes}</Num>
                      <Label style={{ fontSize: 9 }}>min</Label>
                    </Stack>
                  </Row>
                  <Row justify="space-between" align="center" gap="sm">
                    <Num size={11.5} color={t.fg.muted}>
                      {alt.distance_label} · ICU {alt.capacity?.icu_effective ?? 0}
                    </Num>
                    <Button
                      label="Re-route"
                      size="sm"
                      icon="swap"
                      loading={busy === `reroute:${alt.hospital_id}`}
                      onPress={() => reroute(alt)}
                    />
                  </Row>
                </View>
              ))}
              {!data.alternatives?.length ? (
                <Small muted>No eligible alternative is currently available in range.</Small>
              ) : null}
            </Stack>
          </Card>
        </Row>
      </ScrollView>
    </AppShell>
  );
}
