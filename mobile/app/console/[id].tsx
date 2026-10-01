import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../../src/api/client';
import type { Ambulance, Incident, RoutingSummary, ShortlistCandidate } from '../../src/api/types';
import { MapSurface } from '../../src/components/MapSurface';
import type { MapPoint } from '../../src/components/mapTypes';
import { ageFromSeconds, categoryLabel, clockTime, countdown, elapsed, relativeFromIso, STATUS_LABELS } from '../../src/lib/format';
import { straightKm, straightMinutes } from '../../src/lib/geo';
import { navigationUrl } from '../../src/lib/maps';
import { useAuth } from '../../src/state/AuthProvider';
import { useLive } from '../../src/state/LiveProvider';
import { freshnessStatus, useTheme } from '../../src/theme/ThemeProvider';
import { radius, space, urgencyStatus } from '../../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  ConfirmDialog,
  Divider,
  EmptyState,
  Heading,
  KeyValue,
  Label,
  Loading,
  Meter,
  Num,
  Pill,
  Row,
  SectionHeader,
  Segmented,
  Small,
  Stack,
  Title,
  TrustChip,
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';
import { AppShell } from '../../src/ui/Shell';
import { useResponsive } from '../../src/ui/useResponsive';

/**
 * Incident workspace.
 *
 * Layout follows the order the operator actually works in: what is this call →
 * who can take it → commit → watch it through. The engine's reasoning is shown
 * in full, including why a facility was *rejected*, because an operator who
 * cannot see the reasoning will simply pick the nearest hospital — which is the
 * behaviour this platform exists to replace.
 */
