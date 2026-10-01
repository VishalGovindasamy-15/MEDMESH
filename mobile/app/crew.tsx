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

/**
 * How often the vehicle reports its position during a live trip.
 *
 * Twenty seconds is the compromise: a unit at 60 km/h moves about 330 m in
 * that window, which is close enough to continuous for a district map, and the
 * GPS duty cycle stays low enough that a four-hour shift does not visibly
 * drain the handset. Faster buys precision nobody uses; slower starts to look
 * like a stall at a junction.
 */
const POSITION_INTERVAL_MS = 20_000;

/**
 * The crew's progress reports.
 *
 * This was three buttons, and the middle one was the bug the audit found: the
 * label read "Patient on board" while the status it sent was `arrived`, which
 * the backend defines as *the crew is at the scene, patient not yet loaded*.
 * Pressing it therefore told the platform the patient was in the vehicle when
 * the driver had only just parked — the ward's arrival countdown started
 * against the wrong event, and the analytics recorded a load time that never
 * happened.
 *
 * There are now five stages, one per thing that actually happens, and each sends
 * the status whose name matches its label:
 *
 *   Arrived at scene    -> at_scene         the crew is there, patient is not
 *   Patient loaded      -> patient_onboard  patient on the stretcher, still on scene
 *   Departed scene      -> transporting     vehicle moving, patient aboard
 *   Arrived at hospital -> at_hospital      at the receiving facility
 *   Handover complete   -> handed_over      clinical responsibility transferred
 *
 * The labels and the statuses come from the server (`GET /crew/assignment`
 * returns `next_actions`), so the app and the API cannot drift apart again. This
 * list is the offline fallback for when that payload is coming from the cache.
 */
const STAGES: { key: string; label: string; hint: string }[] = [
  // The first stage is the one the audit found missing. The header said
  // "Dispatched — accept the job" and the next button on offer was "Arrived at
  // scene", so a driver's only way forward was to skip acceptance entirely and
  // declare themselves on scene -- from the roadside, before turning a wheel.
  // The backend permitted DISPATCHED -> AT_SCENE, so nothing complained, and the
  // control room's arrival clock started against a journey that had not begun.
  { key: 'en_route', label: 'Accept & go', hint: 'You have accepted the job and are moving towards the scene.' },
  { key: 'at_scene', label: 'Arrived at scene', hint: 'You are on scene. The patient is not in the vehicle yet.' },
  { key: 'patient_onboard', label: 'Patient loaded', hint: 'Patient is on the stretcher and being treated.' },
  { key: 'transporting', label: 'Departed scene', hint: 'The vehicle is moving with the patient aboard.' },
  { key: 'at_hospital', label: 'Arrived at hospital', hint: 'You are at the receiving facility.' },
  { key: 'handed_over', label: 'Handover complete', hint: 'The ward has taken responsibility. This releases the bed.' },
];

/**
 * Which resource to reserve when a crew re-routes.
 *
 * Derived from what the patient needs, not from what the receiving hospital
 * happens to have free. The previous expression -- "if the destination has any
 * capacity, hold ICU" -- meant a hospital with an ICU count in its feed got an
 * ICU bed reserved for a sprained ankle, and the reservation is what removes
 * that bed from everyone else's shortlist until it expires. The driver is the
 * least informed person on the call about resource tier; the incident record is
 * the authority, and this reads it.
 */
function holdResourceFor(incident: { requires: { icu: boolean; ventilator: boolean } }): string {
  if (incident.requires.ventilator) return 'ventilator';
  if (incident.requires.icu) return 'icu';
  return 'bed';
}

/** Where the trip is, in the driver's words, for the header. */
const CREW_STAGE_LABELS: Record<string, string> = {
  dispatched: 'Dispatched — accept the job',
  en_route: 'En route to scene',
  at_scene: 'On scene',
  patient_onboard: 'Patient loaded, on scene',
  transporting: 'Transporting patient',
  at_hospital: 'At hospital, handing over',
  handed_over: 'Handed over',
  closed: 'Closed',
  cancelled: 'Stood down',
};

