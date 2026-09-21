import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { api } from '../src/api/client';
import type { PlatformHealth } from '../src/api/types';
import { BASE_URL, API_BASE } from '../src/api/client';
import { dateTime } from '../src/lib/format';
import { homeFor, useAuth } from '../src/state/AuthProvider';
import { useLive } from '../src/state/LiveProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { space } from '../src/theme/tokens';
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
  Num,
  Pill,
  Row,
  Small,
  Stack,
  Title,
  Segmented,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';

export default function AccountScreen() {
  const { user, token, signOut } = useAuth();
  const { connected, degraded, lastEventAt } = useLive();
  const { t, tr, lang, setLang } = useTheme();
  const router = useRouter();
  const [health, setHealth] = useState<PlatformHealth | null>(null);

  useEffect(() => {
    api
      .get<PlatformHealth>('/governance/health')
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  if (!user) {
    return (
      <AppShell title="Account" subtitle="Not signed in">
        <EmptyState
          icon="lock"
          title="You are browsing as a member of the public"
          body="The public directory, facility detail and clinician roster need no account. Operational surfaces require a provisioned staff login."
          action={<Button label="Staff sign in" variant="primary" icon="lock" onPress={() => router.push('/sign-in')} />}
        />
      </AppShell>
    );
  }

  return (
    <AppShell
      title={user.full_name}
      subtitle={`Signed in as ${String(user.role).replace(/_/g, ' ')}`}
      maxWidth={880}
      actions={<Button label="Sign out" icon="logout" size="sm" onPress={signOut} />}
      scroll={false}
    >
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}>
        <Card style={{ gap: space.sm }}>
          <Heading>Session</Heading>
          <KeyValue label="Email" dense>
            <Num size={13}>{user.email}</Num>
          </KeyValue>
          <KeyValue label="Role" dense>
            <Pill label={String(user.role).replace(/_/g, ' ')} tone="accent" compact />
          </KeyValue>
          {user.hospital_name ? (
            <KeyValue label="Facility scope" dense>
              <Body style={{ fontSize: 13, textAlign: 'right' }}>{user.hospital_name}</Body>
            </KeyValue>
          ) : null}
          {user.district_name ? (
            <KeyValue label="Jurisdiction" dense>
              <Body style={{ fontSize: 13 }}>{user.district_name} district</Body>
            </KeyValue>
          ) : null}
          <KeyValue label="Last sign-in" dense last>
            <Num size={12.5} color={t.fg.muted}>
              {dateTime(user.last_login_at)}
            </Num>
          </KeyValue>
        </Card>

        {/* Language is a personal setting, so it lives with the account rather
            than only on the public screens where it is most needed. */}
        <Card style={{ gap: space.md }}>
          <Heading>{tr('common.language')}</Heading>
          <Text style={{ fontSize: 12.5, color: t.fg.muted }}>
            The citizen directory is available in Tamil. Operational consoles stay in English until they are
            professionally translated — a machine-translated dispatch console is a safety problem, not a
            feature.
          </Text>
          <Segmented
            value={lang}
            onChange={(v) => setLang(v as 'en' | 'ta')}
            options={[
              { value: 'en' as const, label: 'English' },
              { value: 'ta' as const, label: 'தமிழ்' },
            ]}
          />
        </Card>

        <Card style={{ gap: space.sm }}>
          <Heading>What this role may do</Heading>
          <Small muted>{roleCapability(user.role)}</Small>
          <Divider />
          <Stack gap="xs">
            <Row gap="xs" align="center">
              <Icon name="check" size={14} color={t.status.live.base} />
              <Small style={{ fontSize: 12.5 }}>{canSummary(user.role).join(' · ')}</Small>
            </Row>
            <Row gap="xs" align="flex-start">
              <Icon name="x" size={14} color={t.status.stale.base} />
              <Small muted style={{ fontSize: 12.5, flex: 1 }}>
                {cannotSummary(user.role)}
              </Small>
            </Row>
          </Stack>
        </Card>

        <Card style={{ gap: space.sm }}>
          <Heading>Platform health</Heading>
          {health ? (
            <>
              <KeyValue label="API" dense>
                <Pill label={health.status} tone="live" compact />
              </KeyValue>
              <KeyValue label="Facilities projecting" dense>
                <Num size={13}>
                  {health.facilities.projected}/{health.facilities.total}
                </Num>
              </KeyValue>
              <KeyValue label="Feed coverage" dense>
                <Num size={13}>{health.feed.coverage_pct}%</Num>
              </KeyValue>
              <KeyValue label="Live sockets" dense>
                <Num size={13}>{health.realtime.clients}</Num>
              </KeyValue>
              <KeyValue label="Last write" dense last>
                <Num size={12.5} color={t.fg.muted}>
                  {dateTime(health.last_write_at)}
                </Num>
              </KeyValue>
            </>
          ) : (
            <Small muted>Health endpoint unreachable.</Small>
          )}
        </Card>

        <Card style={{ gap: space.sm }}>
          <Heading>Connection</Heading>
          <KeyValue label="Socket" dense>
            <Pill
              label={!connected ? 'disconnected' : degraded ? 'stalled' : 'streaming'}
              tone={!connected ? 'stale' : degraded ? 'warm' : 'live'}
              compact
            />
          </KeyValue>
          <KeyValue label="API base" dense>
            <Num size={11.5} color={t.fg.muted}>
              {API_BASE.replace('http://', '').replace('https://', '')}
            </Num>
          </KeyValue>
          <KeyValue label="Last frame" dense last>
            <Num size={12.5} color={t.fg.muted}>
              {lastEventAt ? `${Math.floor((Date.now() - lastEventAt) / 1000)}s ago` : '—'}
            </Num>
          </KeyValue>
          <Divider />
          <Small muted style={{ fontSize: 11.5 }}>
            Set <Num size={11.5}>EXPO_PUBLIC_API_URL</Num> to point the app at a non-default backend. Resolved base is{' '}
            <Num size={11.5}>{BASE_URL}</Num>.
          </Small>
        </Card>

        <Banner
          tone="neutral"
          icon="info"
          title="Pilot build limitations"
          body="Tokens are stored in AsyncStorage, not the device keychain, and there is no rate limiting or MFA. Both are tracked for the hardening phase before any production roll-out."
        />

        <Row gap="sm" wrap>
          <Button label={`Go to ${homeFor(user.role).replace('/', '') || 'directory'}`} icon="chevronRight" onPress={() => router.push(homeFor(user.role) as any)} />
          <Button label="Sign out" icon="logout" variant="danger" onPress={signOut} />
        </Row>
      </ScrollView>
    </AppShell>
  );
}

function roleCapability(role: string): string {
  switch (role) {
    case 'dispatcher':
      return 'You run the 108 console: you create incident records from incoming calls, review the engine-ranked hospital shortlist, place bed holds and dispatch crews. Incident records carry no patient identifiers — the intake form will reject them.';
    case 'hospital_admin':
      return 'You maintain your own facility\'s capacity and roster. You can see the public directory and your own inbound alerts, but no other facility\'s operational data.';
    case 'driver':
      return 'You see only the assignment issued to your vehicle: the incident, the destination, the route and the receiving facility\'s live capacity.';
    case 'gov_official':
      return 'You see aggregate district and state figures for your jurisdiction, plus the export and surge-control functions. Facility-level operational controls are not available to you.';
    case 'platform_admin':
      return 'Full operational access: onboarding and verification, user provisioning, the audit trail, surge activation and SLA reporting.';
    default:
      return 'Public read-only access to the capacity directory.';
  }
}

function canSummary(role: string): string[] {
  switch (role) {
    case 'dispatcher':
      return ['create incidents', 'dispatch crews', 'place and release holds'];
    case 'hospital_admin':
      return ['update own capacity', 'toggle clinician duty', 'receive inbound alerts'];
    case 'driver':
      return ['view assignment', 'update trip status', 're-route'];
    case 'gov_official':
      return ['district analytics', 'surge mode', 'CSV export'];
    case 'platform_admin':
      return ['everything', 'verification', 'audit trail'];
    default:
      return ['search the directory', 'view facility detail', 'report inaccuracies'];
  }
}

function cannotSummary(role: string): string {
  switch (role) {
    case 'dispatcher':
      return 'Cannot edit any facility\'s capacity figures, and cannot see patient data — because none exists in this system.';
    case 'hospital_admin':
      return 'Cannot edit or even read another facility\'s capacity records, roster or audit history.';
    case 'driver':
      return 'Cannot see other crews\' assignments or the country-wide capacity picture.';
    case 'gov_official':
      return 'Cannot update capacity, dispatch crews, or drill into an individual facility\'s audit trail.';
    case 'platform_admin':
      return 'Cannot add clinical or patient fields — the schema has nowhere to put them.';
    default:
      return 'Cannot see operational dashboards without a provisioned staff account.';
  }
}
