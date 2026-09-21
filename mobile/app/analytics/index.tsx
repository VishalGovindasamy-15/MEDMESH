import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError, API_BASE } from '../../src/api/client';
import type { AnalyticsOverview, DistrictRollup, PlatformHealth } from '../../src/api/types';
import { dateTime, elapsed } from '../../src/lib/format';
import { useAuth } from '../../src/state/AuthProvider';
import { useLive } from '../../src/state/LiveProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { radius, space } from '../../src/theme/tokens';
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
  Small,
  Stack,
  Stat,
  Title,
  TrendChart,
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';
import { AppShell } from '../../src/ui/Shell';
import { useResponsive } from '../../src/ui/useResponsive';

export default function AnalyticsScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { user, token } = useAuth();
  const { subscribe } = useLive();
  const { isDesktop, width } = useResponsive();

  const [overview, setOverview] = useState<AnalyticsOverview | null>(null);
  const [health, setHealth] = useState<PlatformHealth | null>(null);
  const [sla, setSla] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const [ov, hl, s] = await Promise.allSettled([
          api.get<AnalyticsOverview>('/analytics/overview', { token }),
          api.get<PlatformHealth>('/governance/health'),
          api.get<any>('/analytics/sla?days=7', { token }),
        ]);
        if (ov.status !== 'fulfilled') throw ov.reason;
        setOverview(ov.value);
        setHealth(hl.status === 'fulfilled' ? hl.value : null);
        setSla(s.status === 'fulfilled' ? s.value : null);
        setError(null);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load analytics');
      } finally {
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    load();
    const id = setInterval(() => load(true), 45_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const off = subscribe('*', (event) => {
      if (event.event.startsWith('capacity.') || event.event.startsWith('incident.')) load(true);
    });
    return off;
  }, [subscribe, load]);

  const toggleSurge = async () => {
    if (!overview) return;
    setBusy('surge');
    try {
      if (overview.surge) {
        await api.del(`/analytics/surge/${overview.surge.id}`, { token });
      } else {
        await api.post(
          '/analytics/surge',
          {
            title: 'District surge — multi-casualty incident',
            district_id: user?.district_id ?? overview.districts[0]?.district_id ?? 1,
            scope: 'district',
            note: 'Activated from the analytics console. Freshness windows relaxed for affected facilities.',
          },
          { token },
        );
      }
      await load(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Surge action failed');
    } finally {
      setBusy(null);
    }
  };

  if (!user) {
    return (
      <AppShell title="District analytics" subtitle="Restricted">
        <EmptyState
          icon="lock"
          title="This surface is for district and state health officials"
          body="Analytics carries jurisdiction-scoped aggregate figures. Sign in with a provisioned official account to continue."
        />
      </AppShell>
    );
  }

  if (!overview) {
    return (
      <AppShell title="District analytics" subtitle="Loading">
        {error ? <Banner tone="critical" icon="alert" title="Unavailable" body={error} /> : <Loading label="Aggregating district data…" />}
      </AppShell>
    );
  }

  const state = overview.state;
  const chartWidth = isDesktop ? Math.min(880, width - 420) : width - 96;
  const sorted = overview.districts;

  return (
    <AppShell
      title="District capacity picture"
      subtitle={`${state.facilities_reporting} of ${state.facilities} facilities reporting · generated ${dateTime(overview.generated_at)}`}
      maxWidth={1440}
      actions={
        <Row gap="xs">
          <Button
            label="Export CSV"
            icon="download"
            size="sm"
            onPress={() => {
              if (typeof window !== 'undefined') {
                // Through the preview proxy, so the browser never needs to reach
                // the API origin directly.
                window.open(`/api/v1/analytics/export/capacity.csv?hours=24`, '_blank');
              } else {
                Linking.openURL(`${API_BASE}/analytics/export/capacity.csv?hours=24`);
              }
            }}
          />
          <Button
            label={overview.surge ? 'Stand down surge' : 'Activate surge'}
            icon={overview.surge ? 'x' : 'alert'}
            size="sm"
            variant={overview.surge ? 'danger' : 'secondary'}
            loading={busy === 'surge'}
            onPress={toggleSurge}
          />
        </Row>
      }
      footerNote="All figures are aggregate and de-identified. MedMesh holds no patient-level data — the operational schema has no field capable of storing one."
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
      >
        {error ? <Banner tone="critical" icon="alert" title="Some data unavailable" body={error} /> : null}

        {overview.surge ? (
          <Banner
            tone="critical"
            icon="alert"
            title={`Surge mode active — ${overview.surge.title}`}
            body={`Running ${elapsed(overview.surge.elapsed_minutes * 60)}. Freshness thresholds are relaxed for the affected district so facilities are not greyed out mid-response, and trauma centres are up-weighted in matching.`}
          />
        ) : null}

        {/* State KPIs ------------------------------------------------------ */}
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
            value={state.beds_occupancy_pct ?? '—'}
            unit="%"
            tone={(state.beds_occupancy_pct ?? 0) > 85 ? 'stale' : 'live'}
            meter={{ value: state.beds_total - state.beds_available, total: state.beds_total }}
            sub={`${state.beds_available} of ${state.beds_total} free`}
          />
          <Stat
            label="ICU occupancy"
            value={state.icu_occupancy_pct ?? '—'}
            unit="%"
            tone={(state.icu_occupancy_pct ?? 0) > 90 ? 'critical' : (state.icu_occupancy_pct ?? 0) > 75 ? 'warm' : 'live'}
            meter={{ value: state.icu_total - state.icu_available, total: state.icu_total }}
            sub={`${state.icu_available} ICU beds free`}
          />
          <Stat
            label="Open incidents"
            value={overview.operations.incidents_open}
            tone={overview.operations.incidents_open > 6 ? 'warm' : 'info'}
            sub={`${overview.operations.incidents_last_24h} in the last 24 h`}
          />
          <Stat
            label="Fleet available"
            value={overview.operations.ambulances_available}
            unit={`of ${overview.operations.ambulances}`}
            tone="info"
            sub={`${overview.operations.holds_active} beds held`}
          />
          <MedianCommitStat sla={sla} />
        </View>

        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          {/* District table ------------------------------------------------- */}
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
              <Label>Districts by occupancy</Label>
              <Small muted style={{ fontSize: 11 }}>
                tap to drill in
              </Small>
            </Row>

            {sorted.map((district, i) => (
              <View key={district.district_id}>
                {i > 0 ? (
                  <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line.subtle, marginHorizontal: space.lg }} />
                ) : null}
                <DistrictRow
                  district={district}
                  onPress={() => router.push(`/analytics/${district.district_id}`)}
                />
              </View>
            ))}
          </Card>

          {/* Right rail ----------------------------------------------------- */}
          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 320 : '100%' }}>
            <Card style={{ gap: space.md }}>
              <SectionHeader label="Ingest health" />
              {health ? (
                <>
                  <KeyValue label="Feed coverage" dense>
                    <Num size={13} color={health.feed.coverage_pct > 70 ? t.status.live.base : t.status.warm.base}>
                      {health.feed.coverage_pct}%
                    </Num>
                  </KeyValue>
                  <KeyValue label="Reporting live" dense>
                    <Num size={13}>
                      {health.feed.live}/{health.facilities.total}
                    </Num>
                  </KeyValue>
                  <KeyValue label="Stale beyond 1 h" dense>
                    <Num size={13} color={health.feed.stale > 0 ? t.status.warm.base : t.fg.base}>
                      {health.feed.stale}
                    </Num>
                  </KeyValue>
                  {sla?.ingest ? (
                    <KeyValue label="Quarantine rate" dense>
                      <Num size={13}>{sla.ingest.quarantine_rate_pct}%</Num>
                    </KeyValue>
                  ) : null}
                  <KeyValue label="Live sockets" dense last>
                    <Num size={13}>{health.realtime.clients}</Num>
                  </KeyValue>
                </>
              ) : (
                <Small muted>Health endpoint unreachable.</Small>
              )}
              <Small muted style={{ fontSize: 11 }}>
                Coverage is the share of facilities reporting within the live window. The largest single driver of gaps is
                manual-entry facilities during shift change.
              </Small>
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Response performance" />
              {sla?.incidents ? (
                <>
                  <KeyValue label="Cases dispatched" dense>
                    <Num size={13}>{sla.incidents.dispatched}</Num>
                  </KeyValue>
                  <KeyValue label="Call → committed (p50)" dense>
                    <Num size={13}>{Math.round(sla.incidents.dispatch_seconds_p50 ?? 0)} s</Num>
                  </KeyValue>
                  <KeyValue label="Call → committed (p90)" dense>
                    <Num size={13}>{Math.round(sla.incidents.dispatch_seconds_p90 ?? 0)} s</Num>
                  </KeyValue>
                  <KeyValue label="Call → arrival (p50)" dense>
                    <Num size={13}>{sla.incidents.arrival_minutes_p50 ?? '—'} min</Num>
                  </KeyValue>
                  <KeyValue label="Call → arrival (p90)" dense last>
                    <Num size={13}>{sla.incidents.arrival_minutes_p90 ?? '—'} min</Num>
                  </KeyValue>
                  <Small muted style={{ fontSize: 11 }}>
                    This is the number the platform exists to move. Before MedMesh the equivalent measurement is the time
                    a dispatcher spends calling hospitals in sequence.
                  </Small>
                </>
              ) : (
                <Small muted>No incident history in the current window.</Small>
              )}
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Feedback queue" />
              <Row justify="space-between" align="center">
                <Small muted style={{ fontSize: 12.5 }}>
                  Citizen and crew reports awaiting review
                </Small>
                <Pill
                  label={String(overview.operations.open_feedback)}
                  tone={overview.operations.open_feedback > 3 ? 'warm' : 'neutral'}
                  compact
                />
              </Row>
              <Small muted style={{ fontSize: 11 }}>
                Upheld reports lower a facility's trust score until corrected. Repeated upheld reports should trigger an
                onboarding re-verification.
              </Small>
            </Card>

            <Card style={{ gap: space.sm }}>
              <SectionHeader label="Component status" />
              {health?.components.map((c) => (
                <Row key={c.name} justify="space-between" align="center">
                  <Small style={{ fontSize: 12.5 }}>{c.name}</Small>
                  <Pill label={c.state} tone={c.state === 'operational' ? 'live' : 'warm'} compact />
                </Row>
              ))}
              <Small muted style={{ fontSize: 11 }}>
                Last write {dateTime(health?.last_write_at)}.
              </Small>
            </Card>
          </Stack>
        </Row>
      </ScrollView>
    </AppShell>
  );
}

