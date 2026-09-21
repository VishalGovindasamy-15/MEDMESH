import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../src/api/client';
import type { Capacity, Doctor, FacilityDetail } from '../src/api/types';
import { ReportSheet } from '../src/components/ReportSheet';
import { ageFromSeconds, countdown, relativeFromIso, specialtyLabel } from '../src/lib/format';
import { useAuth } from '../src/state/AuthProvider';
import { useLive } from '../src/state/LiveProvider';
import { congestionStatus, freshnessStatus, urgencyStatus, useTheme } from '../src/theme/ThemeProvider';
import { radius, space } from '../src/theme/tokens';
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
  SwitchRow,
  TextField,
  Title,
  TrustChip,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';
import { useResponsive } from '../src/ui/useResponsive';

/**
 * Hospital portal (§6.2 + §6.3).
 *
 * The entire screen is built around one assumption: the person using it is
 * standing at a ward desk during a shift change and has about fifteen seconds.
 * So:
 *  - The default interaction is a single tap on a signed delta ("‑1 bed"),
 *    not a form. Full-form entry is available but demoted.
 *  - The trust engine's verdict is shown on every submission. If an update is
 *    quarantined, the staff member is told *why* and that it was withheld —
 *    silently dropping a report is how a facility learns to stop reporting.
 *  - Staleness is surfaced as a reminder to the facility itself, which is the
 *    nudge loop described in §6.2, not just a badge for outsiders.
 */