export default function CrewScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { token, user } = useAuth();
  const { subscribe, connected, facilities } = useLive();
  const { isDesktop } = useResponsive();

  const [data, setData] = useState<CrewAssignment | null>(null);
  const [cachedAt, setCachedAt] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  // Fifteen minutes is the point at which a ward's counters stop being a
  // picture and start being a guess: two admissions and a discharge are normal
  // in that window at a district hospital.
  const cacheAgeMs = cachedAt ? Date.now() - cachedAt : null;
  const stale = cacheAgeMs === null || cacheAgeMs > 15 * 60_000;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const [lastFixAt, setLastFixAt] = useState<number | null>(null);

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

  /**
   * Report the vehicle's position while a trip is live.
   *
   * `POST /crew/location` existed from the first week and no client ever called
   * it: the only thing that moved a vehicle on the dispatcher's map was the
   * position attached to a status press, which is four or five fixes across a
   * whole trip and none at all during the longest leg. A console watching a
   * unit sit still for twenty minutes on the way to a P1 has been given a
   * picture that is not merely stale but confidently wrong -- it looks like the
   * crew has stopped.
   *
   * Foreground-only, and only while an assignment is live. Continuous
   * background location would keep this working after the driver pockets the
   * phone, and was rejected as disproportionate for a pilot: it costs battery,
   * it needs the "always" permission tier, and a crew that distrusts the app
   * will defeat it. What this does cover is the driver who is looking at the
   * screen while they drive, which during a blue-light transfer is the whole
   * journey.
   *
   * Failures are swallowed on purpose. A dropped fix is not something to tell a
   * driver about mid-transport, and every other part of this screen already
   * degrades to the cached assignment.
   */
  useEffect(() => {
    if (!data?.assignment) return;
    let cancelled = false;

    const report = async () => {
      try {
        const Location = require('expo-location');
        const permission = await Location.getForegroundPermissionsAsync();
        if (!permission?.granted) return;
        const position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        if (cancelled || !position?.coords) return;
        await api.post(
          '/crew/location',
          { lat: position.coords.latitude, lng: position.coords.longitude },
          { token },
        );
        if (!cancelled) setLastFixAt(Date.now());
      } catch {
        /* no fix, no permission, or the module is absent in this build */
      }
    };

    void report();
    const id = setInterval(report, POSITION_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [data?.assignment?.id, token]);

  useEffect(() => {
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  /**
   * Advance the trip.
   *
   * Two things happen here that did not before.
   *
   * The crew's position travels with the report. This app never called
   * `POST /crew/location`, so the dispatcher's map showed every vehicle wherever
   * it happened to be when the trip began — a console watching an ambulance sit
   * motionless at the scene for forty minutes while it was actually on the road.
   * Asking for continuous background location was rejected as too invasive for a
   * pilot; attaching a fix to the five moments the driver already presses a
   * button gives an operational picture at the moments that matter, with no
   * permission prompt and no battery cost.
   *
   * The status is checked against the server's own `next_actions` before it is
   * sent, so a stale cached payload cannot produce a transition the lifecycle
   * will refuse. When it is refused anyway — a dispatcher re-routed the case in
   * the meantime — the server's 409 explains what is legal from here, and that
   * sentence is what the driver sees.
   */
  const advance = async (status: string) => {
    if (!data?.assignment) return;
    setBusy(status);

    let position: { lat: number; lng: number } | null = null;
    try {
      const Location = require('expo-location');
      const last = await Location.getLastKnownPositionAsync({ maxAge: 120_000 });
      if (last?.coords) {
        position = { lat: last.coords.latitude, lng: last.coords.longitude };
      }
    } catch {
      // No permission, no fix, or the module is absent in this build. The report
      // still goes; a status update without a position is useful, and a status
      // update refused because the GPS had not warmed up is not.
    }

    try {
      await api.post(
        `/incidents/${data.assignment.id}/status`,
        { status, lat: position?.lat ?? null, lng: position?.lng ?? null },
        { token },
      );
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
        { hospital_id: candidate.hospital_id, hold_resource: holdResourceFor(data.assignment) },
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
  // Where the trip sits on the spine. `arrived` is the deprecated spelling of
  // `at_scene`, so it is folded in rather than treated as an unknown stage.
  const effectiveStatus = assignment?.status === 'arrived' ? 'at_scene' : assignment?.status;
  const stageIndex = assignment ? STAGES.findIndex((s) => s.key === effectiveStatus) : -1;
  const nextStage = stageIndex >= 0 ? STAGES[stageIndex + 1] ?? null : null;
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
                <Heading>
                  {/*
                    "No assignment" and "this account has no vehicle" look the
                    same from the driver's seat and are completely different
                    problems. The second one never resolves on its own and needs
                    somebody else to act, so the screen says which it is and who
                    to contact, instead of leaving a driver to wait for a
                    dispatch that cannot arrive.
                  */}
                  {data.action_required ? 'No vehicle linked to this account' : 'No active assignment'}
                </Heading>
                <Small muted>
                  {data.message ?? 'Waiting for the next dispatch from the 108 console.'}
                </Small>
              </Stack>
              <Pill label={connected ? 'connected' : 'offline'} tone={connected ? 'live' : 'stale'} icon={connected ? 'wifi' : 'wifiOff'} compact />
            </Row>
            <Divider />
            {data.ambulance ? (
              <Stack gap="xxs">
                <Stat label="Vehicle" value={data.ambulance.call_sign} sub={data.ambulance.operator_name} />
              </Stack>
            ) : null}

            {data.action_required ? (
              <Banner
                tone="warm"
                icon="alert"
                title="A dispatcher has to fix this"
                body={data.action_required}
              />
            ) : null}

            <Row gap="xs" style={{ flexWrap: 'wrap' }}>
              <Button label="Refresh" icon="refresh" onPress={() => load()} />
              <Button
                label="Call 108 control"
                icon="phone"
                variant="secondary"
                onPress={() => Linking.openURL('tel:108')}
              />
            </Row>
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
        <Row gap="xs" align="center">
          {/* Position reporting is stated rather than assumed. A crew told to
              keep the app open for tracking needs to be able to see that it is
              actually happening, and a dispatcher asking "where are you" is a
              worse way to find out that it stopped. */}
          {data?.assignment ? (
            <Pill
              label={lastFixAt ? `GPS ${elapsed((Date.now() - lastFixAt) / 1000)}` : 'GPS —'}
              tone={lastFixAt && Date.now() - lastFixAt < 90_000 ? 'live' : 'stale'}
              icon="pin"
              compact
            />
          ) : null}
          <Pill
            label={offline ? 'cached' : connected ? 'live' : 'offline'}
            tone={offline ? 'warm' : connected ? 'live' : 'stale'}
            icon={offline ? 'wifiOff' : 'wifi'}
            compact
          />
        </Row>
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
        {/*
          Offline state, stated twice on purpose.

          The banner is the polite version. The second line is the one that
          matters clinically: a crew planning around "4 ICU beds" needs to know
          whether that number was taken four minutes or four hours ago, and
          burying it in a paragraph of grey text is how a stale figure gets used
          as a live one. So the age is rendered as a number, in the same visual
          weight as the capacity it qualifies.
        */}
        {offline ? (
          <Stack gap="xs">
            <Banner
              tone="warm"
              icon="wifiOff"
              title="Offline — no signal"
              body="Showing the last assignment we received. Reconnecting automatically."
            />
            {/* The age, as the largest thing under the banner rather than a
                clause in a sentence. A crew reads a number; "capacity and ETA
                from 15 min ago" in 11.5px grey is a number that gets skimmed,
                and the figure it qualifies -- ICU: 2 -- is 20px and coloured.
                The two have to be the same size or the smaller one loses. */}
            <Card tone={stale ? 'critical' : 'warm'} style={{ gap: space.xs }}>
              <Row justify="space-between" align="baseline" gap="sm" style={{ flexWrap: 'wrap' }}>
                <Stack gap={2} style={{ minWidth: 180 }}>
                  <Label style={{ fontSize: 10 }}>Capacity last confirmed</Label>
                  <Num size={isDesktop ? 22 : 19} weight="700" color={stale ? t.status.critical.base : t.fg.strong}>
                    {cachedAt ? `${elapsed((Date.now() - cachedAt) / 1000)} ago` : 'unknown'}
                  </Num>
                </Stack>
                {cachedAt ? <Pill tone={stale ? 'critical' : 'warm'} icon="clock" compact label="not live" /> : null}
              </Row>
              {stale ? (
                <Body style={{ fontSize: 12, color: t.status.critical.base }}>
                  Old enough to be wrong. Call the receiving desk before relying on availability — the ICU count may
                  already be zero.
                </Body>
              ) : (
                <Small muted style={{ fontSize: 12 }}>
                  Call the receiving desk before relying on availability if the situation is time-critical.
                </Small>
              )}
            </Card>
          </Stack>
        ) : null}

        {error ? <Banner tone="critical" icon="alert" title="Action failed" body={error} /> : null}

        {/* What the trip is doing, at the size of a headline.
            The stage buttons below are the only control, and before this band
            the current stage was a small pill in a header among four others. A
            driver picking the phone up at a junction needs one thing from this
            screen -- where am I in this job -- and it should not require
            reading. */}
        <Card
          tone={
            effectiveStatus === 'dispatched'
              ? 'critical'
              : effectiveStatus === 'handed_over' || effectiveStatus === 'closed' || effectiveStatus === 'cancelled'
                ? 'live'
                : 'info'
          }
          style={{ gap: space.xs }}
        >
          <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
            <Stack gap={2} style={{ minWidth: 200 }}>
              <Label style={{ fontSize: 10 }}>This job</Label>
              <Title style={{ fontSize: isDesktop ? 26 : 22 }}>
                {CREW_STAGE_LABELS[effectiveStatus ?? ''] ?? 'Loading'}
              </Title>
            </Stack>
            <Stack gap={2} align="flex-end">
              <Label style={{ fontSize: 10 }}>Next step</Label>
              <Num size={isDesktop ? 17 : 15} weight="700" color={t.fg.strong}>
                {nextStage?.label ?? 'Nothing further'}
              </Num>
            </Stack>
          </Row>
        </Card>

        {/* A call taken without a handset location is plotted at the district
            centre. The crew still has to be told, because the map on this
            screen then points at a town hall twelve kilometres from the patient
            and the first thing they will do at that pin is look for someone. */}
        {assignment.location_approximate ? (
          <Banner
            tone="warm"
            icon="pin"
            title="Pickup point is approximate"
            body={
              'The caller gave no location, so the scene is plotted at the district centre' +
              (assignment.taluk ? ` near ${assignment.taluk}` : '') +
              '. Confirm the address with the control room before you commit to the pin.'
            }
          />
        ) : null}

        {assignment.destination_withdrawn && !destination ? (
          <Banner
            tone="critical"
            icon="alert"
            title="Receiving facility withdrew"
            body="The destination you were sent to has declined this patient and its bed holds are released. Hold position if clinically safe and take a new destination from the control room."
          />
        ) : null}

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
              label="Open Google Maps"
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
            {/*
              This button said "Handoff to hospital desk" and dialled 108 — the
              emergency control room — so a crew calling to announce their
              arrival reached dispatch instead of the ward that was waiting for
              them, and dispatch had to relay it. It now dials the receiving
              facility, and the control room has its own button next to it,
              labelled as such.
            */}
            <Button
              label="Call the receiving desk"
              icon="phone"
              size="lg"
              variant="secondary"
              onPress={() => Linking.openURL(`tel:${destination.phone.replace(/[^\d+]/g, '')}`)}
            />
            <Button
              label="Call 108 control"
              icon="flag"
              size="lg"
              onPress={() => Linking.openURL('tel:108')}
            />
            <Small muted style={{ fontSize: 11.5, flex: 1, minWidth: 160 }}>
              {destination.traffic_note}
            </Small>
          </Row>
        </Card>

        {/* Route -----------------------------------------------------------
            A picture, not a navigator. The corridor shows where the patient is
            going and roughly which way; the turn-by-turn the crew actually
            follows lives in their own navigation app, and the button below is
            labelled as the handoff to it rather than as "Navigate", which would
            promise something this screen does not do. */}
        <Stack gap="xs">
          <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
            <Label>Route overview · not turn-by-turn</Label>
            <Small muted style={{ fontSize: 11 }}>
              Turn-by-turn runs in Google Maps — open it from the button below.
            </Small>
          </Row>
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
        </Stack>


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
            <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
              <Heading>What to expect on arrival</Heading>
              <Row gap="xs" align="center">
                {/* The counters below are 20px and coloured, so they read as
                    current whatever the header says. While the screen is
                    showing a cached payload they are labelled where they are
                    read, not only in the banner at the top of the page. */}
                {offline ? <Pill label="not live" tone="warm" icon="wifiOff" compact outline /> : null}
                {cap ? (
                  <Pill
                    label={`ED ${cap.ed_congestion}`}
                    tone={congestionStatus(cap.ed_congestion)}
                    compact
                  />
                ) : null}
              </Row>
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
