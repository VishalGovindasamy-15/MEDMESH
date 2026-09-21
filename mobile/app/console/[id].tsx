import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Linking, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../../src/api/client';
import type { Incident, RoutingSummary, ShortlistCandidate } from '../../src/api/types';
import { MapSurface } from '../../src/components/MapSurface';
import type { MapPoint } from '../../src/components/mapTypes';
import { ageFromSeconds, categoryLabel, clockTime, countdown, elapsed, STATUS_LABELS } from '../../src/lib/format';
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

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const [inc, list] = await Promise.all([
          api.get<Incident>(`/incidents/${incidentId}`, { token }),
          api.get<{ results: ShortlistCandidate[]; routing?: RoutingSummary }>(
            `/incidents/${incidentId}/shortlist?limit=12`,
            { token },
          ),
        ]);
        setIncident(inc);
        setShortlist(list.results);
        setRouting(list.routing ?? null);
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
    try {
      await api.post(
        `/incidents/${incidentId}/dispatch`,
        {
          hospital_id: candidate.hospital_id,
          hold_resource: holdResource === 'none' ? null : holdResource,
          hold_seconds: 900,
          override_reason: overrideReason ?? null,
        },
        { token },
      );
      await load(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const detail: any = err.detail;
        if (detail && typeof detail === 'object' && Array.isArray(detail.blockers) && detail.blockers.length) {
          setBlocked({ candidate, blockers: detail.blockers });
          setShowRejected(true);
        } else {
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

  const isDispatched = ['dispatched', 'en_route', 'arrived'].includes(incident.status);
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
                      { key: 'en_route', label: 'En route' },
                      { key: 'arrived', label: 'On board' },
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
                    onPress={() => (isDispatched ? reroute(chosen) : dispatchTo(chosen))}
                  />

                  {blocked && blocked.candidate.hospital_id === chosen.hospital_id ? (
                    <Button
                      label="Override and commit anyway"
                      variant="danger"
                      size="sm"
                      full
                      onPress={() =>
                        dispatchTo(chosen, `operator override: ${blocked.blockers.join('; ')}`)
                      }
                    />
                  ) : null}

                  <Small muted style={{ fontSize: 11 }}>
                    Dispatch notifies the crew and sends the receiving facility a preparation alert with the ETA,
                    category and requirements. Both are written to the audit trail against your account.
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