export default function IncidentWorkspace() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const incidentId = Number(id);
  const { t } = useTheme();
  const router = useRouter();
  const { token } = useAuth();
  const { subscribe } = useLive();
  const { isDesktop } = useResponsive();

  const [incident, setIncident] = useState<Incident | null>(null);
  const [shortlist, setShortlist] = useState<ShortlistCandidate[]>([]);
  // How the distances behind the ranking were resolved. Shown to the operator
  // rather than kept internal: the ranking is only as trustworthy as its
  // least trustworthy input, and that is worth knowing before committing.
  const [routing, setRouting] = useState<RoutingSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<{ candidate: ShortlistCandidate; blockers: string[] } | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [holdResource, setHoldResource] = useState<'icu' | 'bed' | 'ventilator' | 'none'>('none');
  const [showRejected, setShowRejected] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  // Crew selection. Null means "the engine picks", which stays the default:
  // the capability-aware assignment is better at this than a person reading a
  // list under time pressure, and an operator who wants a specific unit is
  // usually overriding for a reason the engine cannot see (a crew already at
  // the scene, a unit the caller's family asked for).
  const [crew, setCrew] = useState<{ available: number; results: Ambulance[] } | null>(null);
  const [crewChoice, setCrewChoice] = useState<number | null>(null);
  const [crewPick, setCrewPick] = useState(false);
  // The dispatch confirmation and the override justification are separate
  // steps because they answer different questions, and collapsing them is how
  // "are you sure?" dialogs become something people dismiss without reading.
  const [pending, setPending] = useState<
    { kind: 'commit' | 'override'; candidate: ShortlistCandidate; reason?: string; blockers?: string[] } | null
  >(null);
  const [crewProblem, setCrewProblem] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const [inc, list, fleet] = await Promise.all([
          api.get<Incident>(`/incidents/${incidentId}`, { token }),
          api.get<{ results: ShortlistCandidate[]; routing?: RoutingSummary }>(
            `/incidents/${incidentId}/shortlist?limit=12`,
            { token },
          ),
          // The units this operator may commit. Fetched with the shortlist so
          // the crew panel is populated on the same render as the facilities --
          // an operator who has to open a picker that then loads has lost the
          // thread of the call.
          api.get<{ results: Ambulance[]; available: number }>(`/ambulances`, { token }),
        ]);
        setIncident(inc);
        setShortlist(list.results);
        setRouting(list.routing ?? null);
        setCrew({ available: fleet.available, results: fleet.results });
        setSelected((prev) => prev ?? list.results.find((c) => c.eligible)?.hospital_id ?? null);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load this incident');
      } finally {
        setRefreshing(false);
      }
    },
    [incidentId, token],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const off = subscribe('*', (event) => {
      if (event.event.startsWith('incident.') || event.event.startsWith('capacity.') || event.event.startsWith('hold.')) {
        load(true);
      }
    });
    return off;
  }, [subscribe, load]);

  // Re-ranks every 20 s. Capacity moves underneath a shortlist and an operator
  // can sit on a screen for several minutes while a call is still live.
  useEffect(() => {
    const id = setInterval(() => {
      setTick((v) => v + 1);
      load(true);
    }, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const eligible = useMemo(() => shortlist.filter((c) => c.eligible), [shortlist]);
  const rejected = useMemo(() => shortlist.filter((c) => !c.eligible), [shortlist]);
  const chosen = useMemo(() => shortlist.find((c) => c.hospital_id === selected) ?? null, [shortlist, selected]);

  /**
   * Units worth showing this operator, best first.
   *
   * Ordered by the same preference the dispatch engine walks: a unit carrying a
   * capability this incident asks for comes before one that does not, a crewed
   * unit before an empty vehicle, and distance from the scene last. The list is
   * advisory -- the server re-validates whatever is committed and returns its
   * blockers, which is where the authoritative answer lives.
   */
  const crewOptions = useMemo(() => {
    const wanted: string[] = incident?.requires.ambulance ?? [];
    const scene = { lat: incident?.lat ?? 0, lng: incident?.lng ?? 0 };
    return (crew?.results ?? [])
      .map((unit) => {
        const caps = unit.capabilities?.length ? unit.capabilities : [unit.capability];
        const wantedIndex = wanted.findIndex((w) => caps.includes(w));
        return {
          unit,
          caps,
          wants: wantedIndex === 0,
          capability_rank: wantedIndex === -1 ? wanted.length : wantedIndex,
          km: straightKm({ lat: unit.lat, lng: unit.lng }, scene),
          crewed: unit.driver_user_id != null,
          free: unit.status === 'available',
        };
      })
      .sort(
        (a, b) =>
          a.capability_rank - b.capability_rank ||
          Number(b.free) - Number(a.free) ||
          Number(b.crewed) - Number(a.crewed) ||
          a.km - b.km,
      );
  }, [crew, incident]);

  const crewUnit = useMemo(
    () => crewOptions.find((o) => o.unit.id === crewChoice) ?? null,
    [crewOptions, crewChoice],
  );

  const crewFree = crewOptions.filter((o) => o.free).length;
  const crewCommitted = (crew?.results.length ?? 0) - crewFree;

  /**
   * The shortlist rendered as map markers.
   *
   * The console's map has to answer one question — "which of these can I still
   * route to?" — so it shows the whole ranked list with the same capacity colours
   * the citizen portal uses, not just the single chosen facility. An operator
   * who has to scroll back up to compare two hospitals has already lost the
   * thread of the call.
   */
  const shortlistPoints = useMemo<MapPoint[]>(
    () =>
      shortlist.map((c) => ({
        id: c.hospital_id,
        short_name: c.short_name,
        name: c.name,
        lat: c.lat,
        lng: c.lng,
        // An ineligible candidate is drawn as "no live data" rather than with its
        // capacity figures: the engine has already ruled it out, and colouring it
        // green would invite the operator to override for a bad reason.
        capacity: c.eligible ? c.capacity : null,
      })),
    [shortlist],
  );

  const dispatchTo = async (candidate: ShortlistCandidate, overrideReason?: string) => {
    setBusy('dispatch');
    setBlocked(null);
    setCrewProblem(null);
    try {
      await api.post(
        `/incidents/${incidentId}/dispatch`,
        {
          hospital_id: candidate.hospital_id,
          // The crew choice belongs to the commit. A re-route moves the
          // destination only; the server refuses a crew id here rather than
          // pretending to re-crew a moving vehicle.
          ambulance_id: isDispatched ? undefined : crewChoice,
          hold_resource: holdResource === 'none' ? null : holdResource,
          hold_seconds: 900,
          override_reason: overrideReason ?? null,
        },
        { token },
      );
      setPending(null);
      setCrewPick(false);
      await load(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const detail: any = err.detail;
        if (detail && typeof detail === 'object' && Array.isArray(detail.blockers) && detail.blockers.length) {
          // Either the facility or the chosen unit. Both are overridable, and
          // both now require a typed reason rather than a tap.
          setPending({ kind: 'override', candidate, blockers: detail.blockers });
          setBlocked({ candidate, blockers: detail.blockers });
          setShowRejected(true);
        } else if (detail && typeof detail === 'object' && detail.override) {
          // A re-route onto a facility that already declined this patient: the
          // server refuses with a message and an override instruction but no
          // blockers array. Same contract, same dialog — a refusal that names
          // an override path has to lead to it, not to an error banner.
          const blockers = [detail.message ?? 'This facility has already declined'];
          setPending({ kind: 'override', candidate, blockers });
          setBlocked({ candidate, blockers });
          setShowRejected(true);
        } else if (typeof detail === 'string' && /ambulance/i.test(detail)) {
          // #31: the old code printed the engine's line verbatim and left it on
          // screen, so an operator who had just released a unit still read "no
          // ambulance available". The fleet is re-read and the message is
          // rebuilt from it, with the picker opened beside it.
          setCrewProblem(detail);
          setCrewPick(true);
          setPending(null);
          await load(true);
        } else {
          setPending(null);
          setError(err.message);
        }
      } else {
        setError(err instanceof ApiError ? err.message : 'Dispatch failed');
      }
    } finally {
      setBusy(null);
    }
  };

  const reroute = async (candidate: ShortlistCandidate) => {
    setBusy('reroute');
    try {
      await api.post(
        `/incidents/${incidentId}/reroute`,
        { hospital_id: candidate.hospital_id, hold_resource: holdResource === 'none' ? null : holdResource },
        { token },
      );
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Re-route failed');
    } finally {
      setBusy(null);
    }
  };

  /**
   * Commit after the operator has confirmed.
   *
   * One handler for both paths: an ordinary commit and an override are the same
   * call with different justifications, and the only difference here is whether
   * the reason the dialog collected travels with it. An override with no reason
   * cannot arrive -- the dialog will not confirm without one -- so the server's
   * audit entry can never be the bare word "override".
   */
  const confirmPending = async (reason?: string) => {
    if (!pending) return;
    const candidate = pending.candidate;
    setPending(null);
    if (isDispatched) {
      await reroute(candidate);
    } else {
      await dispatchTo(candidate, reason);
    }
  };

  const setStatus = async (status: string) => {
    setBusy(`status:${status}`);
    try {
      await api.post(`/incidents/${incidentId}/status`, { status }, { token });
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Status update failed');
    } finally {
      setBusy(null);
    }
  };

  if (error && !incident) {
    return (
      <AppShell title="Incident" subtitle="Unavailable">
        <EmptyState
          icon="alert"
          title="This incident could not be loaded"
          body={error}
          action={<Button label="Back to console" icon="chevronLeft" onPress={() => router.push('/console')} />}
        />
      </AppShell>
    );
  }

  if (!incident) {
    return (
      <AppShell title="Incident" subtitle="Loading">
        <Loading label="Loading incident workspace…" />
      </AppShell>
    );
  }

  // The trip is "committed" from dispatch until the patient is handed over or
  // the call ends. This list was left at the three states the old model had, so
  // once the lifecycle gained AT_SCENE / PATIENT_ONBOARD / TRANSPORTING /
  // AT_HOSPITAL the destination panel and the holds simply stopped rendering
  // partway through every journey -- the console lost sight of a case exactly
  // when it was most in motion.
  const isDispatched = [
    'dispatched',
    'en_route',
    'at_scene',
    'patient_onboard',
    'transporting',
    'at_hospital',
    'arrived',
  ].includes(incident.status);
  const isFinished = ['handed_over', 'closed', 'cancelled'].includes(incident.status);
  const elapsedNow = incident.elapsed_seconds + tick * 20;

  return (
    <AppShell
      title={incident.category_label}
      subtitle={`${incident.reference} · ${incident.district_name ?? ''} · raised ${clockTime(incident.created_at)}`}
      maxWidth={1440}
      actions={
        <Row gap="xs">
          <Button label="Queue" icon="chevronLeft" size="sm" onPress={() => router.push('/console')} />
          <Button label="Re-run match" icon="refresh" size="sm" onPress={() => load()} />
        </Row>
      }
      footerNote="Matching is re-evaluated every 20 seconds while this screen is open. A facility that filled up after the shortlist was generated will be blocked at dispatch time."
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
      >
        {error ? <Banner tone="critical" icon="alert" title="Action failed" body={error} /> : null}

        {/* The scene coordinate, and whether it can be trusted. A district-centre
            fallback is a legitimate answer to a call from a landline -- but the
            dispatcher is choosing a facility by drive time *from this point*,
            and the crew is driving to it, so the approximation has to be stated
            rather than buried in a coordinate that looks precise. */}
        {incident.location_approximate ? (
          <Banner
            tone="warm"
            icon="pin"
            title="Scene location is approximate"
            body={
              'Only the district centre is recorded for this call' +
              (incident.taluk ? ` (${incident.taluk})` : '') +
              '. Drive times are measured from there, so confirm the address with the caller before committing a unit.'
            }
          />
        ) : null}

        {incident.destination_withdrawn && !incident.assigned_hospital ? (
          <Banner
            tone="critical"
            icon="alert"
            title="Destination withdrawn — re-route needed"
            body={
              `${
                incident.declined_hospital_ids.length > 1
                  ? `${incident.declined_hospital_ids.length} facilities have`
                  : 'The receiving facility has'
              } declined this patient${
                incident.facility_decline_reason
                  ? ` (${incident.facility_decline_reason.replace(/_/g, ' ')})`
                  : ''
              }. The holds are released and the crew is still driving — pick a facility from the fresh shortlist below.`
            }
          />
        ) : null}

        {blocked ? (
          <Banner
            tone="critical"
            icon="alert"
            title={`${blocked.candidate.short_name} can no longer take this patient`}
            body={`${blocked.blockers.join('; ')}. Pick an alternative below, or dispatch anyway if you have confirmed by phone.`}
          />
        ) : null}

        {/* Call summary ------------------------------------------------ */}
        <Card style={{ gap: space.md }}>
          <Row justify="space-between" align="flex-start" gap="md" style={{ flexWrap: 'wrap' }}>
            <Stack gap="xs" style={{ flex: 1, minWidth: 240 }}>
              <Row gap="sm" align="center" wrap>
                <Pill label={incident.urgency} tone={urgencyStatus(incident.urgency)} compact />
                <Pill label={STATUS_LABELS[incident.status] ?? incident.status} tone={isFinished ? 'neutral' : 'info'} compact />
                {isFinished ? null : (
                  <Num size={13} color={t.status.critical.base}>
                    {elapsed(elapsedNow)}
                  </Num>
                )}
              </Row>
              <Title>{incident.landmark}</Title>
              <ScenePanel scene={incident.scene} />
            </Stack>

            <Row gap="lg" wrap>
              <NeedFlag label="ICU" on={incident.requires.icu} />
              <NeedFlag label="Ventilator" on={incident.requires.ventilator} />
              <NeedFlag label="Blood" on={incident.requires.blood} />
            </Row>
          </Row>

          {isDispatched && incident.assigned_hospital ? (
            <>
              <Divider />
              <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
                <Stack gap="xs" style={{ flex: 1, minWidth: 220 }}>
                  <Label>Committed destination</Label>
                  <Row gap="sm" align="center">
                    <Icon name="hospital" size={16} color={t.accent.base} />
                    <Body style={{ fontWeight: '600' }}>{incident.assigned_hospital.short_name}</Body>
                  </Row>
                  <Small muted>{incident.assigned_hospital.address}</Small>
                  <Row gap="md" wrap style={{ marginTop: 2 }}>
                    <Num size={12.5} color={t.fg.muted}>
                      {incident.assigned_hospital.phone}
                    </Num>
                    <Row gap="xs" align="center">
                      <Icon name="ambulance" size={13} color={t.fg.muted} />
                      <Num size={12.5} color={t.fg.muted}>
                        {incident.assigned_ambulance?.call_sign ?? '—'}
                      </Num>
                    </Row>
                  </Row>
                </Stack>

                {incident.active_holds.length ? (
                  <Stack gap="xs" style={{ minWidth: 180 }}>
                    <Label>Active holds</Label>
                    {incident.active_holds.map((h) => (
                      <Row key={h.id} gap="sm" align="center">
                        <Pill label={h.resource} tone="info" compact icon="lock" />
                        <Num size={13} color={t.status.info.base}>
                          {countdown(Math.max(0, h.seconds_remaining - tick * 20))}
                        </Num>
                        <Small muted style={{ fontSize: 11 }}>
                          remaining
                        </Small>
                      </Row>
                    ))}
                  </Stack>
                ) : null}

                <Stack gap="xs" style={{ minWidth: 240 }}>
                  <Label>Advance status</Label>
                  <Row gap="xs" wrap>
                    {[
                      // The control room's shortcut row: one button per stage it
                      // would ever set on a crew's behalf. The full ladder is
                      // the crew's job; these are for reading a stage out loud
                      // on a phone call.
                      { key: 'en_route', label: 'En route' },
                      { key: 'at_scene', label: 'At scene' },
                      { key: 'patient_onboard', label: 'On board' },
                      { key: 'transporting', label: 'Transporting' },
                      { key: 'at_hospital', label: 'At hospital' },
                      { key: 'handed_over', label: 'Handed over' },
                    ].map((s) => (
                      <Button
                        key={s.key}
                        label={s.label}
                        size="sm"
                        variant={s.key === 'handed_over' ? 'tone' : 'secondary'}
                        tone={s.key === 'handed_over' ? 'live' : undefined}
                        loading={busy === `status:${s.key}`}
                        onPress={() => setStatus(s.key)}
                      />
                    ))}
                    <Button
                      label="Cancel call"
                      size="sm"
                      variant="ghost"
                      loading={busy === 'status:cancelled'}
                      onPress={() => setStatus('cancelled')}
                    />
                  </Row>
                  <Small muted style={{ fontSize: 11 }}>
                    Handover consumes the bed hold. Cancelling releases it back to the public pool immediately.
                  </Small>
                </Stack>
              </Row>

              {incident.assigned_ambulance && incident.assigned_hospital ? (
                <>
                  <MapSurface
                    points={shortlistPoints}
                    center={{
                      lat: incident.assigned_hospital.lat,
                      lng: incident.assigned_hospital.lng,
                    }}
                    zoom={11}
                    height={isDesktop ? 240 : 190}
                    selectedId={incident.assigned_hospital.id}
                    origin={{
                      lat: incident.assigned_ambulance.lat,
                      lng: incident.assigned_ambulance.lng,
                    }}
                    originLabel={incident.assigned_ambulance.call_sign}
                    route={{
                      from: {
                        lat: incident.assigned_ambulance.lat,
                        lng: incident.assigned_ambulance.lng,
                      },
                      to: {
                        lat: incident.assigned_hospital.lat,
                        lng: incident.assigned_hospital.lng,
                      },
                    }}
                  />
                  <Row gap={space.md} wrap align="center">
                    <Button
                      label="Navigate"
                      size="sm"
                      variant="ghost"
                      icon="route"
                      onPress={() =>
                        Linking.openURL(
                          navigationUrl(
                            { lat: incident.assigned_hospital!.lat, lng: incident.assigned_hospital!.lng },
                            incident.assigned_hospital!.short_name,
                            incident.assigned_ambulance
                              ? {
                                  lat: incident.assigned_ambulance.lat,
                                  lng: incident.assigned_ambulance.lng,
                                }
                              : null,
                          ),
                        )
                      }
                    />
                    <Small muted>
                      Opens the destination in the crew&apos;s own navigation app.
                    </Small>
                  </Row>
                </>
              ) : null}
            </>
          ) : null}
        </Card>

        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          {/* Shortlist -------------------------------------------------- */}
          <Stack gap="md" style={{ flex: 2, minWidth: isDesktop ? 500 : '100%' }}>
            <Row justify="space-between" align="center" gap="md" style={{ flexWrap: 'wrap' }}>
              <SectionHeader label={`Ranked shortlist — ${eligible.length} eligible`} />
              <Segmented
                options={[
                  { value: 'eligible', label: 'Eligible', count: eligible.length },
                  { value: 'all', label: 'Incl. rejected', count: rejected.length },
                ]}
                value={showRejected ? 'all' : 'eligible'}
                onChange={(v) => setShowRejected(v === 'all')}
                size="sm"
              />
            </Row>

            {/* How this ranking was computed.
                The engine scores proximity on road drive time, resolved before
                anything is ranked, so the order and the map never disagree. When
                the router is unavailable the engine falls back to straight-line
                geometry and says so here -- a dispatcher is entitled to know
                whether the minutes in front of them came off a road network or
                out of a winding factor, because the two diverge most in exactly
                the hilly and river-cut terrain where the choice is hardest. */}
            {routing ? (
              <Row gap="sm" align="center" wrap>
                <Icon
                  name={routing.road_derived ? 'route' : 'alert'}
                  size={12}
                  color={routing.road_derived ? t.fg.faint : t.status.warm.base}
                />
                <Small muted style={{ fontSize: 11 }}>
                  {routing.road_derived
                    ? `Ranked on road drive time · ${routing.routed} of ${routing.total} facilities routed${
                        routing.traffic_aware ? ` · ${routing.traffic_aware} with live traffic` : ''
                      } within a ${Math.round(routing.prefilter_km)} km straight-line prefilter`
                    : `Ranked on straight-line estimates · no road routing configured (${routing.total} facilities)`}
                </Small>
              </Row>
            ) : null}

            {eligible.length === 0 && !isDispatched ? (
              <Banner
                tone="critical"
                icon="alert"
                title="No facility currently meets this patient's needs"
                body="Every facility in range either lacks the required capability or has no free capacity. Options: broaden the requirements, request mutual aid from a neighbouring district, or escalate to the district control room."
              />
            ) : null}

            <Stack gap="sm">
              {(showRejected ? shortlist : eligible).map((candidate, index) => (
                <CandidateRow
                  key={candidate.hospital_id}
                  candidate={candidate}
                  rank={index + 1}
                  selected={selected === candidate.hospital_id}
                  onSelect={() => setSelected(candidate.hospital_id)}
                  disabled={isFinished}
                />
              ))}
            </Stack>

            {rejected.length > 0 && !showRejected ? (
              <Button
                label={`Show ${rejected.length} facilities excluded by the engine`}
                icon="filter"
                size="sm"
                onPress={() => setShowRejected(true)}
              />
            ) : null}
          </Stack>

          {/* Commit panel ---------------------------------------------- */}
          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 340 : '100%' }}>
            <Card style={{ gap: space.md }}>
              <Heading>{isDispatched ? 'Re-route' : 'Commit the placement'}</Heading>

              {chosen ? (
                <>
                  <Stack gap="xs">
                    <Row justify="space-between" align="center">
                      <Label>Selected</Label>
                      <TrustChip score={chosen.trust?.score} />
                    </Row>
                    <Row gap="sm" align="center">
                      <Icon name="hospital" size={15} color={t.accent.base} />
                      <Body style={{ fontWeight: '600' }}>{chosen.short_name}</Body>
                    </Row>
                    <Small muted>{chosen.address}</Small>
                    <Row gap="md">
                      <Num size={12.5} color={t.fg.muted}>
                        {chosen.distance_label}
                      </Num>
                      <Num size={12.5} color={t.fg.muted}>
                        score {chosen.score}
                      </Num>
                    </Row>
                  </Stack>

                  <Stack gap="xs">
                    <Label>Reserve on dispatch</Label>
                    <Segmented
                      options={[
                        { value: 'none', label: 'No hold' },
                        { value: 'icu', label: 'ICU' },
                        { value: 'bed', label: 'Bed' },
                        { value: 'ventilator', label: 'Vent' },
                      ]}
                      value={holdResource}
                      onChange={setHoldResource}
                      size="sm"
                      scroll
                    />
                    <Small muted style={{ fontSize: 11 }}>
                      A 15-minute hold prevents two crews converging on the same bed. It is deducted from the public
                      figure immediately.
                    </Small>
                  </Stack>

                  {/* Crew --------------------------------------------------
                      The engine is the default and the recommendation, but the
                      operator is the one on the phone: a crew already at the
                      scene, a unit the family knows, a vehicle the control room
                      wants held back. Choosing a unit by hand is a supported
                      decision rather than a hidden one, so it is a first-class
                      panel with the unit's capability, crew and position shown
                      before anything is committed. */}
                  <Stack gap="xs">
                    <Row justify="space-between" align="center" gap="sm">
                      <Label>Crew</Label>
                      <Small muted style={{ fontSize: 11 }}>
                        {crewFree} free of {crew?.results.length ?? 0}
                      </Small>
                    </Row>

                    {crewUnit ? (
                      <Row gap="sm" align="center">
                        <Icon name="ambulance" size={14} color={t.accent.base} />
                        <Body style={{ fontWeight: '600', fontSize: 13 }}>{crewUnit.unit.call_sign}</Body>
                        <Pill label={crewUnit.unit.capability_label} tone="info" compact />
                      </Row>
                    ) : (
                      <Row gap="sm" align="center">
                        <Icon name="route" size={14} color={t.fg.muted} />
                        <Body muted style={{ fontSize: 13 }}>
                          Engine picks the nearest capable unit
                        </Body>
                      </Row>
                    )}

                    {incident.requires.ambulance_labels?.length ? (
                      <Small muted style={{ fontSize: 11 }}>
                        This call wants {incident.requires.ambulance_labels[0].toLowerCase()}
                        {incident.requires.ambulance_labels.length > 1
                          ? `, then ${incident.requires.ambulance_labels.slice(1).join(' or ').toLowerCase()}`
                          : ''}
                        .
                      </Small>
                    ) : null}

                    {/* The preview. #30: the operator saw a call sign in a menu
                        and committed a vehicle sight unseen -- no capability, no
                        crew, no idea whether the position the ETA was measured
                        from was thirty seconds or forty minutes old. */}
                    {crewUnit ? (
                      <View
                        style={{
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: t.line.base,
                          borderRadius: radius.md,
                          backgroundColor: t.bg.sunken,
                          padding: space.sm,
                          gap: 4,
                        }}
                      >
                        <Row justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11 }}>Registration</Small>
                          <Num size={11.5}>{crewUnit.unit.registration}</Num>
                        </Row>
                        <Row justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11 }}>Operator</Small>
                          <Small style={{ fontSize: 11.5 }} numberOfLines={1}>
                            {crewUnit.unit.operator_name}
                          </Small>
                        </Row>
                        <Row justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11 }}>Capability</Small>
                          <Small style={{ fontSize: 11.5 }} numberOfLines={1}>
                            {(crewUnit.unit.capability_labels?.length
                              ? crewUnit.unit.capability_labels
                              : [crewUnit.unit.capability_label]
                            ).join(' · ')}
                            {crewUnit.wants ? ' — matches this call' : ' — not what this call asks for'}
                          </Small>
                        </Row>
                        <Row justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11 }}>Crew</Small>
                          <Small style={{ fontSize: 11.5 }} numberOfLines={1}>
                            {crewUnit.unit.driver?.full_name ?? 'No crew account linked'}
                          </Small>
                        </Row>
                        <Row justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11 }}>Status</Small>
                          <Small
                            style={{
                              fontSize: 11.5,
                              color: crewUnit.free ? t.status.live.base : t.status.warm.base,
                            }}
                          >
                            {crewUnit.unit.status_label ?? crewUnit.unit.status}
                          </Small>
                        </Row>
                        <Row justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11 }}>Position</Small>
                          <Row gap="xs" align="center">
                            <Num size={11.5}>
                              {straightMinutes({ lat: crewUnit.unit.lat, lng: crewUnit.unit.lng }, { lat: incident.lat, lng: incident.lng })} min
                            </Num>
                            <Small muted style={{ fontSize: 11 }}>
                              straight line · GPS fix {relativeFromIso(crewUnit.unit.updated_at)}
                            </Small>
                          </Row>
                        </Row>
                        <Small muted style={{ fontSize: 10.5 }}>
                          The committed ETA is measured on the road network from this position and is
                          shown once the unit is assigned.
                        </Small>
                      </View>
                    ) : null}

                    {crewProblem ? (
                      <Banner
                        tone="warm"
                        icon="alert"
                        title="No free unit right now"
                        body={`${crewProblem} ${crewCommitted} unit${
                          crewCommitted === 1 ? '' : 's'
                        } in this scope ${
                          crewCommitted === 1 ? 'is' : 'are'
                        } already committed or out of service. Pick one below to require it anyway, or re-route the receiving facility.`}
                      />
                    ) : null}

                    <Button
                      label={crewPick ? 'Hide units' : `Choose a unit (${crewFree} free)`}
                      icon={crewPick ? 'chevronUp' : 'chevronDown'}
                      size="sm"
                      onPress={() => setCrewPick((v) => !v)}
                    />

                    {crewPick ? (
                      <Stack gap="xs">
                        <Pressable
                          onPress={() => setCrewChoice(null)}
                          accessibilityRole="button"
                          accessibilityState={{ selected: crewChoice === null }}
                          accessibilityLabel="Let the dispatch engine choose the crew"
                          style={{
                            borderWidth: StyleSheet.hairlineWidth,
                            borderColor: crewChoice === null ? t.accent.base : t.line.base,
                            backgroundColor: crewChoice === null ? t.accent.wash : t.bg.surface,
                            borderRadius: radius.md,
                            paddingHorizontal: 10,
                            paddingVertical: 8,
                          }}
                        >
                          <Row justify="space-between" align="center" gap="sm">
                            <Body style={{ fontSize: 12.5 }}>Let the engine choose</Body>
                            {crewChoice === null ? <Icon name="check" size={13} color={t.accent.base} /> : null}
                          </Row>
                        </Pressable>

                        {crewOptions.slice(0, 12).map((option) => {
                          const isSelected = crewChoice === option.unit.id;
                          return (
                            <Pressable
                              key={option.unit.id}
                              onPress={() => setCrewChoice(option.unit.id)}
                              accessibilityRole="button"
                              accessibilityState={{ selected: isSelected }}
                              accessibilityLabel={`${option.unit.call_sign}, ${option.unit.capability_label}, ${
                                option.unit.status_label ?? option.unit.status
                              }${option.wants ? ', matches this call' : ''}`}
                              style={{
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: isSelected ? t.accent.base : t.line.base,
                                backgroundColor: isSelected ? t.accent.wash : t.bg.surface,
                                borderRadius: radius.md,
                                paddingHorizontal: 10,
                                paddingVertical: 8,
                                gap: 3,
                                opacity: option.free ? 1 : 0.62,
                              }}
                            >
                              <Row justify="space-between" align="center" gap="sm">
                                <Row gap="xs" align="center">
                                  <Num size={12.5}>{option.unit.call_sign}</Num>
                                  {option.wants ? <Pill label="Capability match" tone="live" compact /> : null}
                                </Row>
                                <Num size={11.5} color={t.fg.muted}>
                                  {option.km.toFixed(1)} km
                                </Num>
                              </Row>
                              <Row justify="space-between" align="center" gap="sm">
                                <Small muted style={{ fontSize: 11 }}>
                                  {option.unit.capability_label}
                                  {option.crewed
                                    ? ` · ${option.unit.driver?.full_name ?? 'crew linked'}`
                                    : ' · no crew linked'}
                                </Small>
                                <Small
                                  style={{
                                    fontSize: 11,
                                    color: option.free ? t.status.live.base : t.status.warm.base,
                                  }}
                                >
                                  {option.unit.status_label ?? option.unit.status}
                                </Small>
                              </Row>
                            </Pressable>
                          );
                        })}
                        {crewOptions.length > 12 ? (
                          <Small muted style={{ fontSize: 11 }}>
                            Showing the 12 nearest of {crewOptions.length}. The engine considers the whole
                            fleet when you let it choose.
                          </Small>
                        ) : null}
                      </Stack>
                    ) : null}

                    {crewChoice !== null && crewUnit && !crewUnit.free ? (
                      <Small muted style={{ fontSize: 10.5 }}>
                        {crewUnit.unit.call_sign} is not free. Committing it requires a reason and will be
                        recorded against your account.
                      </Small>
                    ) : null}
                  </Stack>

                  {chosen.trust?.factors?.length ? (
                    <Stack gap="xs">
                      <Label>Why this facility scores {chosen.trust.score}</Label>
                      {chosen.trust.factors.slice(0, 4).map((f) => (
                        <Row key={f.label} justify="space-between" gap="sm">
                          <Small muted style={{ fontSize: 11.5, flex: 1 }} numberOfLines={1}>
                            {f.label}
                          </Small>
                          <Num size={11} color={f.delta.startsWith('-') ? t.status.stale.base : t.status.live.base}>
                            {f.delta}
                          </Num>
                        </Row>
                      ))}
                    </Stack>
                  ) : null}

                  <Button
                    label={isDispatched ? 'Re-route to this facility' : 'Dispatch & alert hospital'}
                    variant="primary"
                    icon={isDispatched ? 'swap' : 'check'}
                    full
                    loading={busy === 'dispatch' || busy === 'reroute'}
                    disabled={isFinished}
                    onPress={() => setPending({ kind: 'commit', candidate: chosen })}
                  />

                  {blocked && blocked.candidate.hospital_id === chosen.hospital_id ? (
                    <Button
                      label="Override and commit anyway"
                      variant="danger"
                      size="sm"
                      full
                      onPress={() =>
                        setPending({ kind: 'override', candidate: chosen, blockers: blocked.blockers })
                      }
                    />
                  ) : null}

                  <Small muted style={{ fontSize: 11 }}>
                    Committing sends the crew the assignment and the receiving facility a preparation alert
                    with the ETA, category and requirements. Both are written to the audit trail against your
                    account.
                  </Small>
                </>
              ) : (
                <Small muted>Select a facility from the shortlist to continue.</Small>
              )}
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Call record" />
              <KeyValue label="Reference" dense>
                <Num size={12.5}>{incident.reference}</Num>
              </KeyValue>
              <KeyValue label="Raised" dense>
                <Num size={12.5} color={t.fg.muted}>
                  {clockTime(incident.created_at)}
                </Num>
              </KeyValue>
              <KeyValue label="Dispatched" dense>
                <Num size={12.5} color={t.fg.muted}>
                  {clockTime(incident.dispatched_at)}
                </Num>
              </KeyValue>
              <KeyValue label="Time to commit" dense>
                <Num size={12.5} color={t.status.live.base}>
                  {incident.dispatched_at
                    ? elapsed(Math.max(0, (new Date(incident.dispatched_at).getTime() - new Date(incident.created_at).getTime()) / 1000))
                    : 'pending'}
                </Num>
              </KeyValue>
              <KeyValue label="Category" dense last>
                <Small style={{ fontSize: 12.5 }}>{categoryLabel(incident.category)}</Small>
              </KeyValue>

              <Small muted style={{ fontSize: 11 }}>
                The ranked shortlist as it stood at the moment of dispatch is stored against this record, so a later
                review can see exactly what the engine recommended and what the operator chose.
              </Small>
            </Card>
          </Stack>
        </Row>
      </ScrollView>

      {/* The confirmation step. Deliberately not a one-tap action: this panel
          sits beside the facility rows and the status controls, and the cost of
          committing the wrong unit to the wrong patient is measured in minutes
          of somebody else's ambulance. */}
      <ConfirmDialog
        visible={pending?.kind === 'commit'}
        title={
          pending?.candidate
            ? isDispatched
              ? `Re-route ${incident.reference}?`
              : `Commit ${incident.reference}?`
            : 'Confirm'
        }
        body={
          pending?.candidate ? (
            <Stack gap="xs">
              <KeyValue label="Facility">{pending.candidate.short_name}</KeyValue>
              <KeyValue label="Drive time">
                {`${pending.candidate.eta_minutes} min · ${pending.candidate.distance_label}`}
              </KeyValue>
              <KeyValue label="Crew">
                {crewUnit ? `${crewUnit.unit.call_sign} (chosen)` : 'Engine will assign the nearest capable unit'}
              </KeyValue>
              <KeyValue label="Reserving">
                {holdResource === 'none' ? 'No hold' : `${holdResource} for 15 minutes`}
              </KeyValue>
              <Small muted style={{ fontSize: 11 }}>
                {isDispatched
                  ? 'The crew and the previous facility are both notified. Any hold at the previous facility is released before the new one is placed.'
                  : 'The crew is assigned and the receiving facility is alerted with the ETA, category and requirements.'}
              </Small>
            </Stack>
          ) : null
        }
        confirmLabel={isDispatched ? 'Re-route' : 'Dispatch'}
        busy={busy === 'dispatch' || busy === 'reroute'}
        onConfirm={confirmPending}
        onCancel={() => setPending(null)}
      />

      {/* An override is a clinical disagreement with the engine. It is allowed,
          and it is recorded, and the record has to say what the operator knew. */}
      <ConfirmDialog
        visible={pending?.kind === 'override'}
        tone="danger"
        title="Override the engine"
        body={
          pending ? (
            <Stack gap="xs">
              <KeyValue label="Facility">{pending.candidate.short_name}</KeyValue>
              <KeyValue label="Engine says">{pending.blockers?.join('; ') ?? 'Not eligible'}</KeyValue>
              <Small muted style={{ fontSize: 11 }}>
                Committing against the engine's advice is allowed — the engine cannot see a phone call
                from the receiving consultant. It is recorded against your account with the reason below.
              </Small>
            </Stack>
          ) : null
        }
        confirmLabel="Override and commit"
        requireReason
        reasonLabel="Why are you overriding the engine?"
        reasonHint="Recorded in the audit trail against your account. Minimum 12 characters."
        busy={busy === 'dispatch' || busy === 'reroute'}
        onConfirm={confirmPending}
        onCancel={() => {
          setPending(null);
          if (blocked) setBlocked(null);
        }}
      />
    </AppShell>
  );
}