export default function HospitalDashboard() {
  const { t } = useTheme();
  const { user, token } = useAuth();
  const { subscribe, facilities } = useLive();
  const { isDesktop } = useResponsive();

  const hospitalId = user?.hospital_id ?? null;

  const [detail, setDetail] = useState<FacilityDetail | null>(null);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'live' | 'warm' | 'critical'; title: string; body?: string } | null>(null);
  const [inbound, setInbound] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [reporting, setReporting] = useState(false);

  // Full-form state
  const [form, setForm] = useState({ beds: '', icu: '', vent: '', blood: '', antivenom: '', waiting: '' });

  const load = useCallback(
    async (silent = false) => {
      if (!hospitalId) return;
      if (!silent) setRefreshing(true);
      try {
        const [facility, roster] = await Promise.allSettled([
          api.get<FacilityDetail>(`/hospitals/${hospitalId}?history_hours=12`, { token }),
          api.get<{ results: Doctor[] }>(`/doctors?hospital_id=${hospitalId}&on_duty_only=false&limit=200`, { token }),
        ]);
        if (facility.status !== 'fulfilled') throw facility.reason;
        setDetail(facility.value);
        // The roster is a secondary panel — losing it must not take the capacity
        // keypad down with it.
        setDoctors(roster.status === 'fulfilled' ? roster.value.results : []);
        const cap = facility.value.capacity;
        setForm({
          beds: String(cap?.beds_available ?? 0),
          icu: String(cap?.icu_available ?? 0),
          vent: String(cap?.ventilators_available ?? 0),
          blood: String(cap?.blood_units ?? 0),
          antivenom: String(cap?.antivenom_vials ?? 0),
          waiting: String(cap?.ed_waiting ?? 0),
        });
      } catch (err) {
        setFlash({ tone: 'critical', title: 'Could not load your facility', body: err instanceof ApiError ? err.message : undefined });
      } finally {
        setRefreshing(false);
      }
    },
    [hospitalId, token],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Inbound prep alerts from the dispatch console (§6.4 two-way alert).
  useEffect(() => {
    const off = subscribe('hospital.inbound', (event) => {
      if (hospitalId && event.data?.hospital_id !== hospitalId) return;
      setInbound((prev) => [{ ...event.data, receivedAt: Date.now() }, ...prev].slice(0, 6));
    });
    return off;
  }, [subscribe, hospitalId]);

  useEffect(() => {
    const id = setInterval(() => load(true), 45_000);
    return () => clearInterval(id);
  }, [load]);

  const live = hospitalId ? facilities[hospitalId]?.capacity : null;
  const capacity: Capacity | null = live ?? detail?.capacity ?? null;

  const quickAdjust = async (deltas: Record<string, number>, edCongestion?: string, waitingDelta?: number) => {
    if (!hospitalId) return;
    const key = JSON.stringify(deltas) + (edCongestion ?? '') + (waitingDelta ?? '');
    setBusy(key);
    setFlash(null);
    try {
      const res = await api.post<any>(
        `/hospitals/${hospitalId}/capacity/quick`,
        { deltas, ed_congestion: edCongestion ?? null, ed_waiting_delta: waitingDelta ?? null },
        { token },
      );
      const verdict = res.trust;
      if (!res.accepted) {
        setFlash({
          tone: 'critical',
          title: 'Update withheld by the trust engine',
          body: `${(verdict?.flags ?? []).join('; ')}. The live figure was not changed. If the number is genuine, submit the full form and the district office will review it.`,
        });
      } else {
        const summary = Object.entries(res.changed ?? {})
          .map(([k, v]: any) => `${k.replace(/_/g, ' ')} ${v.from}→${v.to}`)
          .join(', ');
        setFlash({
          tone: verdict?.band === 'low' ? 'warm' : 'live',
          title: 'Published to the network',
          body: `${summary || 'Recorded'} · visible to 108 dispatch and the public directory immediately.`,
        });
      }
      await load(true);
    } catch (err) {
      setFlash({ tone: 'critical', title: 'Update rejected', body: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const submitFull = async () => {
    if (!hospitalId) return;
    setBusy('full');
    setFlash(null);
    try {
      const res = await api.post<any>(
        `/hospitals/${hospitalId}/capacity`,
        {
          beds_available: Number(form.beds),
          icu_available: Number(form.icu),
          ventilators_available: Number(form.vent),
          blood_units: Number(form.blood),
          antivenom_vials: Number(form.antivenom),
          ed_waiting: Number(form.waiting),
          ed_congestion: capacity?.ed_congestion ?? 'moderate',
        },
        { token },
      );
      setFlash(
        res.accepted
          ? { tone: 'live', title: 'Full update published', body: `Trust score ${res.trust.score} (${res.trust.band}).` }
          : {
              tone: 'critical',
              title: 'Update withheld',
              body: (res.trust.flags ?? []).join('; '),
            },
      );
      await load(true);
    } catch (err) {
      setFlash({ tone: 'critical', title: 'Update rejected', body: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const toggleDuty = async (doctor: Doctor) => {
    setBusy(`doc:${doctor.id}`);
    try {
      await api.post(`/doctors/${doctor.id}/duty`, { on_duty: !doctor.on_duty }, { token });
      await load(true);
    } catch (err) {
      setFlash({ tone: 'critical', title: 'Could not change duty status', body: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  if (!user) {
    return (
      <AppShell title="Facility portal" subtitle="Sign in required">
        <EmptyState
          icon="lock"
          title="Sign in to update your facility"
          body="This surface is restricted to provisioned hospital accounts. Each account can only read and write its own facility's records."
        />
      </AppShell>
    );
  }

  if (!hospitalId) {
    return (
      <AppShell title="Facility portal" subtitle="No facility linked">
        <EmptyState
          icon="alert"
          title="Your account is not linked to a facility"
          body="A MedMesh administrator needs to scope this account to a hospital before you can update capacity. This is deliberate — it is what stops one hospital editing another's numbers."
        />
      </AppShell>
    );
  }

  if (!detail || !capacity) {
    return (
      <AppShell title="Facility portal" subtitle="Loading">
        <Loading label="Loading your facility…" />
      </AppShell>
    );
  }

  const fresh = freshnessStatus(capacity.trust_state);
  const ageSeconds = Math.floor((Date.now() - new Date(capacity.recorded_at).getTime()) / 1000);
  const stale = ageSeconds > 3600;

  return (
    <AppShell
      title={detail.short_name}
      subtitle={`${detail.name} · ${detail.district_name ?? ''}`}
      maxWidth={1440}
      actions={
        <Row gap="xs">
          <TrustChip score={detail.trust?.score} band={detail.trust?.band} />
          <Button label="Report an issue" icon="flag" size="sm" onPress={() => setReporting(true)} />
        </Row>
      }
      footerNote="Every submission is timestamped, attributed to your account and written to the append-only audit log. Implausible updates are quarantined rather than published."
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
      >
        {/* Staleness nudge — the facility sees its own neglect first --------- */}
        {stale ? (
          <Banner
            tone="stale"
            icon="clock"
            title={`Your last report was ${ageFromSeconds(ageSeconds)}`}
            body="Dispatch is routing on stale data for your facility. A two-tap update restores the live badge and lifts your trust score."
            action={
              <Row gap="sm" style={{ marginTop: space.sm }}>
                <Button label="Confirm unchanged" size="sm" icon="check" onPress={() => quickAdjust({ beds_available: 0 })} />
              </Row>
            }
          />
        ) : null}

        {flash ? (
          <Banner
            tone={flash.tone}
            icon={flash.tone === 'live' ? 'check' : 'alert'}
            title={flash.title}
            body={flash.body}
          />
        ) : null}

        {inbound.length ? (
          <Card tone="critical" style={{ gap: space.md }}>
            <SectionHeader
              label="Inbound — prepare to receive"
              action={
                <Button label="Clear" size="sm" variant="ghost" onPress={() => setInbound([])} />
              }
            />
            {inbound.map((alert, i) => (
              <Stack key={`${alert.incident_id}-${i}`} gap="xs">
                <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
                  <Row gap="sm" align="center">
                    <Num size={12.5} color={t.fg.strong}>
                      {alert.reference}
                    </Num>
                    <Pill label={alert.urgency} tone={alert.urgency === 'P1' ? 'critical' : 'warm'} compact />
                    <Pill label={String(alert.category).replace(/_/g, ' ')} tone="neutral" compact outline />
                    {alert.hold_resource ? <Pill label={`${alert.hold_resource} held`} tone="info" compact icon="lock" /> : null}
                  </Row>
                  <Num size={13} color={t.status.critical.base}>
                    ETA {alert.eta_minutes} min
                  </Num>
                </Row>
                <Small muted style={{ fontSize: 12 }}>
                  Inbound alert received {relativeFromIso(new Date(alert.receivedAt).toISOString())}. Prepare the
                  receiving area and confirm the bed is free.
                </Small>
              </Stack>
            ))}
          </Card>
        ) : null}

        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          {/* Quick update keypad ------------------------------------------- */}
          <Stack gap="lg" style={{ flex: 2, minWidth: isDesktop ? 480 : '100%' }}>
            <Card style={{ gap: space.lg }}>
              <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
                <Stack gap="xxs">
                  <Heading>Quick update</Heading>
                  <Small muted style={{ fontSize: 12 }}>
                    One tap per change. Published to dispatch and the public directory instantly.
                  </Small>
                </Stack>
                <Row gap="xs" align="center">
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.status[fresh].base }} />
                  <Label tone={t.status[fresh].base}>{ageFromSeconds(ageSeconds)}</Label>
                </Row>
              </Row>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md }}>
                <DeltaTile
                  label="General beds"
                  value={capacity.beds_effective}
                  onMinus={() => quickAdjust({ beds_available: -1 })}
                  onPlus={() => quickAdjust({ beds_available: 1 })}
                  onMinusMany={() => quickAdjust({ beds_available: -5 })}
                  onPlusMany={() => quickAdjust({ beds_available: 5 })}
                  busy={busy !== null && busy.includes('beds_available')}
                  tone={capacity.beds_effective === 0 ? 'critical' : 'live'}
                />
                <DeltaTile
                  label="ICU beds"
                  value={capacity.icu_effective}
                  onMinus={() => quickAdjust({ icu_available: -1 })}
                  onPlus={() => quickAdjust({ icu_available: 1 })}
                  onMinusMany={() => quickAdjust({ icu_available: -5 })}
                  onPlusMany={() => quickAdjust({ icu_available: 5 })}
                  busy={busy !== null && busy.includes('icu_available')}
                  tone={capacity.icu_effective === 0 ? 'critical' : 'info'}
                />
                <DeltaTile
                  label="Ventilators"
                  value={capacity.vent_effective}
                  onMinus={() => quickAdjust({ ventilators_available: -1 })}
                  onPlus={() => quickAdjust({ ventilators_available: 1 })}
                  onMinusMany={() => quickAdjust({ ventilators_available: -5 })}
                  onPlusMany={() => quickAdjust({ ventilators_available: 5 })}
                  busy={busy !== null && busy.includes('ventilators_available')}
                  tone={capacity.vent_effective === 0 ? 'warm' : 'warm'}
                />
              </View>

              <Divider />

              <Stack gap="sm">
                <Label>Emergency department congestion</Label>
                <Segmented
                  options={[
                    { value: 'low', label: 'Low' },
                    { value: 'moderate', label: 'Moderate' },
                    { value: 'high', label: 'High' },
                    { value: 'critical', label: 'Critical — divert' },
                  ]}
                  value={capacity.ed_congestion}
                  onChange={(v) => quickAdjust({}, v)}
                  size="sm"
                  scroll
                />
                <Row gap="sm" align="center" style={{ flexWrap: 'wrap' }}>
                  <Small muted style={{ flex: 1, minWidth: 180, fontSize: 11.5 }}>
                    Waiting-room count is the strongest early signal that your ED is about to saturate. Currently{' '}
                    <Num size={11.5}>{capacity.ed_waiting}</Num> waiting.
                  </Small>
                  <Row gap="xs">
                    <Button label="−1" size="sm" onPress={() => quickAdjust({}, undefined, -1)} />
                    <Button label="+1" size="sm" onPress={() => quickAdjust({}, undefined, 1)} />
                    <Button label="+5" size="sm" onPress={() => quickAdjust({}, undefined, 5)} />
                  </Row>
                </Row>
              </Stack>

              <Divider />

              <Pressable onPress={() => setAdvanced((v) => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} color={t.fg.muted} />
                <Label>Full update form — set exact counters</Label>
              </Pressable>

              {advanced ? (
                <Stack gap="md">
                  <Row gap="md" wrap>
                    <TextField label="Beds available" value={form.beds} onChangeText={(v) => setForm((f) => ({ ...f, beds: v }))} keyboardType="number-pad" style={{ flex: 1, minWidth: 130 }} />
                    <TextField label="ICU available" value={form.icu} onChangeText={(v) => setForm((f) => ({ ...f, icu: v }))} keyboardType="number-pad" style={{ flex: 1, minWidth: 130 }} />
                    <TextField label="Ventilators" value={form.vent} onChangeText={(v) => setForm((f) => ({ ...f, vent: v }))} keyboardType="number-pad" style={{ flex: 1, minWidth: 130 }} />
                  </Row>
                  <Row gap="md" wrap>
                    <TextField label="Blood units" value={form.blood} onChangeText={(v) => setForm((f) => ({ ...f, blood: v }))} keyboardType="number-pad" style={{ flex: 1, minWidth: 130 }} />
                    <TextField label="Antivenom vials" value={form.antivenom} onChangeText={(v) => setForm((f) => ({ ...f, antivenom: v }))} keyboardType="number-pad" style={{ flex: 1, minWidth: 130 }} />
                    <TextField label="ED waiting" value={form.waiting} onChangeText={(v) => setForm((f) => ({ ...f, waiting: v }))} keyboardType="number-pad" style={{ flex: 1, minWidth: 130 }} />
                  </Row>
                  <Row gap="sm" align="center" justify="space-between" style={{ flexWrap: 'wrap' }}>
                    <Small muted style={{ fontSize: 11.5, flex: 1, minWidth: 200 }}>
                      Declared capacity: {detail.declared.beds} beds · {detail.declared.icu} ICU ·{' '}
                      {detail.declared.ventilators} ventilators. A value above these is rejected by the trust engine.
                    </Small>
                    <Button
                      label="Publish full update"
                      variant="primary"
                      icon="upload"
                      loading={busy === 'full'}
                      onPress={submitFull}
                    />
                  </Row>
                </Stack>
              ) : null}
            </Card>

            {/* Roster ------------------------------------------------------ */}
            <Card style={{ gap: space.md }}>
              <Row justify="space-between" align="center">
                <Heading>Duty roster</Heading>
                <Pill
                  label={`${doctors.filter((d) => d.on_duty).length} on duty`}
                  tone="live"
                  compact
                />
              </Row>
              <Small muted style={{ fontSize: 12 }}>
                Toggling here updates the public doctor directory and the dispatcher's specialist view immediately.
              </Small>
              <Stack gap={0}>
                {doctors.slice(0, 12).map((doc, i) => (
                  <Row
                    key={doc.id}
                    justify="space-between"
                    align="center"
                    gap="sm"
                    style={{
                      paddingVertical: 9,
                      borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: t.line.subtle,
                    }}
                  >
                    <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                      <Body style={{ fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>
                        {doc.full_name}
                      </Body>
                      <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
                        {specialtyLabel(doc.specialty)} · {doc.designation} · {doc.shift_window}
                      </Small>
                    </Stack>
                    <SwitchRow
                      label=""
                      value={doc.on_duty}
                      onChange={() => toggleDuty(doc)}
                    />
                  </Row>
                ))}
              </Stack>
            </Card>
          </Stack>

          {/* Right rail ---------------------------------------------------- */}
          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 320 : '100%' }}>
            <Card style={{ gap: space.md }}>
              <SectionHeader label="Published figures" />
              <Row gap="lg" wrap>
                <Stack gap="xs" style={{ flex: 1, minWidth: 80 }}>
                  <Label style={{ fontSize: 9.5 }}>Beds</Label>
                  <Num size={20}>{capacity.beds_effective}</Num>
                  <Meter value={capacity.beds_effective} total={capacity.total_beds} tone="live" height={3} />
                  <Small muted style={{ fontSize: 10.5 }}>
                    of {capacity.total_beds}
                  </Small>
                </Stack>
                <Stack gap="xs" style={{ flex: 1, minWidth: 80 }}>
                  <Label style={{ fontSize: 9.5 }}>ICU</Label>
                  <Num size={20}>{capacity.icu_effective}</Num>
                  <Meter value={capacity.icu_effective} total={capacity.total_icu} tone="info" height={3} />
                  <Small muted style={{ fontSize: 10.5 }}>
                    of {capacity.total_icu}
                  </Small>
                </Stack>
                <Stack gap="xs" style={{ flex: 1, minWidth: 80 }}>
                  <Label style={{ fontSize: 9.5 }}>Vents</Label>
                  <Num size={20}>{capacity.vent_effective}</Num>
                  <Meter value={capacity.vent_effective} total={capacity.total_ventilators} tone="warm" height={3} />
                  <Small muted style={{ fontSize: 10.5 }}>
                    of {capacity.total_ventilators}
                  </Small>
                </Stack>
              </Row>
              <Divider />
              <KeyValue label="ED congestion" dense>
                <Pill label={capacity.ed_congestion} tone={congestionStatus(capacity.ed_congestion)} compact />
              </KeyValue>
              <KeyValue label="Waiting in ED" dense>
                <Num size={13}>{capacity.ed_waiting}</Num>
              </KeyValue>
              <KeyValue label="Blood units" dense>
                <Num size={13}>{capacity.blood_units}</Num>
              </KeyValue>
              <KeyValue label="Antivenom vials" dense>
                <Num size={13}>{capacity.antivenom_vials}</Num>
              </KeyValue>
              <KeyValue label="Submitted via" dense last>
                <Pill
                  label={capacity.source === 'api' ? `connector · ${detail.source_system ?? 'API'}` : 'manual entry'}
                  tone={capacity.source === 'api' ? 'info' : 'neutral'}
                  compact
                />
              </KeyValue>
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader
                label="Holds on your beds"
                action={<Num size={12} color={t.fg.muted}>{detail.active_holds.length}</Num>}
              />
              {detail.active_holds.length === 0 ? (
                <Small muted style={{ fontSize: 12 }}>
                  No ambulance has reserved one of your beds. Holds appear here with a countdown and release
                  automatically.
                </Small>
              ) : (
                detail.active_holds.map((h) => (
                  <Row key={h.id} justify="space-between" align="flex-start" gap="sm">
                    <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
                      <Row gap="xs" align="center" wrap>
                        <Pill label={h.resource === 'icu' ? 'ICU bed' : `${h.resource} bed`} tone="info" compact icon="lock" />
                        {h.reference ? (
                          <Num size={11.5} weight="700" color={t.fg.strong}>{h.reference}</Num>
                        ) : null}
                        {h.urgency ? (
                          <Pill label={h.urgency} tone={urgencyStatus(h.urgency)} compact />
                        ) : null}
                      </Row>
                      <Small muted style={{ fontSize: 11.5 }}>
                        {h.eta_minutes != null
                          ? `${h.ambulance_call_sign ?? 'Crew'} arriving in ${h.eta_minutes} min` +
                            (h.distance_km != null ? ` · ${h.distance_km} km out` : '')
                          : 'Awaiting crew position'}
                      </Small>
                    </Stack>
                    <Stack gap="xs" align="flex-end">
                      <Num size={12.5} color={t.status.info.base}>
                        {countdown(h.seconds_remaining)}
                      </Num>
                      <Small muted style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        hold left
                      </Small>
                    </Stack>
                  </Row>
                ))
              )}
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Why your trust score is what it is" />
              {detail.trust?.factors?.slice(0, 5).map((f) => (
                <Row key={f.label} justify="space-between" align="flex-start" gap="sm">
                  <Small muted style={{ fontSize: 11.5, flex: 1 }}>
                    {f.label}
                  </Small>
                  <Num size={11} color={f.delta.startsWith('-') ? t.status.stale.base : t.status.live.base}>
                    {f.delta}
                  </Num>
                </Row>
              ))}
              <Small muted style={{ fontSize: 11 }}>
                Keeping this above 80 keeps your facility high in dispatch rankings. It measures data quality only.
              </Small>
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Recent submissions" />
              <Stack gap="sm">
                {detail.history.slice(-6).reverse().map((h, i) => (
                  <Row key={`${h.t}-${i}`} justify="space-between" align="center" gap="sm">
                    <Stack gap="xxs">
                      <Num size={11.5} color={t.fg.muted}>
                        {new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                      </Num>
                      <Small muted style={{ fontSize: 10.5 }}>
                        {h.source} · {h.congestion}
                      </Small>
                    </Stack>
                    <Num size={12} color={h.quarantined ? t.status.critical.base : t.fg.base}>
                      {h.beds}/{h.icu}/{h.vent}
                    </Num>
                  </Row>
                ))}
              </Stack>
              {detail.trust?.quarantined ? (
                <Banner tone="critical" icon="alert" title="An update was quarantined" body="One or more recent submissions were implausible and are excluded from the live feed until reviewed." />
              ) : null}
            </Card>
          </Stack>
        </Row>
      </ScrollView>

      <ReportSheet
        visible={reporting}
        hospitalId={hospitalId}
        hospitalName={detail.short_name}
        onClose={() => setReporting(false)}
      />
    </AppShell>
  );
}

/* ------------------------------------------------------------------ pieces */

function DeltaTile({
  label,
  value,
  onMinus,
  onPlus,
  onMinusMany,
  onPlusMany,
  busy,
  tone,
}: {
  label: string;
  value: number;
  onMinus: () => void;
  onPlus: () => void;
  onMinusMany: () => void;
  onPlusMany: () => void;
  busy?: boolean;
  tone: 'live' | 'critical' | 'info' | 'warm';
}) {
  const { t } = useTheme();
  const colour = t.status[tone].base;

  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: 190,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.line.base,
        borderRadius: radius.lg,
        backgroundColor: t.bg.sunken,
        padding: space.md,
        gap: space.sm,
      }}
    >
      <Row justify="space-between" align="center">
        <Label>{label}</Label>
        <Num size={22} color={colour}>
          {value}
        </Num>
      </Row>

      <Row gap="xs">
        <BigTap label="−1" onPress={onMinus} disabled={busy} tone={t.status.stale.base} />
        <BigTap label="+1" onPress={onPlus} disabled={busy} tone={t.status.live.base} />
      </Row>
      <Row gap="xs">
        <BigTap label="−5" onPress={onMinusMany} disabled={busy} tone={t.fg.muted} small />
        <BigTap label="+5" onPress={onPlusMany} disabled={busy} tone={t.fg.muted} small />
      </Row>
    </View>
  );
}

function BigTap({
  label,
  onPress,
  disabled,
  tone,
  small,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone: string;
  small?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      onPress={disabled ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={`Adjust by ${label}`}
      disabled={disabled}
      style={({ pressed }) => ({
        flex: 1,
        paddingVertical: small ? 8 : 14,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: `${tone}55`,
        backgroundColor: pressed ? `${tone}18` : t.bg.surface,
        opacity: disabled ? 0.5 : 1,
      })}
    >
      <Num size={small ? 13 : 17} color={tone} weight="600">
        {label}
      </Num>
    </Pressable>
  );
}