/* ------------------------------------------------------------------- rows */

/**
 * A p50 of 0 s means the platform is freshly seeded and nothing has been
 * committed yet — not that dispatch is instantaneous. Showing "0 s" as a
 * headline metric would be the kind of number that quietly poisons a
 * dashboard's credibility, so it reports the sample size instead.
 */
function MedianCommitStat({ sla }: { sla: any }) {
  const dispatched = sla?.incidents?.dispatched ?? 0;
  if (!dispatched) {
    return (
      <Stat
        label="Median commit time"
        value="—"
        tone="neutral"
        sub="no dispatch decisions recorded in this window yet"
      />
    );
  }
  return (
    <Stat
      label="Median commit time"
      value={Math.round(sla.incidents.dispatch_seconds_p50 ?? 0)}
      unit="s"
      tone="live"
      sub={`p90 ${Math.round(sla.incidents.dispatch_seconds_p90 ?? 0)}s · over ${dispatched} cases`}
    />
  );
}

function DistrictRow({ district, onPress }: { district: DistrictRollup; onPress: () => void }) {
  const { t } = useTheme();
  const occ = district.beds.occupancy_pct ?? 0;
  const icu = district.icu.occupancy_pct ?? 0;
  const tone = occ > 90 ? 'critical' : occ > 80 ? 'stale' : occ > 65 ? 'warm' : 'live';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: pressed ? t.bg.sunken : 'transparent',
        gap: space.sm,
      })}
    >
      <Row justify="space-between" align="center" gap="sm">
        <Row gap="sm" align="center" style={{ flex: 1, minWidth: 0 }}>
          <Body style={{ fontWeight: '600', fontSize: 14 }}>{district.district_name}</Body>
          <Label style={{ fontSize: 9.5 }}>
            {district.hospitals} facilities · {(district.population / 100000).toFixed(1)}L people
          </Label>
        </Row>
        <Row gap="xs" align="center">
          {district.stale_facilities > 0 ? (
            <Pill label={`${district.stale_facilities} stale`} tone="warm" compact />
          ) : null}
          <Num size={14} color={t.status[tone].base}>
            {occ}%
          </Num>
          <Icon name="chevronRight" size={15} color={t.fg.faint} />
        </Row>
      </Row>

      <Row gap="lg">
        <Stack gap="xxs" style={{ flex: 1 }}>
          <Label style={{ fontSize: 9 }}>Beds</Label>
          <Meter value={district.beds.occupied} total={district.beds.total} tone={tone} height={4} />
          <Num size={10.5} color={t.fg.faint} weight="500">
            {district.beds.available} free of {district.beds.total}
          </Num>
        </Stack>
        <Stack gap="xxs" style={{ flex: 1 }}>
          <Label style={{ fontSize: 9 }}>ICU</Label>
          <Meter
            value={district.icu.occupied}
            total={district.icu.total}
            tone={icu > 90 ? 'critical' : icu > 75 ? 'warm' : 'live'}
            height={4}
          />
          <Num size={10.5} color={t.fg.faint} weight="500">
            {district.icu.available} free of {district.icu.total}
          </Num>
        </Stack>
        <Stack gap="xxs" style={{ flex: 1 }}>
          <Label style={{ fontSize: 9 }}>ED index</Label>
          <Meter
            value={district.ed_congestion_index ?? 0}
            total={100}
            tone={(district.ed_congestion_index ?? 0) > 60 ? 'stale' : 'live'}
            height={4}
          />
          <Num size={10.5} color={t.fg.faint} weight="500">
            {district.ed_congestion_index ?? '—'} / 100
          </Num>
        </Stack>
      </Row>
    </Pressable>
  );
}
