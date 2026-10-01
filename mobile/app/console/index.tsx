import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, ApiError } from '../../src/api/client';
import { LocationPicker, type IncidentLocation } from '../../src/components/LocationPicker';
import { DistrictField, type PickerDistrict } from '../../src/components/Selectors';
import type { Ambulance, District, Incident } from '../../src/api/types';
import { categoryLabel, clockTime, elapsed, relativeFromIso, STATUS_LABELS } from '../../src/lib/format';
import { MapSurface } from '../../src/components/MapSurface';
import type { MapPoint } from '../../src/components/mapTypes';
import { useAuth } from '../../src/state/AuthProvider';
import { useLive } from '../../src/state/LiveProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { radius, space, urgencyStatus } from '../../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  EmptyState,
  Heading,
  Label,
  Loading,
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
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';
import { AppShell } from '../../src/ui/Shell';
import { useResponsive } from '../../src/ui/useResponsive';

const PATIENT_STATES = [
  { value: 'alert', label: 'Alert' },
  { value: 'drowsy', label: 'Drowsy' },
  { value: 'unconscious_breathing', label: 'Unconscious · breathing' },
  { value: 'unconscious_not_breathing', label: 'Unconscious · not breathing' },
  { value: 'unknown', label: 'Not reported' },
];

const MECHANISMS = [
  { key: 'none', label: 'Medical' },
  { key: 'two_wheeler', label: 'Two-wheeler' },
  { key: 'car', label: 'Car' },
  { key: 'pedestrian', label: 'Pedestrian struck' },
  { key: 'heavy_vehicle', label: 'Heavy vehicle' },
  { key: 'fall_low', label: 'Fall from standing' },
  { key: 'fall_height', label: 'Fall from height' },
  { key: 'assault', label: 'Assault' },
  { key: 'machinery', label: 'Machinery' },
  { key: 'other', label: 'Other' },
];

const HAZARDS = [
  { value: 'none', label: 'None' },
  { value: 'traffic_active', label: 'Live traffic' },
  { value: 'fire', label: 'Fire' },
  { value: 'chemical', label: 'Chemical' },
  { value: 'electrical', label: 'Electrical' },
  { value: 'confined_space', label: 'Confined space' },
];

const OBSERVATION_FLAGS = [
  { key: 'chest_pain', label: 'Chest pain' },
  { key: 'breathlessness', label: 'Breathless' },
  { key: 'seizure', label: 'Seizure' },
  { key: 'paralysis_one_side', label: 'One-sided weakness' },
  { key: 'slurred_speech', label: 'Slurred speech' },
  { key: 'severe_headache', label: 'Severe headache' },
  { key: 'abdominal_pain', label: 'Abdominal pain' },
  { key: 'vomiting', label: 'Vomiting' },
  { key: 'fever', label: 'Fever' },
  { key: 'burns_surface', label: 'Burns' },
  { key: 'inhalation_smoke', label: 'Smoke inhalation' },
  { key: 'snakebite_swelling', label: 'Bite with swelling' },
  { key: 'suspected_fracture', label: 'Suspected fracture' },
  { key: 'limb_deformity', label: 'Limb deformity' },
  { key: 'obstetric_labour', label: 'In labour' },
  { key: 'postpartum_bleeding', label: 'Postpartum bleeding' },
  { key: 'dialysis_missed', label: 'Missed dialysis' },
  { key: 'poison_ingested', label: 'Poison ingested' },
];

const CATEGORIES = [
  { key: 'road_accident', label: 'Road accident' },
  { key: 'cardiac', label: 'Cardiac' },
  { key: 'stroke', label: 'Stroke' },
  { key: 'burns', label: 'Burns' },
  { key: 'obstetric', label: 'Obstetric' },
  { key: 'paediatric', label: 'Paediatric' },
  { key: 'snakebite', label: 'Snakebite' },
  { key: 'poisoning', label: 'Poisoning' },
  { key: 'respiratory', label: 'Respiratory' },
  { key: 'trauma_fall', label: 'Fall / trauma' },
  { key: 'dialysis', label: 'Dialysis' },
  { key: 'other', label: 'Other' },
];

