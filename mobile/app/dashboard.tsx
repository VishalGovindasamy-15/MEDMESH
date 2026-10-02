import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useLocalSearchParams } from 'expo-router';

import { api, ApiError } from '../src/api/client';
import type { Capacity, Doctor, FacilityDetail } from '../src/api/types';
import { DutyBadge } from '../src/components/DutyPresence';
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

/**
 * Specialty catalogue for the roster editor.
 *
 * A closed list, mirroring `GET /hospitals/specialties`, because specialty is
 * the *first* step of the matching chain: an incident for a cardiac case asks
 * for `cardiology`, and a facility whose cardiologist was entered as "Heart" or
 * "Cardio" contributes nothing to that answer. Free text here would be a typo
 * away from a silent hole in statewide coverage.
 */
/** The six shift patterns the pilot's facilities actually roster. */
const SHIFT_PRESETS = [
  '08:00 – 20:00',
  '20:00 – 08:00',
  '07:00 – 15:00',
  '15:00 – 23:00',
  '23:00 – 07:00',
  '09:00 – 17:00',
];

const DOCTOR_SPECIALTIES: { value: string; label: string }[] = [
  { value: 'burns', label: 'Burns' },
  { value: 'cardiology', label: 'Cardiology' },
  { value: 'critical_care', label: 'Critical Care' },
  { value: 'gastroenterology', label: 'Gastroenterology' },
  { value: 'general_medicine', label: 'General Medicine' },
  { value: 'general_surgery', label: 'General Surgery' },
  { value: 'gynaecology', label: 'Gynaecology' },
  { value: 'nephrology', label: 'Nephrology' },
  { value: 'neurology', label: 'Neurology' },
  { value: 'neurosurgery', label: 'Neurosurgery' },
  { value: 'obstetrics', label: 'Obstetrics' },
  { value: 'oncology', label: 'Oncology' },
  { value: 'orthopaedics', label: 'Orthopaedics' },
  { value: 'paediatrics', label: 'Paediatrics' },
  { value: 'plastic_surgery', label: 'Plastic Surgery' },
  { value: 'psychiatry', label: 'Psychiatry' },
  { value: 'pulmonology', label: 'Pulmonology' },
  { value: 'trauma', label: 'Trauma' },
  { value: 'urology', label: 'Urology' },
];

/**
 * The subset a dispatch decision can actually turn on.
 *
 * A facility with no psychiatrist is not a coverage gap for emergency transport;
 * one with no trauma surgeon is. Listing all nineteen as gaps would cry wolf on
 * every hospital and make the warning worth ignoring.
 */
const EMERGENCY_SPECIALTIES = [
  'trauma',
  'cardiology',
  'critical_care',
  'neurology',
  'neurosurgery',
  'obstetrics',
  'paediatrics',
  'general_surgery',
  'burns',
  'pulmonology',
];

interface DoctorDraft {
  id?: number;
  full_name: string;
  specialty: string;
  designation: string;
  registration_no: string;
  shift_window: string;
  on_duty: boolean;
  accepts_emergency: boolean;
}

function defaultDoctor(): DoctorDraft {
  return {
    full_name: '',
    specialty: 'general_medicine',
    designation: 'Consultant',
    registration_no: '',
    shift_window: '08:00 – 20:00',
    on_duty: true,
    accepts_emergency: true,
  };
}

