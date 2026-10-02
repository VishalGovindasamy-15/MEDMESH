import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api } from '../src/api/client';
import type { District, Doctor } from '../src/api/types';
import { specialtyLabel } from '../src/lib/format';
import { useLive } from '../src/state/LiveProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { DoctorPresence } from '../src/components/DutyPresence';
import { space } from '../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  EmptyState,
  Label,
  Loading,
  Num,
  Pill,
  Row,
  Segmented,
  Small,
  Stack,
  TextField,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';
import { useResponsive } from '../src/ui/useResponsive';
import { DistrictField } from '../src/components/Selectors';
import type { PickerDistrict } from '../src/components/DistrictPicker';

interface SpecialtyOption {
  key: string;
  label: string;
  doctors: number;
  hospitals: number;
}

export default function DoctorsScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { isDesktop, columns } = useResponsive();
  const { subscribe } = useLive();

  const [doctors, setDoctors] = useState<Doctor[] | null>(null);
  const [specialties, setSpecialties] = useState<SpecialtyOption[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [specialty, setSpecialty] = useState<string>('all');
  const [districtId, setDistrictId] = useState<string>('all');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [onDutyOnly, setOnDutyOnly] = useState(true);
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = async () => {
    setRefreshing(true);
    try {
      const [docs, specs, dist] = await Promise.all([
        api.get<{ count: number; results: Doctor[] }>(`/doctors?on_duty_only=${onDutyOnly}&limit=300`),
        api.get<{ results: SpecialtyOption[] }>('/hospitals/specialties'),
        api.get<{ results: District[] }>('/hospitals/districts'),
      ]);
      setDoctors(docs.results);
      setSpecialties(specs.results.filter((s) => s.doctors > 0));
      setDistricts(dist.results);
    } catch {
      setDoctors([]);
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDutyOnly]);

  /**
   * Follow duty changes without waiting for a refresh.
   *
   * The directory is the one screen a member of the public uses to answer "can
   * this hospital actually treat my father tonight", and a facility toggling a
   * consultant on duty is exactly the event that changes the answer. It used to
   * re-fetch only when the filter changed or the page was pulled down, so the
   * board could be a whole shift stale while the toggle that made it stale had
   * already been confirmed to the hospital administrator.
   *
   * The patch is applied in place rather than by re-fetching, because the
   * payload carries everything the row renders and a full reload on every duty
   * change across a 300-row directory would be both slow and visibly jumpy.
   */
  useEffect(() => {
    const off = subscribe('doctor.duty', (event) => {
      const payload = event.data as {
        doctor_id?: number;
        hospital_id?: number;
        removed?: boolean;
        on_duty?: boolean;
      } | null;
      if (!payload?.doctor_id) return;

      setDoctors((current) => {
        if (!current) return current;
        const index = current.findIndex((d) => d.id === payload.doctor_id);
        if (index === -1) {
          // Not on screen. If they have just come on duty they may belong in
          // this filtered view, so pull once rather than guess at the row.
          if (payload.on_duty && onDutyOnly) void load();
          return current;
        }
        if (payload.removed || payload.on_duty === false) {
          // Gone from an on-duty-only board, kept (marked) when we are showing
          // the whole roster -- dropping the row there would look like data loss.
          return onDutyOnly ? current.filter((d) => d.id !== payload.doctor_id) : current;
        }
        return current.map((d, i) =>
          i === index ? { ...d, on_duty: true, duty_state: 'on_duty' } : d,
        );
      });

      // Counts on the specialty chips are server-derived, so they are refetched
      // rather than patched. A chip that says "12 cardiologists" after one of
      // them has gone off duty is the kind of small wrongness that erodes trust
      // in the whole board.
      void api
        .get<{ results: SpecialtyOption[] }>('/hospitals/specialties')
        .then((specs) => setSpecialties(specs.results.filter((x) => x.doctors > 0)))
        .catch(() => undefined);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDutyOnly]);

  const filtered = useMemo(() => {
    const list = doctors ?? [];
    const q = query.trim().toLowerCase();
    return list.filter((d) => {
      if (specialty !== 'all' && d.specialty !== specialty) return false;
      if (districtId !== 'all' && String(d.district?.id ?? '') !== districtId) return false;
      if (typeFilter !== 'all' && d.hospital?.type !== typeFilter) return false;
      if (q && !`${d.full_name} ${d.specialty} ${d.hospital?.name ?? ''}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [doctors, specialty, districtId, typeFilter, query]);

  // #7: the district control has to say what is behind each option. "All
  // districts" with the roster total, and a clinician count per district —
  // a dispatcher filtering at 2am wants to know which districts have anybody
  // on duty before they pick one.
  const pickerDistricts = useMemo<PickerDistrict[]>(() => {
    const perDistrict = new Map<number, number>();
    for (const d of doctors ?? []) {
      const id = d.district?.id;
      if (id == null) continue;
      perDistrict.set(id, (perDistrict.get(id) ?? 0) + 1);
    }
    return districts.map((x) => ({
      id: x.id,
      name: x.name,
      name_ta: x.name_ta,
      facilities: perDistrict.get(x.id) ?? 0,
      countUnit: 'clinicians',
    }));
  }, [districts, doctors]);

  // Group by facility — a dispatcher asks "who is at this hospital tonight",
  // not "give me an alphabetical list of cardiologists".
  const grouped = useMemo(() => {
    const map = new Map<string, { hospital: Doctor['hospital']; doctors: Doctor[] }>();
    for (const d of filtered) {
      const key = String(d.hospital?.id ?? 'unknown');
      if (!map.has(key)) map.set(key, { hospital: d.hospital, doctors: [] });
      map.get(key)!.doctors.push(d);
    }
    return Array.from(map.values()).sort((a, b) =>
      (a.hospital?.short_name ?? '').localeCompare(b.hospital?.short_name ?? ''),
    );
  }, [filtered]);

  return (
    <AppShell
      title="Specialist cover, right now"
      subtitle={`${filtered.length} clinician${filtered.length === 1 ? '' : 's'} across ${grouped.length} facilities`}
      maxWidth={1240}
      actions={<Button label="Directory" icon="hospital" size="sm" onPress={() => router.push('/')} />}
      footerNote="Only professional on-duty status is published. MedMesh holds no patient information and no personal contact details beyond the facility switchboard."
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} />}
      >
        <Banner
          tone="info"
          icon="info"
          title="Rosters are indicative"
          body="On-duty status comes from hospital roster systems where integrated, and from the facility's own duty toggle otherwise. Call the facility to confirm before transferring a time-critical patient."
        />

        <Stack gap="md">
          <Row gap="md" style={{ flexWrap: 'wrap' }}>
            <TextField
              value={query}
              onChangeText={setQuery}
              placeholder="Search by clinician, specialty or hospital"
              icon="search"
              autoCapitalize="none"
              style={{ flex: 1, minWidth: 220 }}
            />
            <Segmented
              options={[
                { value: 'on', label: 'On duty now' },
                { value: 'any', label: 'Full roster' },
              ]}
              value={onDutyOnly ? 'on' : 'any'}
              onChange={(v) => setOnDutyOnly(v === 'on')}
            />
          </Row>

          <Stack gap="sm">
            <Label>Specialty</Label>
            <Segmented
              options={[
                { value: 'all', label: 'All specialties', count: doctors?.length },
                ...specialties.map((s) => ({ value: s.key, label: s.label, count: s.doctors })),
              ]}
              value={specialty}
              onChange={setSpecialty}
              size="sm"
              scroll
            />
          </Stack>

          <Row gap="md" style={{ flexWrap: 'wrap' }}>
            <Stack gap="sm" style={{ flex: 1, minWidth: 220 }}>
              <Label>Facility type</Label>
              <Segmented
                options={[
                  { value: 'all', label: 'Any' },
                  { value: 'public', label: 'Government' },
                  { value: 'private', label: 'Private' },
                  { value: 'trust', label: 'Trust' },
                ]}
                value={typeFilter}
                onChange={setTypeFilter}
                size="sm"
                scroll
              />
            </Stack>
            <Stack gap="sm" style={{ flex: 1, minWidth: 220 }}>
              <DistrictField
                districts={pickerDistricts}
                value={districtId === 'all' ? null : Number(districtId)}
                onChange={(id) => setDistrictId(id == null ? 'all' : String(id))}
                countUnit="clinicians"
                label="District"
                placeholder={`All districts — ${doctors?.length ?? 0} ${onDutyOnly ? 'on duty' : 'clinicians'}`}
                allowClear
              />
            </Stack>
          </Row>
        </Stack>

        {doctors === null ? (
          <Loading label="Loading the roster…" />
        ) : grouped.length === 0 ? (
          <EmptyState
            icon="users"
            title="No clinician matches those filters"
            body="Try clearing the specialty filter or switching to the full roster — some facilities update their duty status only at shift change."
            action={
              <Button
                label="Reset"
                onPress={() => {
                  setSpecialty('all');
                  setDistrictId('all');
                  setTypeFilter('all');
                  setQuery('');
                }}
              />
            }
          />
        ) : (
          <View
            style={{
              flexDirection: 'row',
              flexWrap: 'wrap',
              gap: space.lg,
            }}
          >
            {grouped.map((group) => (
              <Card key={group.hospital?.id ?? 'unknown'} style={{ flexGrow: 1, flexBasis: isDesktop ? 380 : '100%', gap: space.md }}>
                <Row justify="space-between" align="flex-start" gap="sm">
                  <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                    <Body style={{ fontWeight: '600', fontSize: 14.5 }} numberOfLines={1}>
                      {group.hospital?.short_name}
                    </Body>
                    <Small muted numberOfLines={1} style={{ fontSize: 12 }}>
                      {group.hospital?.address}
                    </Small>
                  </Stack>
                  <Pill
                    label={group.hospital?.type === 'public' ? 'Govt' : group.hospital?.type === 'private' ? 'Private' : 'Trust'}
                    tone="neutral"
                    compact
                    outline
                  />
                </Row>

                <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line.subtle }} />

                <Stack gap="sm">
                  {group.doctors.map((d) => (
                    <Row key={d.id} justify="space-between" align="center" gap="md">
                      {/* Name, speciality, then the presence statement in
                          words. The green dot this replaces was the audit's
                          example of the same defect on four screens at once:
                          the smallest element on the card carried the answer
                          the card exists to give. */}
                      <DoctorPresence
                        name={d.full_name}
                        speciality={specialtyLabel(d.specialty)}
                        designation={d.designation}
                        doctor={d}
                        right={undefined}
                      />
                      <Stack gap="xxs" align="flex-end">
                        {d.accepts_emergency ? (
                          <Row gap="xxs" align="center">
                            <Icon name="pulse" size={10} color={t.status.live.base} />
                            <Label tone={t.status.live.base} style={{ fontSize: 9 }}>
                              emergency
                            </Label>
                          </Row>
                        ) : null}
                      </Stack>
                    </Row>
                  ))}
                </Stack>

                <Button
                  label={`Open ${group.hospital?.short_name ?? 'facility'}`}
                  size="sm"
                  iconRight="chevronRight"
                  onPress={() => group.hospital && router.push(`/facility/${group.hospital.id}`)}
                />
              </Card>
            ))}
          </View>
        )}

        <Small muted style={{ fontSize: 11.5 }}>
          Registration numbers are visible on each clinician's record at the facility. Specialties reflect declared
          departmental cover, not individual case acceptance.
        </Small>
      </ScrollView>
    </AppShell>
  );
}