export default function ConsoleScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { user, token } = useAuth();
  const { subscribe, connected } = useLive();
  const { isDesktop } = useResponsive();

  const [incidents, setIncidents] = useState<Incident[] | null>(null);
  const [fleet, setFleet] = useState<Ambulance[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [filter, setFilter] = useState<'active' | 'open' | 'all'>('active');
  const [refreshing, setRefreshing] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Intake form state
  const [category, setCategory] = useState('road_accident');
  const [landmark, setLandmark] = useState('');
  const [districtId, setDistrictId] = useState<string>('');
  const [location, setLocation] = useState<IncidentLocation | null>(null);
  const [taluk, setTaluk] = useState('');
  const [urgency, setUrgency] = useState<'P1' | 'P2' | 'P3'>('P1');
  // Structured scene assessment. Every field is a closed set drawn from the
  // server's enums, so nothing typed here can become a stored identifier. The
  // resource requirement is derived server-side from these and shown back to
  // the operator rather than being guessed at by the client.
  const [scene, setScene] = useState({
    patient_state: 'unknown',
    mechanism: 'none',
    bleeding: 'none',
    hazard: 'none',
    casualty_count: 1,
    trapped: false,
    bystander_cpr: false,
  });
  const [observations, setObservations] = useState<string[]>([]);
  const [derived, setDerived] = useState<{ rationale: string[]; scene_advisories: string[] } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [intakeError, setIntakeError] = useState<string | null>(null);
  /**
   * Triage detail is collapsed by default.
   *
   * The audit's finding was not that any one field was wrong but that the form
   * made an operator answer seventeen questions before the record existed, and
   * that the button which finally did it was called "Run matching" — an
   * algorithm's name for the act of raising an emergency. Emergency type,
   * priority and location are what a call-taker has within the first fifteen
   * seconds; everything else is filled in as the call continues, or afterwards
   * from the crew's report. Nothing here is required, and the server derives the
   * resource requirement from whatever is supplied.
   */
  const [triageOpen, setTriageOpen] = useState(false);

  const load = async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      // allSettled, not all: one endpoint failing must not blank the other two.
      // A dispatcher whose incident queue 401s still needs the district list to
      // raise a new call from.
      const [incs, amb, dist] = await Promise.allSettled([
        api.get<{ results: Incident[] }>('/incidents?limit=80', { token }),
        api.get<{ results: Ambulance[]; available: number }>('/ambulances', { token }),
        api.get<{ results: District[] }>('/hospitals/districts'),
      ]);

      if (incs.status === 'fulfilled') setIncidents(incs.value.results);
      if (amb.status === 'fulfilled') setFleet(amb.value.results);
      if (dist.status === 'fulfilled') {
        setDistricts(dist.value.results);
        // Default to the operator's own jurisdiction rather than to whatever
        // happens to sort first. A Coimbatore dispatcher raising a Coimbatore
        // call should not have to correct the district every time -- and getting
        // it wrong is not a cosmetic error, it scopes the whole search.
        if (!districtId && dist.value.results.length) {
          const own = user?.district_id;
          const match = own ? dist.value.results.find((d) => d.id === own) : null;
          setDistrictId(String((match ?? dist.value.results[0]).id));
        }
      }

      const failures = [incs, amb, dist].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      setError(
        failures.length === 0
          ? null
          : failures.length === 3
            ? 'The dispatch API is unreachable.'
            : failures[0].reason instanceof ApiError
              ? failures[0].reason.message
              : 'Part of the console could not be loaded.',
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the incident queue');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push-driven refresh: new calls and status changes land without waiting for
  // the poll, which is the whole point of running a socket into this screen.
  useEffect(() => {
    const off = subscribe('*', (event) => {
      if (event.event.startsWith('incident.') || event.event === 'hold.placed' || event.event === 'hold.released') {
        load(true);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * District choices, jurisdiction first.
   *
   * A chip row of thirty-eight is unusable on a phone and the operator almost
   * always wants one of a handful -- their own district, plus its neighbours for
   * the cross-border calls that are routine at a border. The rest stay reachable
   * because a control room does take calls outside its own area, and hiding them
   * would force the wrong district to be picked instead.
   */
  const districtOptions = useMemo<PickerDistrict[]>(
    () =>
      districts.map((d) => ({
        id: d.id,
        name: d.name,
        name_ta: d.name_ta,
        headquarters: null,
        facilities: d.hospital_count ?? 0,
      })),
    [districts],
  );

  const visible = useMemo(() => {
    const list = incidents ?? [];
    if (filter === 'open') return list.filter((i) => i.status === 'open');
    if (filter === 'active') return list.filter((i) => i.status !== 'handed_over' && i.status !== 'closed' && i.status !== 'cancelled');
    return list;
  }, [incidents, filter]);

  const createIncident = async () => {
    // A location is mandatory now, and refusing early is the point: the previous
    // default meant an operator could raise an incident without ever answering
    // "where", and the platform would silently invent an answer.
    if (!location) {
      setIntakeError(
        'Set the incident location first. The shortlist is ranked by drive time from it, so an unset location produces a plan for the wrong journey.',
      );
      return;
    }
    setSubmitting(true);
    setIntakeError(null);
    try {
      const created = await api.post<
        Incident & { shortlist: any[]; derivation: { rationale: string[]; scene_advisories: string[] } }
      >(
        '/incidents',
        {
          category,
          urgency,
          // The caller's location, captured by the operator. This used to be
          // `districtLatLng(...)`, which put every incident in Coimbatore at the
          // district centre regardless of where the caller was — and since the
          // matching engine ranks hospitals by drive time *from this point*, a
          // call from Pollachi was matched as though it had come from the middle
          // of the city. See LocationPicker for the capture order.
          lat: location!.lat,
          lng: location!.lng,
          location_source: location!.source,
          taluk: taluk.trim() || null,
          landmark: landmark.trim() || 'Landmark pending — operator to confirm',
          district_id: Number(districtId),
          ...scene,
          observations,
          // No requires_* here on purpose: the server derives them from the
          // assessment and reports what it inferred. Sending false would
          // override the derivation, which is the opposite of what an operator
          // who has just ticked "not breathing" intends.
        },
        { token },
      );
      setComposerOpen(false);
      setLandmark('');
      setTaluk('');
      setLocation(null);
      setScene({
        patient_state: 'unknown',
        mechanism: 'none',
        bleeding: 'none',
        hazard: 'none',
        casualty_count: 1,
        trapped: false,
        bystander_cpr: false,
      });
      setObservations([]);
      router.push(`/console/${created.id}`);
    } catch (err) {
      setIntakeError(err instanceof ApiError ? err.message : 'Could not create the incident');
    } finally {
      setSubmitting(false);
    }
  };

  const availableFleet = fleet.filter((a) => a.status === 'available');

  /**
   * The fleet as a board, by trip stage (#34).
   *
   * The queue used to show eight units with a status word each and nothing
   * else: no sense of how many are actually movable, and no picture of where
   * the district's vehicles are. The counts answer "can I commit another unit
   * right now" at a glance; the map answers "which side of the district is it
   * on", which is the question behind every manual crew choice.
   */
  const stageCounts = useMemo(() => {
    const order = ['available', 'assigned', 'en_route', 'at_scene', 'transporting', 'at_hospital', 'out_of_service'] as const;
    return order.map((st) => ({ stage: st, n: fleet.filter((u) => u.status === st).length })).filter((r) => r.n > 0);
  }, [fleet]);

  const fleetPoints = useMemo<MapPoint[]>(
    () =>
      fleet
        .filter((u) => typeof u.lat === 'number' && typeof u.lng === 'number' && u.status !== 'out_of_service')
        .map((u) => {
          const ageSec = u.updated_at ? Math.max(0, (Date.now() - new Date(u.updated_at).getTime()) / 1000) : null;
          return {
            id: u.id,
            short_name: u.call_sign.replace(/^108-/, ''),
            name: u.call_sign,
            lat: u.lat as number,
            lng: u.lng as number,
            pin_override: FLEET_STAGE_TONE[u.status] ?? FLEET_STAGE_TONE.available,
            // A vehicle whose GPS is old is drawn as old: the ring says how much
            // to trust the dot, exactly as it does for facility capacity.
            freshness_override:
              ageSec === null ? 'unknown' : ageSec > 600 ? 'stale' : ageSec > 120 ? 'warming' : 'fresh',
          };
        }),
    [fleet],
  );
  const openCount = (incidents ?? []).filter((i) => i.status === 'open').length;
  const activeCount = (incidents ?? []).filter(
    (i) => !['handed_over', 'closed', 'cancelled'].includes(i.status),
  ).length;

  const composer = (
    <Card style={{ gap: space.md }}>
      <Row justify="space-between" align="center">
        <Stack gap="xxs">
          <Heading>New incident</Heading>
          <Small muted style={{ fontSize: 12 }}>
            Created while the call is still being taken
          </Small>
        </Stack>
        {!isDesktop ? (
          <Pressable onPress={() => setComposerOpen(false)} hitSlop={8}>
            <Icon name="x" size={18} color={t.fg.muted} />
          </Pressable>
        ) : null}
      </Row>

      {intakeError ? <Banner tone="critical" icon="alert" title="Rejected" body={intakeError} /> : null}

      <Stack gap="sm">
        <Label>Incident type</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {CATEGORIES.map((c) => {
            const active = c.key === category;
            return (
              <Pressable
                key={c.key}
                onPress={() => setCategory(c.key)}
                accessibilityRole="radio"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => ({
                  paddingVertical: 6,
                  paddingHorizontal: 10,
                  borderRadius: radius.sm,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: active ? t.accent.base : t.line.base,
                  backgroundColor: active ? t.accent.soft : t.bg.surface,
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <Text style={{ fontSize: 12.5, fontWeight: active ? '600' : '500', color: active ? t.accent.base : t.fg.base }}>
                  {c.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Stack>

      <Stack gap="sm">
        <Label>Priority</Label>
        <Segmented
          options={[
            { value: 'P1', label: 'P1 · lights & siren' },
            { value: 'P2', label: 'P2 · urgent' },
            { value: 'P3', label: 'P3 · stable' },
          ]}
          value={urgency}
          onChange={setUrgency}
          size="sm"
          scroll
        />
      </Stack>

      {/* Step 3 of four: where.
          District first, then landmark, then the coordinate capture, because the
          coordinate is scoped to the district (see LocationPicker) and asking
          for a pin before the district is known invites one in the wrong one.
          The chooser is a searchable list rather than a chip row: thirty-eight
          districts is a scroll no operator should have to perform, and the row
          gave no way to search. */}
      <DistrictField
        districts={districtOptions}
        value={districtId ? Number(districtId) : null}
        onChange={(id) => setDistrictId(String(id))}
        label="Incident district"
        hint="defaults to your own"
      />

      <TextField
        label="Landmark"
        value={landmark}
        onChangeText={setLandmark}
        placeholder="Street, junction, building or landmark"
        icon="pin"
        maxLength={200}
        hint="Read back to the caller. The crew navigates to this, and it is the only free text on the record."
      />

      <TextField
        label="Taluk / area"
        value={taluk}
        onChangeText={setTaluk}
        placeholder="e.g. Mettupalayam"
        icon="grid"
        maxLength={80}
        hint="Supporting detail. The coordinate leads; this confirms it."
      />

      <LocationPicker
        districts={districts}
        districtId={districtId}
        value={location}
        onChange={setLocation}
      />

      <Row gap="sm">
        <Button
          label="Create incident & find hospital"
          variant="primary"
          icon="siren"
          loading={submitting}
          onPress={createIncident}
          style={{ flex: 1 }}
        />
        {!isDesktop ? <Button label="Cancel" onPress={() => setComposerOpen(false)} /> : null}
      </Row>

      <Small muted style={{ fontSize: 11 }}>
        Raises the emergency record and ranks every facility in the region by capability, ETA, true free
        capacity, trust and current load — then opens the shortlist. Triage detail below can be added first,
        or left until the call is over.
      </Small>
    
      {/* Optional triage details -------------------------------------------
          Structured, not narrated. The report's intake requirement is a
          non-identifying condition category, and a call-taker under pressure is
          faster ticking six closed options than composing a sentence -- which
          is also why no narrative field is offered.

          Collapsed by default. The create button sits above this block, so a
          call-taker on a two-minute call creates the record from three answers
          and adds detail afterwards; a crew's own report fills in what was
          never known at the time. */}
      <Pressable
        onPress={() => setTriageOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: triageOpen }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: 10,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.line.base,
          backgroundColor: t.bg.sunken,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Row gap="sm" align="center">
          <Icon name={triageOpen ? 'chevronUp' : 'chevronDown'} size={15} color={t.fg.muted} />
          <Body style={{ fontSize: 13, fontWeight: '600' }}>Optional triage details</Body>
        </Row>
        <Small muted style={{ fontSize: 11 }}>
          {observations.length || scene.patient_state !== 'unknown' || scene.mechanism !== 'none'
            ? `${observations.length} flag${observations.length === 1 ? '' : 's'} recorded`
            : 'not required to create the record'}
        </Small>
      </Pressable>

      {triageOpen ? (
        <>
      <Stack gap="sm">
        <Label>Patient condition</Label>
        <Segmented
          options={PATIENT_STATES}
          value={scene.patient_state}
          onChange={(v) => setScene((p) => ({ ...p, patient_state: v }))}
          size="sm"
          scroll
        />
      </Stack>

      <Stack gap="sm">
        <Label>What happened</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {MECHANISMS.map((m) => {
            const active = m.key === scene.mechanism;
            return (
              <Pressable
                key={m.key}
                onPress={() => setScene((p) => ({ ...p, mechanism: m.key }))}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: radius.md,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: active ? t.accent.base : t.line.base,
                  backgroundColor: active ? t.accent.soft : t.bg.surface,
                }}
              >
                <Small style={{ fontSize: 12, color: active ? t.accent.base : t.fg.base, fontWeight: active ? '600' : '400' }}>
                  {m.label}
                </Small>
              </Pressable>
            );
          })}
        </View>
      </Stack>

      <Row gap="md" wrap>
        <Stack gap="xs" style={{ flex: 1, minWidth: 150 }}>
          <Label>Bleeding</Label>
          <Segmented
            options={[
              { value: 'none', label: 'None' },
              { value: 'minor', label: 'Minor' },
              { value: 'severe', label: 'Severe' },
            ]}
            value={scene.bleeding}
            onChange={(v) => setScene((p) => ({ ...p, bleeding: v }))}
            size="sm"
          />
        </Stack>
        <Stack gap="xs" style={{ flex: 1, minWidth: 150 }}>
          <Label>Scene hazard</Label>
          <Segmented
            options={HAZARDS}
            value={scene.hazard}
            onChange={(v) => setScene((p) => ({ ...p, hazard: v }))}
            size="sm"
            scroll
          />
        </Stack>
      </Row>

      <Stack gap="sm">
        <Label>Reported presentation</Label>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {OBSERVATION_FLAGS.map((o) => {
            const active = observations.includes(o.key);
            return (
              <Pressable
                key={o.key}
                onPress={() =>
                  setObservations((prev) =>
                    active ? prev.filter((x) => x !== o.key) : [...prev, o.key].slice(0, 8),
                  )
                }
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 6,
                  borderRadius: radius.md,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: active ? t.accent.base : t.line.base,
                  backgroundColor: active ? t.accent.soft : t.bg.surface,
                }}
              >
                <Small style={{ fontSize: 12, color: active ? t.accent.base : t.fg.base, fontWeight: active ? '600' : '400' }}>
                  {o.label}
                </Small>
              </Pressable>
            );
          })}
        </View>
      </Stack>

      <Row gap="md" wrap>
        <Stack gap="xs" style={{ flex: 1, minWidth: 140 }}>
          <Label>Casualties at scene</Label>
          <Segmented
            options={[
              { value: '1', label: '1' },
              { value: '2', label: '2' },
              { value: '3', label: '3' },
              { value: '5', label: '4+' },
            ]}
            value={String(scene.casualty_count)}
            onChange={(v) => setScene((p) => ({ ...p, casualty_count: Number(v) }))}
            size="sm"
          />
        </Stack>
        <Stack gap="xs" style={{ flex: 1, minWidth: 160 }}>
          <SwitchRow
            label="Trapped / needs extrication"
            value={scene.trapped}
            onChange={(v) => setScene((p) => ({ ...p, trapped: v }))}
          />
          <SwitchRow
            label="Bystander CPR in progress"
            value={scene.bystander_cpr}
            onChange={(v) => setScene((p) => ({ ...p, bystander_cpr: v }))}
            tone="critical"
          />
        </Stack>
      </Row>

      <Card style={{ backgroundColor: t.bg.sunken, gap: space.xs }}>
        <Row justify="space-between" align="center">
          <Label>Derived requirement</Label>
          <Small muted style={{ fontSize: 10.5 }}>
            computed by the server from the assessment
          </Small>
        </Row>
        <Small muted style={{ fontSize: 11.5 }}>
          ICU, ventilator and blood requirements are inferred from what is ticked above and shown
          on the incident once it is created. An explicit instruction from the receiving clinician
          overrides the inference.
        </Small>
      </Card>
        </>
      ) : null}

</Card>
  );

  return (
    <AppShell
      title="108 dispatch console"
      subtitle={`${activeCount} active · ${openCount} awaiting assignment · ${availableFleet.length} units available`}
      maxWidth={1440}
      actions={
        !isDesktop ? (
          <Button label="New call" icon="plus" variant="primary" size="sm" onPress={() => setComposerOpen(true)} />
        ) : (
          <Pill
            label={connected ? 'feed live' : 'feed down'}
            tone={connected ? 'live' : 'stale'}
            icon={connected ? 'wifi' : 'wifiOff'}
            compact
          />
        )
      }
      footerNote="Incident records contain no patient identifiers, by construction: every clinical field is a closed set of observations, so there is no field for a name, age or contact number to be typed into. The landmark is the only free text and is validated as a place."
      scroll={false}
    >
      {!isDesktop && composerOpen ? (
        <ScrollView contentContainerStyle={{ padding: 12, gap: 12 }}>{composer}</ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
        >
          {error ? <Banner tone="critical" icon="alert" title="Queue unavailable" body={error} /> : null}

          <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
            {/* Queue ---------------------------------------------------- */}
            <Stack gap="md" style={{ flex: 2, minWidth: isDesktop ? 460 : '100%' }}>
              <Row justify="space-between" align="center" gap="md" style={{ flexWrap: 'wrap' }}>
                <Segmented
                  options={[
                    { value: 'active', label: 'Active', count: activeCount },
                    { value: 'open', label: 'Awaiting match', count: openCount },
                    { value: 'all', label: 'All', count: incidents?.length },
                  ]}
                  value={filter}
                  onChange={setFilter}
                  size="sm"
                />
                <Small muted style={{ fontSize: 11.5 }}>
                  {user?.district_name ? `${user.district_name} circle` : 'All districts'} · auto-refresh 30s
                </Small>
              </Row>

              {incidents === null ? (
                <Loading label="Loading incident queue…" />
              ) : visible.length === 0 ? (
                <EmptyState
                  icon="check"
                  title="No incidents in this view"
                  body="Nothing is waiting on a placement decision. New calls appear here the moment the intake form is submitted."
                />
              ) : (
                <Stack gap="sm">
                  {visible.map((incident) => (
                    <IncidentCard
                      key={incident.id}
                      incident={incident}
                      onPress={() => router.push(`/console/${incident.id}`)}
                    />
                  ))}
                </Stack>
              )}
            </Stack>

            {/* Composer + fleet ---------------------------------------- */}
            <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 340 : '100%' }}>
              {isDesktop ? composer : null}

              <Card style={{ gap: space.md }}>
                <SectionHeader
                  label="Fleet"
                  action={
                    <Pill
                      label={`${availableFleet.length} free`}
                      tone={availableFleet.length > 3 ? 'live' : 'warm'}
                      compact
                    />
                  }
                />
                <Row gap={6} wrap>
                  {stageCounts.map((r) => (
                    <Pill
                      key={r.stage}
                      label={`${r.n} ${r.stage.replace(/_/g, ' ')}`}
                      tone={r.stage === 'available' ? 'live' : r.stage === 'out_of_service' ? 'stale' : 'info'}
                      compact
                    />
                  ))}
                </Row>

                {fleetPoints.length ? (
                  <Stack gap={6}>
                    <MapSurface points={fleetPoints} height={210} showLegend={false} showLabels={false} />
                    <Row gap={space.md} wrap align="center">
                      {([
                        ['available', 'Available'],
                        ['assigned', 'Assigned'],
                        ['en_route', 'En route'],
                        ['at_scene', 'At scene'],
                        ['transporting', 'Transporting'],
                        ['at_hospital', 'At hospital'],
                      ] as const).map(([st, label]) => (
                        <Row key={st} gap={4} align="center">
                          <View
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: 4,
                              backgroundColor: FLEET_STAGE_TONE[st].fill,
                            }}
                          />
                          <Small muted style={{ fontSize: 10.5 }}>
                            {label}
                          </Small>
                        </Row>
                      ))}
                      <Small muted style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                        Ring = GPS age
                      </Small>
                    </Row>
                  </Stack>
                ) : null}

                <Stack gap={0}>
                  {fleet.slice(0, 8).map((unit, i) => (
                    <Row
                      key={unit.id}
                      justify="space-between"
                      align="center"
                      gap="sm"
                      style={{
                        paddingVertical: 8,
                        borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                        borderTopColor: t.line.subtle,
                      }}
                    >
                      <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                        <Num size={12.5}>{unit.call_sign}</Num>
                        <Small muted style={{ fontSize: 11 }} numberOfLines={1}>
                          {unit.capability_label} · {unit.operator_name}
                          {unit.updated_at ? ` · GPS ${relativeFromIso(unit.updated_at)}` : ''}
                        </Small>
                      </Stack>
                      <Pill
                        label={unit.status.replace(/_/g, ' ')}
                        tone={
                          unit.status === 'available'
                            ? 'live'
                            : unit.status === 'out_of_service'
                              ? 'stale'
                              : 'info'
                        }
                        compact
                      />
                    </Row>
                  ))}
                </Stack>
                {fleet.length > 8 ? (
                  <Small muted style={{ fontSize: 11 }}>
                    + {fleet.length - 8} more units across the region
                  </Small>
                ) : null}
              </Card>
            </Stack>
          </Row>
        </ScrollView>
      )}
    </AppShell>
  );
}

/**
 * Fleet stage colours (#34).
 *
 * Deliberately not the facility palette: this map answers "where are my
 * vehicles and what are they doing", and reusing the capacity colours would
 * make a green ambulance read as "ICU free". Green means movable, amber means
 * committed to a call, the deeper amber means hands on the patient, grey means
 * the vehicle is out of the picture.
 */
const FLEET_STAGE_TONE: Record<string, { fill: string; ring: string; label: string }> = {
  available: { fill: '#137547', ring: '#0e5c37', label: 'Available' },
  assigned: { fill: '#3f6ea5', ring: '#2f5480', label: 'Assigned' },
  en_route: { fill: '#8a5a00', ring: '#6d4700', label: 'En route' },
  at_scene: { fill: '#a3560f', ring: '#7d420b', label: 'At scene' },
  transporting: { fill: '#a32217', ring: '#7d1a12', label: 'Transporting' },
  at_hospital: { fill: '#5b6472', ring: '#454c57', label: 'At hospital' },
  out_of_service: { fill: '#8b93a1', ring: '#6d7480', label: 'Out of service' },
};

/* -------------------------------------------------------------- incident card */

function IncidentCard({ incident, onPress }: { incident: Incident; onPress: () => void }) {
  const { t } = useTheme();
  const urgencyTone = urgencyStatus(incident.urgency);
  const isOpen = incident.status === 'open';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        backgroundColor: t.bg.surface,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: isOpen ? `${t.status.critical.base}55` : t.line.base,
        padding: space.lg,
        gap: space.sm,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <Row justify="space-between" align="flex-start" gap="sm">
        <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <Row gap="sm" align="center">
            <Num size={12.5} color={t.fg.muted}>
              {incident.reference}
            </Num>
            <Pill label={incident.urgency} tone={urgencyTone} compact />
            {isOpen ? <Pill label="needs match" tone="critical" compact icon="alert" /> : null}
          </Row>
          <Title style={{ fontSize: 16 }}>{incident.category_label}</Title>
          <Row gap="xs" align="center">
            <Icon name="pin" size={13} color={t.fg.faint} />
            <Small muted numberOfLines={1} style={{ flex: 1 }}>
              {incident.landmark}
            </Small>
          </Row>
        </Stack>

        <Stack gap="xs" align="flex-end">
          <Num size={15} color={isOpen ? t.status.critical.base : t.fg.base}>
            {elapsed(incident.elapsed_seconds)}
          </Num>
          <Label style={{ fontSize: 9.5 }}>elapsed</Label>
        </Stack>
      </Row>

      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line.subtle }} />

      <Row justify="space-between" align="center" gap="sm">
        <Row gap="xs" wrap style={{ flex: 1 }}>
          <Pill label={STATUS_LABELS[incident.status] ?? incident.status} tone={isOpen ? 'critical' : 'info'} compact />
          {incident.requires.icu ? <Pill label="ICU" tone="critical" compact outline /> : null}
          {incident.requires.ventilator ? <Pill label="Vent" tone="warm" compact outline /> : null}
          {incident.requires.blood ? <Pill label="Blood" tone="info" compact outline /> : null}
        </Row>
        <Icon name="chevronRight" size={16} color={t.fg.faint} />
      </Row>

      {incident.assigned_hospital ? (
        <Row gap="xs" align="center">
          <Icon name="ambulance" size={13} color={t.accent.base} />
          <Small style={{ fontSize: 12, color: t.accent.base }} numberOfLines={1}>
            {incident.assigned_ambulance?.call_sign ?? 'Unit'} → {incident.assigned_hospital.short_name} · dispatched{' '}
            {clockTime(incident.dispatched_at)}
          </Small>
        </Row>
      ) : null}
    </Pressable>
  );
}