function toDraft(doc: Doctor): DoctorDraft {
  return {
    id: doc.id,
    full_name: doc.full_name,
    specialty: doc.specialty,
    designation: doc.designation,
    registration_no: doc.registration_no ?? '',
    shift_window: doc.shift_window,
    on_duty: doc.on_duty,
    accepts_emergency: doc.accepts_emergency,
  };
}

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
  // Arriving from an inbox row ("Review inbound case") lands the reader on this
  // screen; the banner says which part of it they came for, because a ward desk
  // that has to hunt for the alert it just tapped is a ward desk on the phone.
  const params = useLocalSearchParams<{ focus?: string }>();
  const focusInbound = params.focus === 'inbound';
  const [answering, setAnswering] = useState<any | null>(null);
  const [acknowledged, setAcknowledged] = useState<Record<number, string>>({});
  const [draftDoctor, setDraftDoctor] = useState<DoctorDraft | null>(null);
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
  // Staff-scoped field: the API sends it to this ward and omits it elsewhere.
  // Default to empty so a ward that somehow loses the scope sees "no holds"
  // instead of a blank screen.
  const holds = detail?.active_holds ?? [];

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

  /**
   * The full-form update.
   *
   * Every field used to be sent through `Number(...)`, and `Number('')` is 0 —
   * not NaN, not an error, zero. So a clerk who opened the form to correct the
   * ICU count and left the other five boxes alone published "zero beds, zero
   * ventilators, zero blood units" for their entire facility, the trust engine
   * saw a large drop on three counters at once and quarantined it as an anomaly
   * — which is the only reason anybody noticed. On a quieter change it would
   * simply have been wrong in the directory.
   *
   * The fix is to treat an empty field as *absent* rather than as zero. The API
   * takes a partial body, so an untouched field is left out and the server keeps
   * what it had. The form also says which fields it is about to change, because
   * a partial update that silently does nothing is its own kind of confusing.
   */
  const changedFields = useMemo(() => {
    const map: Record<string, string> = {
      beds: 'beds_available',
      icu: 'icu_available',
      vent: 'ventilators_available',
      blood: 'blood_units',
      antivenom: 'antivenom_vials',
      waiting: 'ed_waiting',
    };
    return Object.entries(map)
      .filter(([field]) => String((form as any)[field]).trim() !== '')
      .map(([, apiField]) => apiField);
  }, [form]);

  const submitFull = async () => {
    if (!hospitalId) return;
    setBusy('full');
    setFlash(null);

    const unknown = Object.keys(form).filter((k) => String((form as any)[k]).trim() === '');
    if (unknown.length === Object.keys(form).length) {
      setFlash({
        tone: 'warm',
        title: 'Nothing to publish',
        body: 'Fill in at least one counter. Untouched boxes are left as they are rather than reset to zero.',
      });
      setBusy(null);
      return;
    }

    try {
      const body: Record<string, unknown> = {
        ed_congestion: capacity?.ed_congestion ?? 'moderate',
      };
      // Only the filled-in counters travel. See the note above: an omitted field
      // is "unchanged", and that is the difference between correcting one number
      // and wiping five.
      for (const [field, value] of Object.entries(form)) {
        const trimmed = String(value).trim();
        if (trimmed === '') continue;
        const parsed = Number(trimmed);
        if (!Number.isFinite(parsed) || parsed < 0) {
          setFlash({ tone: 'critical', title: 'Not a number', body: `“${trimmed}” is not a valid count.` });
          setBusy(null);
          return;
        }
        (body as any)[
          { beds: 'beds_available', icu: 'icu_available', vent: 'ventilators_available', blood: 'blood_units', antivenom: 'antivenom_vials', waiting: 'ed_waiting' }[
            field
          ]!
        ] = Math.round(parsed);
      }

      const res = await api.post<any>(`/hospitals/${hospitalId}/capacity`, body, { token });
      setFlash(
        res.accepted
          ? {
              tone: 'live',
              title: 'Update published',
              body: `${changedFields.length} counter${changedFields.length === 1 ? '' : 's'} written (${changedFields
                .map((f) => f.replace(/_/g, ' '))
                .join(', ')}) · trust ${res.trust.score} (${res.trust.band}).`,
            }
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

  /**
   * Answer an inbound alert.
   *
   * The ward previously had nowhere to reply: a notification arrived, and the
   * only way to say "that ICU bed is in fact occupied" was to telephone a
   * control room that had no field to record it in. The hold then sat until it
   * expired and the next shortlist for the *next* incident still showed the bed
   * as free. Both answers now exist, and the decline carries a structured reason
   * that is also used as a capacity correction.
   */
  const answerInbound = async (alert: any, response: 'accepted' | 'declined', reason?: string, note?: string) => {
    if (!hospitalId) return;
    setBusy(`inbound:${alert.incident_id}`);
    try {
      const res = await api.post<any>(
        `/incidents/${alert.incident_id}/facility-response`,
        { response, reason: reason ?? null, note: note ?? null },
        { token },
      );
      setAcknowledged((prev) => ({
        ...prev,
        [alert.incident_id]: response === 'accepted' ? 'accepted' : 'declined',
      }));
      setFlash(
        response === 'accepted'
          ? {
              tone: 'live',
              title: `${alert.reference} confirmed`,
              body: 'Dispatch can see that this ward has read the prep alert.',
            }
          : {
              tone: 'warm',
              title: `${alert.reference} declined`,
              body:
                `${res.released_holds} hold(s) released immediately and dispatch notified. ` +
                (res.capacity_corrected !== null && res.capacity_corrected !== undefined
                  ? 'The ICU count was corrected to zero, so the same mistake will not be repeated for another incident.'
                  : 'The reason has been recorded against the facility.'),
            },
      );
      setAnswering(null);
      await load(true);
    } catch (err) {
      setFlash({
        tone: 'critical',
        title: 'Could not send the answer',
        body: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Create or update a clinician.
   *
   * One handler for both because the API is one endpoint per verb and the only
   * difference is whether there is an id to send it to; splitting it would
   * duplicate the specialty validation, which is the part worth having once.
   */
  const saveDoctor = async () => {
    if (!hospitalId || !draftDoctor) return;
    if (draftDoctor.full_name.trim().length < 3) {
      setFlash({ tone: 'critical', title: 'Name required', body: 'Enter the clinician\'s full name.' });
      return;
    }
    setBusy('doctor');
    try {
      const body = {
        full_name: draftDoctor.full_name.trim(),
        specialty: draftDoctor.specialty,
        designation: draftDoctor.designation.trim() || 'Consultant',
        registration_no: draftDoctor.registration_no.trim() || null,
        shift_window: draftDoctor.shift_window.trim() || '08:00 – 20:00',
        on_duty: draftDoctor.on_duty,
        accepts_emergency: draftDoctor.accepts_emergency,
      };
      if (draftDoctor.id) {
        await api.patch(`/doctors/${draftDoctor.id}`, body, { token });
      } else {
        await api.post(`/doctors`, { ...body, hospital_id: hospitalId }, { token });
      }
      setFlash({
        tone: 'live',
        title: draftDoctor.id ? 'Roster updated' : 'Clinician added',
        body: `${body.full_name} is ${body.on_duty ? 'on duty now' : 'off duty'}. Dispatch sees this immediately.`,
      });
      setDraftDoctor(null);
      await load(true);
    } catch (err) {
      setFlash({ tone: 'critical', title: 'Could not save', body: err instanceof ApiError ? err.message : undefined });
    } finally {
      setBusy(null);
    }
  };

  const removeDoctor = async (doctor: Doctor) => {
    setBusy(`remove:${doctor.id}`);
    try {
      await api.del(`/doctors/${doctor.id}`, { token });
      setFlash({
        tone: 'warm',
        title: 'Removed from the roster',
        body: `${doctor.full_name} no longer counts towards this facility's specialist cover. Dispatcher shortlists drop them on the next rebuild.`,
      });
      await load(true);
    } catch (err) {
      setFlash({ tone: 'critical', title: 'Could not remove', body: err instanceof ApiError ? err.message : undefined });
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

  /**
   * Specialties the incident-matching chain can ask this facility for, minus the
   * ones nobody here covers. Surfaced because an empty specialty and a busy
   * specialty look identical from the dispatcher's side: both produce "no
   * specialist on duty", and only one of them is fixable.
   */
  const covered = new Set(doctors.map((d) => d.specialty));
  const specialtyGaps = DOCTOR_SPECIALTIES.filter(
    (sp) => EMERGENCY_SPECIALTIES.includes(sp.value) && !covered.has(sp.value),
  );

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

        {focusInbound && !inbound.length ? (
          <Banner
            tone="warm"
            icon="inbox"
            title="Nothing waiting at this desk"
            body="The case you opened from your inbox has already been answered, or its hold expired before you got here. The next inbound alert will appear here the moment dispatch routes a case to this facility."
          />
        ) : null}

        {inbound.length ? (
          <Card
            tone="critical"
            style={{
              gap: space.md,
              ...(focusInbound
                ? { borderWidth: 2, borderColor: t.status.critical.base }
                : null),
            }}
          >
            {focusInbound ? (
              <Banner
                tone="critical"
                icon="ambulance"
                title="From your inbox — this is the case you opened"
                body="Answer it here: accept to confirm the ward is preparing, or decline with a reason and the hold releases immediately."
              />
            ) : null}
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

                {acknowledged[alert.incident_id] ? (
                  <Row gap="xs" align="center">
                    <Icon
                      name={acknowledged[alert.incident_id] === 'accepted' ? 'check' : 'x'}
                      size={13}
                      color={
                        acknowledged[alert.incident_id] === 'accepted' ? t.status.live.base : t.status.warm.base
                      }
                    />
                    <Small
                      style={{ fontSize: 12, fontWeight: '600' }}
                      muted={false}
                    >
                      {acknowledged[alert.incident_id] === 'accepted'
                        ? 'Confirmed — dispatch has been told this ward is ready'
                        : 'Declined — hold released and dispatch notified'}
                    </Small>
                  </Row>
                ) : (
                  <Row gap="xs" style={{ flexWrap: 'wrap' }}>
                    <Button
                      label="We can receive"
                      icon="check"
                      size="sm"
                      variant="primary"
                      loading={busy === `inbound:${alert.incident_id}`}
                      onPress={() => answerInbound(alert, 'accepted')}
                    />
                    <Button
                      label="We cannot receive"
                      icon="x"
                      size="sm"
                      variant="secondary"
                      disabled={busy === `inbound:${alert.incident_id}`}
                      onPress={() => setAnswering(alert)}
                    />
                  </Row>
                )}

                {answering?.incident_id === alert.incident_id ? (
                  <View
                    style={{
                      marginTop: space.xs,
                      padding: space.md,
                      borderRadius: 8,
                      borderWidth: StyleSheet.hairlineWidth,
                      borderColor: t.line.base,
                      backgroundColor: t.bg.raised,
                      gap: space.sm,
                    }}
                  >
                    <Label>Why can this facility not receive {alert.reference}?</Label>
                    <Small muted style={{ fontSize: 11.5 }}>
                      The reason is recorded against this facility and, for a capacity reason, corrects the published
                      counter — so dispatch does not offer the same bed to the next incident.
                    </Small>
                    <Row gap="xs" style={{ flexWrap: 'wrap' }}>
                      {[
                        ['no_icu', 'No ICU bed'],
                        ['no_bed', 'No bed'],
                        ['no_ventilator', 'No ventilator'],
                        ['no_specialist', 'No specialist on site'],
                        ['theatre_unavailable', 'Theatre unavailable'],
                        ['diversion', 'On diversion'],
                        ['other', 'Other'],
                      ].map(([value, label]) => (
                        <Button
                          key={value}
                          label={label}
                          size="sm"
                          variant="ghost"
                          onPress={() => answerInbound(alert, 'declined', value)}
                        />
                      ))}
                    </Row>
                    <Button label="Cancel" size="sm" variant="ghost" onPress={() => setAnswering(null)} />
                  </View>
                ) : null}
              </Stack>
            ))}
          </Card>
        ) : null}

        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          {/* Quick update keypad ------------------------------------------- */}
          {/* minWidth:'100%' on a phone means "never share a line", which is
              right, but it also means "never shrink below the container" when
              the row has padding — 480/320 minimums inside a 360px viewport
              were the dashboard's overflow. Basis 100% + min 0 stacks the
              columns on a phone and lets them fill side by side on a desktop. */}
          <Stack gap="lg" style={{ flex: 2, minWidth: isDesktop ? 480 : 0, flexBasis: isDesktop ? 0 : '100%' }}>
            <Card style={{ gap: space.lg }}>
              <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
                <Stack gap="xxs" style={{ flexShrink: 1 }}>
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

            {/* Clinician roster --------------------------------------------- */}
            {/*
              The roster used to be read-only except for the on-duty switch: a
              hospital could mark a cardiologist on duty, and could not add one,
              correct a specialty typed wrong at onboarding, or remove somebody
              who had left. Every clinician on the platform therefore arrived
              through the seeder, which is why "no cardiologist on duty" was
              indistinguishable from "nobody has ever entered the cardiologist".

              Specialty is the field that matters most here — the matching chain
              starts at the specialty the incident needs — so it is a closed
              list rather than free text, drawn from the same catalogue the
              dispatcher's shortlist uses.
            */}
            <Card style={{ gap: space.md }}>
              <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
                <Stack gap="xxs" style={{ flexShrink: 1 }}>
                  <Heading>Clinician roster</Heading>
                  <Small muted style={{ fontSize: 12 }}>
                    On-duty status drives the dispatcher's specialist view and the public directory.
                  </Small>
                </Stack>
                <Row gap="sm" align="center">
                  <Pill
                    label={`${doctors.filter((d) => d.on_duty).length} of ${doctors.length} on duty`}
                    tone={doctors.some((d) => d.on_duty) ? 'live' : 'warm'}
                    compact
                  />
                  <Button label="Add clinician" icon="plus" size="sm" onPress={() => setDraftDoctor(defaultDoctor())} />
                </Row>
              </Row>

              {specialtyGaps.length ? (
                <Banner
                  tone="warm"
                  icon="alert"
                  title={`${specialtyGaps.length} specialty${specialtyGaps.length === 1 ? '' : 'ies'} covered by nobody`}
                  body={`${specialtyGaps
                    .slice(0, 4)
                    .map((s) => s.label)
                    .join(', ')}${specialtyGaps.length > 4 ? ` and ${specialtyGaps.length - 4} more` : ''}. A dispatcher searching for these will not find this facility, whatever its bed count says.`}
                />
              ) : null}

              {draftDoctor ? (
                <View
                  style={{
                    padding: space.md,
                    borderRadius: 8,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.accent.base,
                    backgroundColor: t.bg.raised,
                    gap: space.sm,
                  }}
                >
                  <Label>{draftDoctor.id ? `Editing ${draftDoctor.full_name}` : 'New clinician'}</Label>
                  <Row gap="md" wrap>
                    <TextField
                      label="Name"
                      value={draftDoctor.full_name}
                      onChangeText={(v) => setDraftDoctor((d) => ({ ...(d as DoctorDraft), full_name: v }))}
                      style={{ flex: 2, minWidth: 180 }}
                    />
                    <TextField
                      label="Registration no."
                      value={draftDoctor.registration_no}
                      onChangeText={(v) => setDraftDoctor((d) => ({ ...(d as DoctorDraft), registration_no: v }))}
                      style={{ flex: 1, minWidth: 140 }}
                    />
                  </Row>
                  <Row gap="md" wrap>
                    <TextField
                      label="Designation"
                      value={draftDoctor.designation}
                      onChangeText={(v) => setDraftDoctor((d) => ({ ...(d as DoctorDraft), designation: v }))}
                      style={{ flex: 1, minWidth: 160 }}
                    />
                    {/* #27: this was a free-text box with a placeholder of
                        "08:00 – 20:00", so a typo produced a shift window no
                        scheduler could parse and no reader could trust. Shifts
                        are one of six things in this state's hospitals; a picker
                        cannot produce the seventh. */}
                    <Stack gap={4} style={{ flex: 1, minWidth: 220 }}>
                      <Label>Shift window</Label>
                      <Row gap={6} wrap>
                        {SHIFT_PRESETS.map((w) => (
                          <Button
                            key={w}
                            label={w}
                            size="sm"
                            variant={draftDoctor.shift_window === w ? 'primary' : 'ghost'}
                            onPress={() => setDraftDoctor((d) => ({ ...(d as DoctorDraft), shift_window: w }))}
                          />
                        ))}
                      </Row>
                    </Stack>
                  </Row>

                  <Stack gap="xs">
                    <Label>Specialty — drives matching</Label>
                    <Row gap="xs" style={{ flexWrap: 'wrap' }}>
                      {DOCTOR_SPECIALTIES.map((sp) => (
                        <Button
                          key={sp.value}
                          label={sp.label}
                          size="sm"
                          variant={draftDoctor.specialty === sp.value ? 'primary' : 'ghost'}
                          onPress={() => {
                            const holdsEmergency = EMERGENCY_SPECIALTIES.includes(sp.value);
                            setDraftDoctor((d) => ({
                              ...(d as DoctorDraft),
                              specialty: sp.value,
                              accepts_emergency: holdsEmergency ? (d as DoctorDraft).accepts_emergency : false,
                            }));
                          }}
                        />
                      ))}
                    </Row>
                  </Stack>

                  <Row gap="lg" align="center" style={{ flexWrap: 'wrap' }}>
                    <SwitchRow
                      label="On duty now"
                      value={draftDoctor.on_duty}
                      onChange={(v) => setDraftDoctor((d) => ({ ...(d as DoctorDraft), on_duty: v }))}
                    />
                    <SwitchRow
                      label="Accepts emergency referrals"
                      value={draftDoctor.accepts_emergency}
                      onChange={(v) => setDraftDoctor((d) => ({ ...(d as DoctorDraft), accepts_emergency: v }))}
                    />
                  </Row>

                  <Row gap="xs" justify="flex-end">
                    <Button label="Cancel" size="sm" variant="ghost" onPress={() => setDraftDoctor(null)} />
                    <Button label="Save" size="sm" variant="primary" loading={busy === 'doctor'} onPress={saveDoctor} />
                  </Row>
                </View>
              ) : null}

              <Stack gap={0}>
                {doctors.map((doc, i) => (
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
                      <Row gap={space.sm} align="center" wrap>
                        <Body style={{ fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>
                          {doc.full_name}
                        </Body>
                        {/* #26: the row used to carry a bare switch, so the only
                            statement about whether this clinician is here was
                            the switch's position — and the switch showed the
                            stored roster flag, which stays up after the window
                            closes until the sweep runs. The badge is the same
                            component the public directory uses, computed on
                            read. */}
                        <DutyBadge doctor={doc} compact emergency={doc.accepts_emergency} />
                      </Row>
                      <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
                        {specialtyLabel(doc.specialty)} · {doc.designation} · {doc.shift_window}
                        {doc.roster_flag && !doc.on_duty ? ' · roster flag still up, window closed' : ''}
                      </Small>
                    </Stack>
                    <Button
                      label={doc.on_duty ? 'End duty' : 'Start duty'}
                      size="sm"
                      variant={doc.on_duty ? 'secondary' : 'primary'}
                      onPress={() => toggleDuty(doc)}
                      loading={busy === `doc:${doc.id}`}
                    />
                    <Button label="Edit" size="sm" variant="ghost" onPress={() => setDraftDoctor(toDraft(doc))} />
                    <Button
                      label="Remove"
                      size="sm"
                      variant="ghost"
                      loading={busy === `remove:${doc.id}`}
                      onPress={() => removeDoctor(doc)}
                    />
                  </Row>
                ))}
                {doctors.length === 0 ? (
                  <View style={{ paddingVertical: space.lg }}>
                    <Small muted>
                      No clinicians recorded. Dispatch will rank this facility on capacity alone, and the public
                      directory will show no specialists on duty.
                    </Small>
                  </View>
                ) : null}
              </Stack>
            </Card>
          </Stack>

          {/* Right rail ---------------------------------------------------- */}
          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 320 : 0, flexBasis: isDesktop ? 0 : '100%' }}>
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
                action={<Num size={12} color={t.fg.muted}>{holds.length}</Num>}
              />
              {holds.length === 0 ? (
                <Small muted style={{ fontSize: 12 }}>
                  No ambulance has reserved one of your beds. Holds appear here with a countdown and release
                  automatically.
                </Small>
              ) : (
                holds.map((h) => (
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
                  <Row key={`${h.t}-${i}`} justify="space-between" align="center" gap="sm" wrap>
                    {/* shrink + wrap: the source/congestion line is text that
                        must give way before the figures do — the row was the
                        widest element in the right rail at 360px. */}
                    <Stack gap="xxs" style={{ flexShrink: 1 }}>
                      <Num size={11.5} color={t.fg.muted}>
                        {new Date(h.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
                      </Num>
                      <Small muted style={{ fontSize: 10.5 }} numberOfLines={2}>
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