/* ----------------------------------------------------------------- pieces */

function NeedFlag({ label, on }: { label: string; on: boolean }) {
  const { t } = useTheme();
  return (
    <Stack gap="xxs" style={{ minWidth: 96 }}>
      <Label style={{ fontSize: 9.5 }}>{label}</Label>
      <Row gap="xs" align="center">
        <Icon
          name={on ? 'check' : 'minus'}
          size={13}
          color={on ? t.status.critical.base : t.fg.faint}
          strokeWidth={2.2}
        />
        <Small style={{ fontSize: 12, color: on ? t.fg.base : t.fg.faint }}>
          {on ? 'required' : 'not needed'}
        </Small>
      </Row>
    </Stack>
  );
}

function CandidateRow({
  candidate,
  rank,
  selected,
  onSelect,
  disabled,
}: {
  candidate: ShortlistCandidate;
  rank: number;
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  const fresh = freshnessStatus(candidate.freshness?.state);
  const cap = candidate.capacity;

  return (
    <View
      style={{
        backgroundColor: t.bg.surface,
        borderRadius: radius.lg,
        borderWidth: selected ? 1.4 : StyleSheet.hairlineWidth,
        borderColor: selected ? t.accent.base : candidate.eligible ? t.line.base : `${t.status.stale.base}44`,
        padding: space.lg,
        gap: space.sm,
        opacity: candidate.eligible ? 1 : 0.82,
      }}
    >
      <Row justify="space-between" align="flex-start" gap="md">
        <Row gap="sm" align="flex-start" style={{ flex: 1, minWidth: 0 }}>
          <View
            style={{
              width: 24,
              height: 24,
              borderRadius: 12,
              backgroundColor: candidate.eligible ? t.accent.soft : t.bg.sunken,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Num size={11.5} color={candidate.eligible ? t.accent.base : t.fg.faint}>
              {rank}
            </Num>
          </View>
          <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
            <Row gap="sm" align="center" wrap>
              <Body style={{ fontWeight: '600', fontSize: 14.5 }}>{candidate.short_name}</Body>
              <Pill
                label={candidate.type === 'public' ? 'Govt' : candidate.type === 'private' ? 'Private' : 'Trust'}
                tone="neutral"
                compact
                outline
              />
              <Row gap="xxs" align="center">
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.status[fresh].base }} />
                <Label tone={t.status[fresh].base} style={{ fontSize: 9.5 }}>
                  {candidate.freshness?.state === 'live'
                    ? 'live'
                    : ageFromSeconds(candidate.freshness?.age_seconds ?? 0)}
                </Label>
              </Row>
            </Row>
            <Small muted numberOfLines={1}>
              {candidate.name} · {candidate.address}
            </Small>
          </Stack>
        </Row>

        <Stack gap="xs" align="flex-end" style={{ minWidth: 96 }}>
          <Num size={20} color={candidate.eligible ? t.fg.strong : t.fg.faint}>
            {candidate.score}
          </Num>
          <Label style={{ fontSize: 9 }}>engine score</Label>
          <Meter value={candidate.score} total={100} tone={candidate.eligible ? 'info' : 'neutral'} height={3} />
        </Stack>
      </Row>

      {/* Reasons the facility qualifies — the operator's evidence */}
      {candidate.reasons.length ? (
        <Row gap="xs" wrap>
          {candidate.reasons.slice(0, 5).map((r) => (
            <Pill key={r} label={r} tone="live" compact icon="check" />
          ))}
        </Row>
      ) : null}

      {candidate.warnings.length ? (
        <Row gap="xs" wrap>
          {candidate.warnings.slice(0, 3).map((w) => (
            <Pill key={w} label={w} tone="warm" compact icon="alert" />
          ))}
        </Row>
      ) : null}

      {candidate.blockers.length ? (
        <Row gap="xs" wrap>
          {candidate.blockers.map((b) => (
            <Pill key={b} label={b} tone="critical" compact icon="x" />
          ))}
        </Row>
      ) : null}

      <Divider />

      <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
        <Row gap="md" wrap>
          <Row gap="xs" align="center">
            <Icon name="route" size={13} color={t.fg.faint} />
            <Num size={12.5} color={candidate.distance_is_road ? t.fg.base : t.fg.muted}>
              {candidate.distance_label}
            </Num>
            {/* Say how the number was obtained. "via road" means the drive time
                came off the road network; "direct" means geometry with a winding
                factor, which is what the platform falls back to without a
                routing key. A dispatcher acting on a 9-minute ETA should know
                which of those they are looking at. */}
            {candidate.distance_is_road ? (
              <Small muted style={{ fontSize: 10 }}>
                {candidate.traffic_aware ? 'via road · live traffic' : 'via road'}
              </Small>
            ) : (
              <Small muted style={{ fontSize: 10 }}>
                direct
              </Small>
            )}
          </Row>
          {cap ? (
            <>
              <Row gap="xs" align="center">
                <Icon name="bed" size={13} color={t.fg.faint} />
                <Num size={12.5} color={cap.beds_effective > 0 ? t.fg.base : t.status.critical.base}>
                  {cap.beds_effective}
                </Num>
                <Small muted style={{ fontSize: 11 }}>
                  beds
                </Small>
              </Row>
              <Row gap="xs" align="center">
                <Icon name="activity" size={13} color={t.fg.faint} />
                <Num size={12.5} color={cap.icu_effective > 0 ? t.fg.base : t.status.critical.base}>
                  {cap.icu_effective}
                </Num>
                <Small muted style={{ fontSize: 11 }}>
                  ICU
                </Small>
              </Row>
              <Pill
                label={`ED ${cap.ed_congestion}`}
                tone={cap.ed_congestion === 'critical' ? 'critical' : cap.ed_congestion === 'high' ? 'stale' : 'live'}
                compact
              />
            </>
          ) : null}
        </Row>

        <Row gap="sm" align="center">
          <TrustChip score={candidate.trust?.score} />
          <Button
            label={selected ? 'Selected' : 'Select'}
            size="sm"
            variant={selected ? 'primary' : 'secondary'}
            icon={selected ? 'check' : undefined}
            disabled={disabled}
            onPress={onSelect}
          />
        </Row>
      </Row>
    </View>
  );
}

/**
 * Scene assessment.
 *
 * Renders the structured intake as a readable panel. The point of showing it on
 * the incident rather than only on the form is that the crew and the receiving
 * ward both need to know what was reported before they arrive -- and because a
 * dispatcher reviewing a placement decision needs to see what the engine was
 * told, not a reconstruction of it.
 */
function ScenePanel({ scene }: { scene?: Incident['scene'] }) {
  const { t } = useTheme();
  if (!scene) return null;

  const facts: { label: string; value: string; tone?: string }[] = [
    { label: 'Condition', value: scene.patient_state_label },
    { label: 'Mechanism', value: scene.mechanism_label },
  ];
  if (scene.bleeding !== 'none') {
    facts.push({
      label: 'Bleeding',
      value: scene.bleeding === 'severe' ? 'Severe' : 'Minor',
      tone: scene.bleeding === 'severe' ? t.status.critical.base : undefined,
    });
  }
  if (scene.hazard !== 'none') {
    facts.push({ label: 'Hazard', value: scene.hazard_label, tone: t.status.warm.base });
  }
  if (scene.casualty_count > 1) {
    facts.push({
      label: 'Casualties',
      value: `${scene.casualty_count} at scene`,
      tone: t.status.warm.base,
    });
  }
  if (scene.trapped) facts.push({ label: 'Extrication', value: 'Patient trapped' });
  if (scene.bystander_cpr) facts.push({ label: 'CPR', value: 'Bystander compressions' });

  return (
    <Stack gap="xs">
      <Row gap="lg" wrap>
        {facts.map((f) => (
          <Stack key={f.label} gap="xxs">
            <Label style={{ fontSize: 9.5 }}>{f.label}</Label>
            <Small style={{ fontSize: 12, color: f.tone ?? t.fg.base, fontWeight: '500' }}>
              {f.value}
            </Small>
          </Stack>
        ))}
      </Row>
      {scene.observations.length ? (
        <Row gap="xs" wrap>
          {scene.observations.map((o) => (
            <Pill key={o} label={o.replace(/_/g, ' ')} tone="neutral" compact />
          ))}
        </Row>
      ) : null}
    </Stack>
  );
}
