import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError, API_BASE } from '../../src/api/client';
import type { DistrictDetail } from '../../src/api/types';
import { ageFromSeconds, elapsed } from '../../src/lib/format';
import { useAuth } from '../../src/state/AuthProvider';
import { useLive } from '../../src/state/LiveProvider';
import { congestionStatus, useTheme } from '../../src/theme/ThemeProvider';
import { radius, space } from '../../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  EmptyState,
  Heading,
  Label,
  Loading,
  Meter,
  Num,
  Pill,
  Row,
  SectionHeader,
  Small,
  Stack,
  Stat,
  TrendChart,
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';
import { AppShell } from '../../src/ui/Shell';
import { useResponsive } from '../../src/ui/useResponsive';

export default function DistrictDetailScreen() {
  const { district: districtParam } = useLocalSearchParams<{ district: string }>();
  const districtId = Number(districtParam);
  const { t } = useTheme();
  const router = useRouter();
  const { token } = useAuth();
  const { subscribe } = useLive();
  const { isDesktop, width } = useResponsive();

  const [data, setData] = useState<DistrictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [hours, setHours] = useState(24);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const res = await api.get<DistrictDetail>(`/analytics/district/${districtId}?hours=${hours}`, { token });
        setData(res);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load this district');
      } finally {
        setRefreshing(false);
      }
    },
    [districtId, hours, token],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const off = subscribe('*', (event) => {
      if (event.event.startsWith('capacity.') || event.event.startsWith('incident.')) load(true);
    });
    return off;
  }, [subscribe, load]);

  if (error && !data) {
    return (
      <AppShell title="District" subtitle="Unavailable">
        <EmptyState
          icon="alert"
          title="Could not load this district"
          body={error}
          action={<Button label="Back" icon="chevronLeft" onPress={() => router.push('/analytics')} />}
        />
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title="District" subtitle="Loading">
        <Loading label="Loading district detail…" />
      </AppShell>
    );
  }

  const chartWidth = isDesktop ? Math.min(920, width - 400) : width - 88;
  const labels = data.trend.map((p) => p.t.slice(11, 16));

  return (
    <AppShell
      title={data.district_name}
      subtitle={`${data.hospitals} facilities · ${(data.population / 100000).toFixed(2)} lakh population`}
      maxWidth={1440}
      actions={
        <Row gap="xs">
          <Button label="All districts" icon="chevronLeft" size="sm" onPress={() => router.push('/analytics')} />
          <Button
            label="Export"
            icon="download"
            size="sm"
            onPress={() => {
              if (typeof window !== 'undefined') {
                window.open(`/api/v1/analytics/export/capacity.csv?hours=${hours}&district_id=${districtId}`, '_blank');
              }
            }}
          />
        </Row>
      }
      footerNote="Historic trend points are computed from the append-only capacity series, so a report regenerated later for the same window returns the same numbers."
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
      >
        {error ? <Banner tone="critical" icon="alert" title="Partial data" body={error} /> : null}

        {!data.access.drilldown_enabled ? (
          <Banner
            tone="warm"
            icon="lock"
            title="Drill-down limited"
            body="Your jurisdiction does not extend to facility-level detail here. District aggregates remain available."
          />
        ) : null}

        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: space.xl,
            padding: space.lg,
            borderRadius: radius.lg,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.line.base,
            backgroundColor: t.bg.surface,
          }}
        >
          <Stat
            label="Bed occupancy"
            value={data.beds.occupancy_pct ?? '—'}
            unit="%"
            tone={(data.beds.occupancy_pct ?? 0) > 85 ? 'stale' : 'live'}
            meter={{ value: data.beds.occupied, total: data.beds.total }}
            sub={`${data.beds.available} free`}
          />
          <Stat
            label="ICU occupancy"
            value={data.icu.occupancy_pct ?? '—'}
            unit="%"
            tone={(data.icu.occupancy_pct ?? 0) > 90 ? 'critical' : 'warm'}
            meter={{ value: data.icu.occupied, total: data.icu.total }}
            sub={`${data.icu.available} free`}
          />
          <Stat
            label="ED congestion index"
            value={data.ed_congestion_index ?? '—'}
            tone={(data.ed_congestion_index ?? 0) > 60 ? 'stale' : 'live'}
            sub="weighted across reporting EDs"
          />
          <Stat
            label="Reporting"
            value={`${data.reporting_facilities}/${data.hospitals}`}
            tone={data.stale_facilities > 0 ? 'warm' : 'live'}
            sub={`${data.stale_facilities} stale >1 h`}
          />
          <Stat label="Open incidents" value={data.open_incidents.length} tone="info" sub="awaiting or in transit" />
        </View>

        <Card style={{ gap: space.md }}>
          <Row justify="space-between" align="center" gap="sm" style={{ flexWrap: 'wrap' }}>
            <SectionHeader label={`Availability trend — last ${hours} hours`} />
            <Row gap="xs">
              {[12, 24, 72].map((h) => (
                <Pressable
                  key={h}
                  onPress={() => setHours(h)}
                  style={{
                    paddingVertical: 4,
                    paddingHorizontal: 9,
                    borderRadius: radius.sm,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: hours === h ? t.accent.base : t.line.base,
                    backgroundColor: hours === h ? t.accent.soft : 'transparent',
                  }}
                >
                  <Num size={11.5} color={hours === h ? t.accent.base : t.fg.muted}>
                    {h}h
                  </Num>
                </Pressable>
              ))}
            </Row>
          </Row>

          <TrendChart
            width={chartWidth}
            height={180}
            labels={labels}
            series={[
              { data: data.trend.map((p) => p.beds_available), colour: t.chart.series[0], label: 'Beds free' },
              { data: data.trend.map((p) => p.icu_available), colour: t.chart.series[1], label: 'ICU free' },
              { data: data.trend.map((p) => p.ed_waiting), colour: t.chart.series[2], label: 'ED waiting' },
            ]}
          />

          <Row gap="lg" wrap>
            <LegendDot colour={t.chart.series[0]} label="Beds free" />
            <LegendDot colour={t.chart.series[1]} label="ICU free" />
            <LegendDot colour={t.chart.series[2]} label="ED waiting" />
          </Row>

          {data.trend.length < 3 ? (
            <Small muted style={{ fontSize: 11.5 }}>
              Not enough history in this window to draw a reliable trend. Widen the range or wait for more reports.
            </Small>
          ) : null}
        </Card>

        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          <Card padded={false} style={{ flex: 2, minWidth: isDesktop ? 520 : '100%', overflow: 'hidden' }}>
            <Row
              justify="space-between"
              align="center"
              style={{
                paddingHorizontal: space.lg,
                paddingVertical: space.md,
                backgroundColor: t.bg.sunken,
                borderBottomWidth: StyleSheet.hairlineWidth,
                borderBottomColor: t.line.subtle,
              }}
            >
              <Label>Facilities</Label>
              <Small muted style={{ fontSize: 11 }}>
                sorted by occupancy
              </Small>
            </Row>

            {data.facilities.map((f, i) => (
              <View key={f.id}>
                {i > 0 ? (
                  <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line.subtle, marginHorizontal: space.lg }} />
                ) : null}
                <Pressable
                  onPress={() => router.push(`/facility/${f.id}`)}
                  style={({ pressed }) => ({
                    paddingHorizontal: space.lg,
                    paddingVertical: space.md,
                    backgroundColor: pressed ? t.bg.sunken : 'transparent',
                    gap: space.sm,
                  })}
                >
                  <Row justify="space-between" align="center" gap="sm">
                    <Row gap="sm" align="center" style={{ flex: 1, minWidth: 0 }}>
                      <Body style={{ fontWeight: '600', fontSize: 13.5 }}>{f.short_name}</Body>
                      <Pill
                        label={f.type === 'public' ? 'Govt' : f.type === 'private' ? 'Private' : 'Trust'}
                        tone="neutral"
                        compact
                        outline
                      />
                      {f.integration === 'manual' ? <Pill label="manual" tone="warm" compact /> : null}
                    </Row>
                    <Row gap="sm" align="center">
                      {f.last_report_age_seconds != null && f.last_report_age_seconds > 3600 ? (
                        <Pill label={ageFromSeconds(f.last_report_age_seconds)} tone="warm" compact />
                      ) : null}
                      <Num
                        size={13.5}
                        color={(f.occupancy_pct ?? 0) > 90 ? t.status.critical.base : t.fg.base}
                      >
                        {f.occupancy_pct ?? '—'}%
                      </Num>
                    </Row>
                  </Row>

                  <Row gap="lg" align="center">
                    <Stack gap="xxs" style={{ flex: 1 }}>
                      <Meter
                        value={f.total_beds - (f.beds_available ?? f.total_beds)}
                        total={f.total_beds}
                        tone={(f.occupancy_pct ?? 0) > 90 ? 'critical' : (f.occupancy_pct ?? 0) > 80 ? 'stale' : 'live'}
                        height={3}
                      />
                    </Stack>
                    <Num size={10.5} color={t.fg.faint} weight="500">
                      ICU {f.icu_available ?? '—'}/{f.total_icu} · ED {f.ed_congestion ?? '—'}
                      {f.holds ? ` · ${f.holds} held` : ''}
                    </Num>
                  </Row>
                </Pressable>
              </View>
            ))}
          </Card>

          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 320 : '100%' }}>
            <Card style={{ gap: space.md }}>
              <SectionHeader label="Live incidents in district" />
              {data.open_incidents.length === 0 ? (
                <Small muted>No incidents currently open in this district.</Small>
              ) : (
                data.open_incidents.map((inc) => (
                  <Row key={inc.id} justify="space-between" align="flex-start" gap="sm">
                    <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                      <Row gap="xs" align="center">
                        <Num size={11.5} color={t.fg.muted}>
                          {inc.reference}
                        </Num>
                        <Pill label={inc.urgency} tone={inc.urgency === 'P1' ? 'critical' : 'warm'} compact />
                      </Row>
                      <Small style={{ fontSize: 12.5 }} numberOfLines={1}>
                        {String(inc.category).replace(/_/g, ' ')} · {inc.landmark}
                      </Small>
                    </Stack>
                    <Stack gap="xxs" align="flex-end">
                      <Num size={12} color={t.fg.muted}>
                        {elapsed(inc.age_minutes * 60)}
                      </Num>
                      <Label style={{ fontSize: 9 }}>{inc.status.replace(/_/g, ' ')}</Label>
                    </Stack>
                  </Row>
                ))
              )}
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Interpretation" />
              <Small muted style={{ fontSize: 12 }}>
                Occupancy above 90% in a district means ambulances will travel further, not that care is unavailable. The
                ICU column is the constraint that matters most: ventilated capacity cannot be improvised, and it is the
                number that determines whether a critical patient stays in the district at all.
              </Small>
              <Small muted style={{ fontSize: 11 }}>
                The ED congestion index is a weighted average of self-reported waiting-room pressure across facilities
                currently reporting. It is a leading indicator — it rises before beds run out.
              </Small>
            </Card>
          </Stack>
        </Row>
      </ScrollView>
    </AppShell>
  );
}

function LegendDot({ colour, label }: { colour: string; label: string }) {
  return (
    <Row gap="xs" align="center">
      <View style={{ width: 14, height: 2.5, borderRadius: 2, backgroundColor: colour }} />
      <Small muted style={{ fontSize: 11.5 }}>
        {label}
      </Small>
    </Row>
  );
}
