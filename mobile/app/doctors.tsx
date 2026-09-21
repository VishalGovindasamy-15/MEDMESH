import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api } from '../src/api/client';
import type { District, Doctor } from '../src/api/types';
import { specialtyLabel } from '../src/lib/format';
import { useTheme } from '../src/theme/ThemeProvider';
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
              <Label>District</Label>
              <Segmented
                options={[
                  { value: 'all', label: 'All' },
                  ...districts.map((d) => ({ value: String(d.id), label: d.name })),
                ]}
                value={districtId}
                onChange={setDistrictId}
                size="sm"
                scroll
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
                      <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                        <Row gap="xs" align="center">
                          <View
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: 3,
                              backgroundColor: d.on_duty ? t.status.live.base : t.fg.faint,
                            }}
                          />
                          <Body style={{ fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>
                            {d.full_name}
                          </Body>
                        </Row>
                        <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
                          {specialtyLabel(d.specialty)} · {d.designation}
                        </Small>
                      </Stack>
                      <Stack gap="xxs" align="flex-end">
                        <Num size={11.5} color={t.fg.muted}>
                          {d.shift_window}
                        </Num>
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
