import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api } from '../src/api/client';
import type { InboxPage, NotificationItem } from '../src/api/types';
import { relativeFromIso } from '../src/lib/format';
import { useAuth } from '../src/state/AuthProvider';
import { useLive } from '../src/state/LiveProvider';
import type { Tokens } from '../src/theme/tokens';
import { useTheme } from '../src/theme/ThemeProvider';
import { radius, space } from '../src/theme/tokens';
import {
  Body,
  Button,
  Card,
  EmptyState,
  Label,
  Loading,
  Num,
  Row,
  SectionHeader,
  Segmented,
  Small,
  Stack,
  StatusDot,
  Title,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';
import { useResponsive } from '../src/ui/useResponsive';

/**
 * Inbox (§6.2 staleness nudges, §6.4 two-way prep alert, §6.10 verification).
 *
 * Every alert MedMesh generates lands here, and the design rule is that the
 * inbox is not a second-class copy of the toast: an alert that mattered enough
 * to interrupt somebody also has to be readable tomorrow, when the person who
 * was on shift has gone home and somebody has to reconstruct what happened.
 *
 * Two addressings exist and both are shown, because a ward clerk needs the
 * facility's alerts and a district official needs their own:
 *   - facility-addressed — inbound patients, staleness reminders, quarantines
 *   - user-addressed — verification decisions, surge notices to one operator
 */

type Tone = keyof Tokens['status'];

const SEVERITY_TONE: Record<string, Tone> = {
  critical: 'critical',
  warning: 'warm',
  info: 'info',
};

type Filter = 'all' | 'unread';
type KindFilter = 'all' | 'inbound_patient' | 'staleness_reminder' | 'other';

export default function Inbox() {
  const { t } = useTheme();
  const { user, token } = useAuth();
  const { subscribe } = useLive();
  const { isDesktop } = useResponsive();
  const router = useRouter();

  const [page, setPage] = useState<InboxPage | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<KindFilter>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(
    async (manual = false) => {
      if (!token) return;
      if (manual) setRefreshing(true);
      try {
        const data = await api.get<InboxPage>('/notifications?limit=100', { token });
        setPage(data);
      } catch {
        // An inbox that fails to refresh must not blank the screen. Keep the
        // last good page; the pull-to-refresh gesture retries.
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Alerts ride the same socket as the rest of the app, so the badge and the
  // list stay current without polling. Two kinds are worth waking the screen
  // for: an inbound case and a hold change.
  useEffect(() => {
    const offInbound = subscribe('hospital.inbound', () => void load());
    const offHold = subscribe('hold.released', () => void load());
    const offIncident = subscribe('incident.dispatched', () => void load());
    return () => {
      offInbound();
      offHold();
      offIncident();
    };
  }, [subscribe, load]);

  const rows = useMemo(() => {
    const all = page?.results ?? [];
    return all.filter((n) => {
      if (filter === 'unread' && n.read_at) return false;
      if (kind === 'inbound_patient' && n.kind !== 'inbound_patient') return false;
      if (kind === 'staleness_reminder' && n.kind !== 'staleness_reminder') return false;
      if (kind === 'other' && (n.kind === 'inbound_patient' || n.kind === 'staleness_reminder')) {
        return false;
      }
      return true;
    });
  }, [page, filter, kind]);

  const markRead = useCallback(
    async (row: NotificationItem) => {
      if (!token || row.read_at) return;
      setBusy(row.id);
      try {
        await api.post(`/notifications/${row.id}/read`, {}, { token });
        setPage((prev) =>
          prev
            ? {
                ...prev,
                unread: Math.max(0, prev.unread - 1),
                results: prev.results.map((n) =>
                  n.id === row.id ? { ...n, read_at: new Date().toISOString() } : n,
                ),
              }
            : prev,
        );
      } catch {
        // Leave it unread — the server owns the record.
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  const markAll = useCallback(async () => {
    if (!token) return;
    setRefreshing(true);
    try {
      await api.post('/notifications/read-all', {}, { token });
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [token, load]);

  if (!user) {
    return (
      <AppShell title="Inbox">
        <EmptyState
          icon="lock"
          title="Sign in to see your alerts"
          body="Alerts are addressed to a facility or to a named operator, so the inbox needs a session."
        />
      </AppShell>
    );
  }

  if (loading) {
    return (
      <AppShell title="Inbox" subtitle="Loading">
        <Loading label="Loading alerts" />
      </AppShell>
    );
  }

  const unread = page?.unread ?? 0;
  const all = page?.results ?? [];
  const inboundCount = all.filter((n) => n.kind === 'inbound_patient').length;
  const oldestUnread = [...all]
    .filter((n) => !n.read_at)
    .sort((a, b) => b.age_seconds - a.age_seconds)[0];

  const scope = user.hospital_name
    ? `${user.hospital_name} · ${roleLabel(user.role)}`
    : roleLabel(user.role);

  return (
    <AppShell
      title="Inbox"
      subtitle={scope}
      maxWidth={1180}
      actions={
        <Row gap={space.sm}>
          <Button
            label="Refresh"
            variant="ghost"
            icon="refresh"
            onPress={() => load(true)}
            disabled={refreshing}
          />
          <Button
            label="Mark all read"
            variant="secondary"
            icon="check"
            onPress={markAll}
            disabled={unread === 0}
          />
        </Row>
      }
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxl, gap: space.lg }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => load(true)}
            tintColor={t.accent.base}
          />
        }
      >
        <Row gap={space.md}>
          <Card style={{ flex: 1 }}>
            <Label>Unread</Label>
            <Num size={21} color={unread ? t.status.critical.base : t.fg.strong}>
              {unread}
            </Num>
            <Small muted>of {page?.count ?? 0} on record</Small>
          </Card>
          <Card style={{ flex: 1 }}>
            <Label>Inbound</Label>
            <Num size={21}>{inboundCount}</Num>
            <Small muted>Cases routed to this desk</Small>
          </Card>
          {isDesktop ? (
            <Card style={{ flex: 1 }}>
              <Label>Oldest unread</Label>
              <Num size={15} style={{ paddingTop: 4 }}>
                {oldestUnread ? relativeFromIso(oldestUnread.created_at) : '—'}
              </Num>
              <Small muted>Nothing is dropped for 30 days</Small>
            </Card>
          ) : null}
        </Row>

        <Row gap={space.md} wrap>
          <Segmented
            value={filter}
            onChange={setFilter}
            size="sm"
            options={[
              { value: 'all', label: `All ${page?.count ?? 0}` },
              { value: 'unread', label: `Unread ${unread}` },
            ]}
          />
          <Segmented
            value={kind}
            onChange={setKind}
            size="sm"
            options={[
              { value: 'all', label: 'Every kind' },
              { value: 'inbound_patient', label: 'Inbound' },
              { value: 'staleness_reminder', label: 'Stale figures' },
              { value: 'other', label: 'Other' },
            ]}
          />
        </Row>

        {rows.length === 0 ? (
          <Card>
            <EmptyState
              icon="check"
              title={filter === 'unread' ? 'Nothing unread' : 'No alerts here'}
              body={
                filter === 'unread'
                  ? 'Every alert addressed to you or your facility has been read.'
                  : 'Alerts appear when a case is routed to your facility, when your figures go stale, or when a submission is quarantined.'
              }
            />
          </Card>
        ) : (
          <Stack gap={space.sm}>
            {rows.map((n) => (
              <AlertRow
                key={n.id}
                row={n}
                busy={busy === n.id}
                onRead={() => markRead(n)}
                onOpenIncident={
                  n.incident_id && user.role === 'dispatcher'
                    ? () => router.push(`/console/${n.incident_id}` as never)
                    : undefined
                }
                /* #35: an inbound alert in a ward inbox used to be a paragraph
                   with no way to act on it; the accept/decline controls live on
                   the dashboard, so the row now carries the reader there and
                   focuses the queue. */
                onReviewInbound={
                  n.incident_id && user.role === 'hospital_admin' && n.kind === 'inbound_patient'
                    ? () => router.push('/dashboard?focus=inbound' as never)
                    : undefined
                }
                /* #36: a crew alert names an assignment the driver has to open;
                   the crew screen is where it is worked. */
                onOpenAssignment={
                  n.incident_id && user.role === 'driver' ? () => router.push('/crew' as never) : undefined
                }
                onOpenFacility={
                  n.hospital_id && user.role === 'platform_admin'
                    ? () => router.push(`/facility/${n.hospital_id}` as never)
                    : undefined
                }
              />
            ))}
          </Stack>
        )}

        <Card>
          <SectionHeader label="How this queue behaves" />
          <Stack gap={space.sm}>
            <Small muted>
              An inbound alert is written the moment a case is routed to your desk, and again when a case is
              re-routed away from it. It is the durable half of the two-way prep alert — the dashboard toast is
              the other half, and the toast is the one that gets missed.
            </Small>
            <Small muted>
              Staleness reminders are rate-limited to one per facility per two hours of silence, so a bad night
              produces one nudge rather than a stream of them.
            </Small>
            <Small muted>
              Quarantine notices are kept on purpose. A submission that was withheld is something the sending
              facility needs to know about; the alternative is a hospital that quietly stops trusting the feed.
            </Small>
            {user.role === 'platform_admin' ? (
              <Small muted>
                As a platform operator you see every facility's alerts, not only your own. Facility desks see
                only theirs.
              </Small>
            ) : null}
          </Stack>
        </Card>
      </ScrollView>
    </AppShell>
  );
}

function AlertRow({
  row,
  busy,
  onRead,
  onOpenIncident,
  onOpenFacility,
  onReviewInbound,
  onOpenAssignment,
}: {
  row: NotificationItem;
  busy: boolean;
  onRead: () => void;
  onOpenIncident?: () => void;
  onOpenFacility?: () => void;
  onReviewInbound?: () => void;
  onOpenAssignment?: () => void;
}) {
  const { t } = useTheme();
  const tone: Tone = SEVERITY_TONE[row.severity] ?? 'info';
  const unread = !row.read_at;
  const payloadKeys = row.payload ? Object.entries(row.payload).slice(0, 4) : [];

  return (
    <Card
      elevated={unread && row.severity === 'critical'}
      style={
        unread
          ? undefined
          : { opacity: 0.68 }
      }
    >
      <View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          width: 3,
          backgroundColor: t.status[tone].base,
          borderTopLeftRadius: radius.lg,
          borderBottomLeftRadius: radius.lg,
        }}
      />
      <Row justify="space-between" align="flex-start" gap={space.md}>
        <Row gap={space.sm} align="flex-start" style={{ flex: 1 }}>
          <View style={{ paddingTop: 4 }}>
            <StatusDot tone={tone} size={unread ? 8 : 6} />
          </View>
          <Stack gap={4} style={{ flex: 1 }}>
            <Row gap={space.sm} align="center" wrap>
              <Label tone={t.status[tone].base}>{row.kind_label}</Label>
              <Small muted>·</Small>
              <Small muted>{relativeFromIso(row.created_at)}</Small>
              {row.hospital_name ? (
                <>
                  <Small muted>·</Small>
                  <Small muted>{row.hospital_name}</Small>
                </>
              ) : null}
              {row.incident_reference ? (
                <>
                  <Small muted>·</Small>
                  <Num size={12}>{row.incident_reference}</Num>
                </>
              ) : null}
            </Row>

            <Title style={{ fontSize: 15 }}>{row.title}</Title>
            {row.body ? (
              <Body muted style={{ fontSize: 12.5, lineHeight: 18 }}>
                {row.body}
              </Body>
            ) : null}

            {payloadKeys.length ? (
              <Row gap={space.lg} wrap style={{ marginTop: 2 }}>
                {payloadKeys.map(([k, v]) => (
                  <Row key={k} gap={4} align="baseline">
                    <Small muted>{k.replace(/_/g, ' ')}</Small>
                    <Num size={12}>{String(v)}</Num>
                  </Row>
                ))}
              </Row>
            ) : null}
          </Stack>
        </Row>

        <Stack gap={space.xs} style={{ minWidth: 126 }}>
          {unread ? (
            <Button
              label="Mark read"
              size="sm"
              variant="secondary"
              icon="check"
              onPress={onRead}
              loading={busy}
            />
          ) : (
            <Row gap={6} align="center" justify="flex-end">
              <Icon name="check" size={12} color={t.fg.faint} />
              <Small muted>Read</Small>
            </Row>
          )}
          {onOpenIncident ? (
            <Button label="Open case" size="sm" variant="ghost" onPress={onOpenIncident} />
          ) : null}
          {onReviewInbound ? (
            <Button
              label="Review inbound case"
              size="sm"
              variant="secondary"
              icon="ambulance"
              onPress={onReviewInbound}
            />
          ) : null}
          {onOpenAssignment ? (
            <Button
              label="Open assignment"
              size="sm"
              variant="secondary"
              icon="ambulance"
              onPress={onOpenAssignment}
            />
          ) : null}
          {onOpenFacility ? (
            <Button label="Facility" size="sm" variant="ghost" onPress={onOpenFacility} />
          ) : null}
        </Stack>
      </Row>
    </Card>
  );
}

function roleLabel(role: string) {
  const map: Record<string, string> = {
    platform_admin: 'Platform operations',
    dispatcher: '108 dispatcher',
    hospital_admin: 'Facility bed control',
    gov_official: 'District health office',
    driver: 'Ambulance crew',
    citizen: 'Public',
  };
  return map[role] ?? role;
}

const styles = StyleSheet.create({});
