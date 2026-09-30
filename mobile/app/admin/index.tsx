import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../../src/api/client';
import { FleetPanel } from './FleetPanel';
import type {
  AdminUser,
  Ambulance,
  AuditEntry,
  Complaint,
  Connector,
  ConnectorEstate,
  ConnectorTemplate,
  District,
  Facility,
  FleetDirectory,
  IssuedConnectorKey,
  OnboardingApplication,
  Role,
} from '../../src/api/types';
import { relativeFromIso } from '../../src/lib/format';
import { useAuth } from '../../src/state/AuthProvider';
import type { Tokens } from '../../src/theme/tokens';
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
  Num,
  Pill,
  Row,
  SectionHeader,
  Segmented,
  Small,
  Stack,
  StatusDot,
  SwitchRow,
  TextField,
  Title,
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';
import { AppShell } from '../../src/ui/Shell';
import { useResponsive } from '../../src/ui/useResponsive';

/**
 * Platform operations (§6.8 governance, §6.9 verification, §6.10 onboarding).
 *
 * This is the page that answers the three questions a pilot always asks in the
 * same breath: who has an account and what can they do, which hospitals are
 * actually sending us data and which are typing it in by hand, and who is
 * waiting to be let onto the network.
 *
 * It is deliberately one screen with three tabs rather than three routes: the
 * work is triage, and an operator moving between them should not lose the state
 * of the others.
 */

type Tab = 'users' | 'fleet' | 'connectors' | 'onboarding' | 'audit' | 'complaints';

const ROLE_LABEL: Record<string, string> = {
  platform_admin: 'Platform admin',
  dispatcher: '108 dispatcher',
  hospital_admin: 'Hospital staff',
  gov_official: 'Government',
  driver: 'Ambulance crew',
  citizen: 'Citizen',
};

const HEALTH_TONE: Record<string, keyof Tokens['status']> = {
  healthy: 'live',
  quiet: 'warm',
  failing: 'critical',
  never_seen: 'neutral',
  disabled: 'neutral',
};

/**
 * `KeyValue` renders a label and a right-aligned value; this wrapper is here so
 * a monospace figure does not have to be spelled out at every call site.
 */
function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <KeyValue label={label}>
      {mono ? <Num size={12.5}>{value}</Num> : <Small>{value}</Small>}
    </KeyValue>
  );
}

export default function AdminConsole() {
  const { t } = useTheme();
  const { user, token } = useAuth();
  const { isDesktop } = useResponsive();

  const [tab, setTab] = useState<Tab>('users');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [flash, setFlash] = useState<{ tone: 'live' | 'warm' | 'critical'; title: string; body?: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [complaints, setComplaints] = useState<Complaint[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [estate, setEstate] = useState<ConnectorEstate | null>(null);
  const [templates, setTemplates] = useState<ConnectorTemplate[]>([]);
  const [queue, setQueue] = useState<OnboardingApplication[]>([]);
  const [facilities, setFacilities] = useState<Facility[]>([]);
  const [districts, setDistricts] = useState<District[]>([]);
  const [fleetSize, setFleetSize] = useState<number | null>(null);

  const isAdmin = user?.role === 'platform_admin';

  const load = useCallback(
    async (manual = false) => {
      if (!token || !isAdmin) return;
      if (manual) setRefreshing(true);
      setError(null);
      try {
        const [u, c, e, tpl, q, f, a, fb, dist, fleet] = await Promise.all([
          api.get<{ results: AdminUser[] }>('/governance/users', { token }),
          api.get<{ results: Connector[] }>('/connectors', { token }),
          api.get<ConnectorEstate>('/connectors/estate', { token }),
          api.get<{ templates: ConnectorTemplate[] }>('/connectors/templates', { token }),
          api.get<{ results: OnboardingApplication[] }>('/onboarding/queue', { token }),
          api.get<{ results: Facility[] }>('/hospitals?include_unverified=true&limit=200', { token }),
          api.get<{ results: AuditEntry[] }>('/governance/audit?hours=72&limit=300', { token }),
          api.get<{ results: Complaint[] }>('/governance/feedback', { token }),
          api.get<{ results: District[] }>('/hospitals/districts', { token }),
          api.get<{ count: number }>('/ambulances?limit=1', { token }),
        ]);
        setUsers(u.results);
        setConnectors(c.results);
        setEstate(e);
        setTemplates(tpl.templates);
        setQueue(q.results);
        setFacilities(f.results);
        setAudit(a.results);
        setComplaints(fb.results);
        setDistricts(dist.results);
        setFleetSize(fleet.count);
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not load the operations data');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [token, isAdmin],
  );

  useEffect(() => {
    void load();
  }, [load]);

  if (!user) {
    return (
      <AppShell title="Platform operations">
        <EmptyState icon="lock" title="Sign in required" body="Operations data is not public." />
      </AppShell>
    );
  }

  // Authorization is enforced by the API; this is the courtesy half — an
  // operator who lands here by a stale bookmark should be told why, not shown
  // a page of empty tables that look like a bug.
  if (!isAdmin) {
    return (
      <AppShell title="Platform operations" subtitle={ROLE_LABEL[user.role]}>
        <EmptyState
          icon="shield"
          title="This area is restricted"
          body={
            `Your account is a ${ROLE_LABEL[user.role] ?? user.role} account. Provisioning users, ` +
            'configuring connectors and verifying facilities are platform-operator actions. ' +
            'Ask the state coordination cell if you need one of them.'
          }
          action={
            <Button
              label="Back to my workspace"
              variant="secondary"
              onPress={() => {
                window.history.back();
              }}
            />
          }
        />
      </AppShell>
    );
  }

  if (loading) {
    return (
      <AppShell title="Platform operations" subtitle="Loading">
        <Loading label="Loading the estate" />
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Platform operations"
      subtitle={`${estate?.facilities ?? 0} facilities · ${fleetSize ?? 0} ambulances · ${connectors.length} connectors · ${users.length} accounts`}
      maxWidth={1320}
      actions={
        <Button label="Refresh" variant="ghost" icon="refresh" onPress={() => load(true)} disabled={refreshing} />
      }
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxl, gap: space.lg }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={t.accent.base} />
        }
      >
        {flash ? (
          <Banner tone={flash.tone} icon={flash.tone === 'critical' ? 'alert' : 'check'} title={flash.title} body={flash.body} />
        ) : null}
        {error ? <Banner tone="critical" icon="alert" title="Could not load everything" body={error} /> : null}

        <Row gap={space.md} wrap>
          <Segmented
            value={tab}
            onChange={setTab}
            options={[
              { value: 'users', label: `Accounts ${users.length}` },
              { value: 'fleet', label: `Fleet ${fleetSize ?? '—'}` },
              { value: 'connectors', label: `Connectors ${connectors.length}` },
              { value: 'onboarding', label: `Onboarding ${queue.length}` },
              { value: 'complaints', label: `Complaints ${complaints.filter((c) => c.status === 'open').length}` },
              { value: 'audit', label: 'Audit' },
            ]}
          />
        </Row>

        {tab === 'users' ? (
          <UsersPanel
          users={users}
          facilities={facilities}
          districts={districts}
          onChange={load}
          onFlash={setFlash}
        />
        ) : null}

        {tab === 'fleet' ? (
          <FleetPanel districts={districts} onChange={load} onFlash={setFlash} />
        ) : null}

        {tab === 'connectors' ? (
          <ConnectorsPanel
            connectors={connectors}
            estate={estate}
            templates={templates}
            facilities={facilities}
            onChange={load}
            onFlash={setFlash}
          />
        ) : null}

        {tab === 'onboarding' ? (
          <OnboardingPanel queue={queue} onChange={load} onFlash={setFlash} />
        ) : null}

        {tab === 'complaints' ? (
          <ComplaintsPanel complaints={complaints} onChange={load} onFlash={setFlash} />
        ) : null}

        {tab === 'audit' ? <AuditPanel entries={audit} /> : null}
      </ScrollView>
    </AppShell>
  );
}

/* ------------------------------------------------------------------ users */

function UsersPanel({
  users,
  facilities,
  districts,
  onChange,
  onFlash,
}: {
  users: AdminUser[];
  facilities: Facility[];
  districts: District[];
  onChange: () => void;
  onFlash: (f: { tone: 'live' | 'warm' | 'critical'; title: string; body?: string }) => void;
}) {
  const { t } = useTheme();
  const { token, user } = useAuth();
  const { isDesktop } = useResponsive();

  const [roleFilter, setRoleFilter] = useState<'all' | Role>('all');
  const [busy, setBusy] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    role: 'hospital_admin' as Role,
    hospital_id: '',
    district_id: '',
    ambulance_id: '',
    phone: '',
  });

  const [crewless, setCrewless] = useState<Ambulance[]>([]);

  const filtered = useMemo(
    () => users.filter((u) => roleFilter === 'all' || u.role === roleFilter),
    [users, roleFilter],
  );

  /**
   * District chooser, jurisdiction first, then by fleet size.
   *
   * The previous control was a free-text box labelled "District id" with
   * "1 = Coimbatore" as the placeholder, which is a database column exposed as a
   * form field. Provisioning is done under time pressure by somebody who knows
   * district names and not primary keys.
   */
  const districtOptions = useMemo(
    () =>
      [...districts].sort(
        (a, b) => (b.hospital_count ?? 0) - (a.hospital_count ?? 0) || a.name.localeCompare(b.name),
      ),
    [districts],
  );

  // Loaded when the crew role is selected, so the picker is over real vehicles.
  const loadCrewless = useCallback(async () => {
    if (!token) return;
    try {
      const dir = await api.get<FleetDirectory>('/ambulances/drivers', { token });
      setCrewless(dir.crewless_units);
    } catch {
      setCrewless([]);
    }
  }, [token]);

  useEffect(() => {
    if (form.role === 'driver') void loadCrewless();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.role]);

  const submit = useCallback(async () => {
    if (!token) return;
    setBusy(-1);
    try {
      const created = await api.post<{ id: number; full_name: string }>(
        '/governance/users',
        {
          full_name: form.full_name.trim(),
          email: form.email.trim().toLowerCase(),
          password: form.password,
          role: form.role,
          ...(form.role === 'hospital_admin' ? { hospital_id: Number(form.hospital_id) || null } : {}),
          ...(form.role === 'gov_official' || form.role === 'dispatcher' || form.role === 'driver'
            ? { district_id: Number(form.district_id) || null }
            : {}),
        },
        { token },
      );

      // Link the vehicle in the same action. Two requests, because creating a
      // person and equipping them are different records -- but one button,
      // because "create a driver" that produced a driver who cannot be
      // dispatched would be a half-finished workflow dressed up as a complete
      // one. The link is best-effort: if it fails the account still exists and
      // the Fleet tab reports the orphan driver, which is a visible state.
      let linked: string | null = null;
      if (form.role === 'driver' && form.ambulance_id && token) {
        try {
          await api.post(
            `/ambulances/${form.ambulance_id}/crew`,
            { driver_user_id: created.id },
            { token },
          );
          linked = crewless.find((a) => String(a.id) === form.ambulance_id)?.call_sign ?? null;
        } catch (linkErr) {
          onFlash({
            tone: 'warm',
            title: `${form.full_name.trim()} was created but no vehicle was linked`,
            body:
              (linkErr instanceof ApiError ? linkErr.message : 'The vehicle link failed.') +
              ' Link one from the Fleet tab before they go on shift.',
          });
        }
      }

      onFlash({
        tone: 'live',
        title: `Account created for ${form.full_name.trim()}`,
        body:
          `${ROLE_LABEL[form.role] ?? form.role} · they can sign in with the password you set and should change it.` +
          (linked ? ` Linked to ${linked}.` : ''),
      });
      setForm({
        full_name: '',
        email: '',
        password: '',
        role: 'hospital_admin',
        hospital_id: '',
        district_id: '',
        ambulance_id: '',
        phone: '',
      });
      setAdding(false);
      onChange();
    } catch (err) {
      const detail = err instanceof ApiError ? err.message : 'Could not create the account';
      onFlash({ tone: 'critical', title: 'Account not created', body: detail });
    } finally {
      setBusy(null);
    }
  }, [token, form, onChange, onFlash]);

  const toggleActive = useCallback(
    async (target: AdminUser) => {
      if (!token) return;
      setBusy(target.id);
      try {
        await api.patch(`/governance/users/${target.id}?is_active=${!target.is_active}`, undefined, { token });
        onFlash({
          tone: target.is_active ? 'warm' : 'live',
          title: target.is_active ? `${target.full_name} disabled` : `${target.full_name} reactivated`,
          body: target.is_active
            ? 'They keep the record of their work; they cannot sign in.'
            : 'Their existing sessions are valid again.',
        });
        onChange();
      } catch (err) {
        onFlash({
          tone: 'critical',
          title: 'That change was refused',
          body: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [token, onChange, onFlash],
  );

  return (
    <Stack gap={space.lg}>
      <Card>
        <Row justify="space-between" align="center" wrap gap={space.md}>
          <Stack gap={2}>
            <SectionHeader label="Who can do what" />
            <Small muted>
              Accounts are the only way into the platform; there is no self-service sign-up above citizen level.
            </Small>
          </Stack>
          <Button
            label={adding ? 'Close' : 'Add a user'}
            icon={adding ? 'x' : 'userplus'}
            variant={adding ? 'ghost' : 'primary'}
            onPress={() => setAdding((v) => !v)}
          />
        </Row>

        {adding ? (
          <View style={{ marginTop: space.lg }}>
            <Divider />
            <Stack gap={space.md} style={{ marginTop: space.lg }}>
              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label="Full name"
                    value={form.full_name}
                    onChangeText={(v) => setForm((f) => ({ ...f, full_name: v }))}
                    placeholder="Dr. Revathi S"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label="Work email"
                    value={form.email}
                    onChangeText={(v) => setForm((f) => ({ ...f, email: v }))}
                    placeholder="name@hospital.gov.in"
                    keyboardType="email-address"
                    autoCapitalize="none"
                  />
                </View>
              </Row>

              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label="Initial password"
                    value={form.password}
                    onChangeText={(v) => setForm((f) => ({ ...f, password: v }))}
                    placeholder="At least 8 characters, mixed"
                    secureTextEntry
                  />
                </View>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <Stack gap={6}>
                    <Label>Role</Label>
                    <Segmented
                      size="sm"
                      value={form.role}
                      onChange={(v) => setForm((f) => ({ ...f, role: v }))}
                      options={[
                        { value: 'hospital_admin' as Role, label: 'Hospital' },
                        { value: 'dispatcher' as Role, label: 'Dispatcher' },
                        { value: 'driver' as Role, label: 'Crew' },
                        { value: 'gov_official' as Role, label: 'Govt' },
                      ]}
                    />
                  </Stack>
                </View>
              </Row>

              {form.role === 'hospital_admin' ? (
                <Stack gap={6}>
                  <Label>Facility they report for</Label>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    <Row gap={space.sm}>
                      {facilities.slice(0, 14).map((f) => {
                        const active = String(f.id) === form.hospital_id;
                        return (
                          <Button
                            key={f.id}
                            label={f.short_name}
                            size="sm"
                            variant={active ? 'primary' : 'secondary'}
                            onPress={() => setForm((prev) => ({ ...prev, hospital_id: String(f.id) }))}
                          />
                        );
                      })}
                    </Row>
                  </ScrollView>
                  <Small muted>
                    A hospital account is scoped to one facility, and the API refuses it without one — an
                    unscoped bed-control login is how a facility ends up editing somebody else's numbers.
                  </Small>
                </Stack>
              ) : null}

              {form.role !== 'hospital_admin' ? (
                <Stack gap="sm">
                  <Label>Jurisdiction</Label>
                  <Segmented
                    size="sm"
                    scroll
                    value={form.district_id}
                    onChange={(v) => setForm((f) => ({ ...f, district_id: v }))}
                    options={districtOptions.map((d) => ({ value: String(d.id), label: d.name }))}
                  />
                  <Small muted>
                    {form.role === 'driver'
                      ? 'The district this crew reports to. Their vehicle’s base district is what the matching engine actually reads, and the two are kept in step when you link a vehicle below.'
                      : 'Scopes what this account can see and change. A district dispatcher sees their own district; a state account sees everything.'}
                  </Small>
                </Stack>
              ) : null}

              {/* A crew account with no vehicle is the failure this whole form
                  exists to prevent: their screen calls GET /crew/assignment,
                  finds nothing, and shows an empty state on the one device that
                  has to work at 3 a.m. So the link is offered here, on the
                  screen where the account is made, rather than as a follow-up
                  step somebody has to remember. */}
              {form.role === 'driver' ? (
                <Stack gap="sm">
                  <Label>Assign a vehicle</Label>
                  {crewless.length === 0 ? (
                    <Small muted>
                      Every vehicle already has a crew. Add one from the Fleet tab first, or create
                      the account and link it later — but a crew account with no vehicle cannot be
                      dispatched.
                    </Small>
                  ) : (
                    <>
                      <Segmented
                        size="sm"
                        scroll
                        value={form.ambulance_id}
                        onChange={(v) => setForm((f) => ({ ...f, ambulance_id: v }))}
                        options={[
                          { value: '', label: 'Link later' },
                          ...crewless.map((a) => ({
                            value: String(a.id),
                            label: `${a.call_sign} · ${a.capability_label}`,
                          })),
                        ]}
                      />
                      <Small muted>
                        Only vehicles without a crew are listed. Moving a driver between vehicles is
                        done from the Fleet tab, where the old vehicle is released at the same time.
                      </Small>
                    </>
                  )}
                </Stack>
              ) : null}

              <Row gap={space.md} align="center">
                <Button
                  label="Create account"
                  icon="check"
                  variant="primary"
                  onPress={submit}
                  loading={busy === -1}
                  disabled={!form.full_name || !form.email || form.password.length < 8}
                />
                <Small muted>The password is shown to nobody afterwards — share it out of band.</Small>
              </Row>
            </Stack>
          </View>
        ) : null}
      </Card>

      <Row gap={space.sm} wrap>
        <Segmented
          size="sm"
          value={roleFilter}
          onChange={setRoleFilter}
          options={[
            { value: 'all' as const, label: `All ${users.length}` },
            { value: 'platform_admin' as Role, label: 'Admin' },
            { value: 'dispatcher' as Role, label: 'Dispatch' },
            { value: 'hospital_admin' as Role, label: 'Facilities' },
            { value: 'gov_official' as Role, label: 'Govt' },
            { value: 'driver' as Role, label: 'Crew' },
          ]}
        />
      </Row>

      <Card padded={false}>
        <View style={[styles.thead, { borderBottomColor: t.line.base }]}>
          <Small muted style={styles.cName}>
            Person
          </Small>
          <Small muted style={styles.cRole}>
            Role
          </Small>
          {isDesktop ? (
            <Small muted style={styles.cScope}>
              Scope
            </Small>
          ) : null}
          {isDesktop ? (
            <Small muted style={styles.cSeen}>
              Last sign-in
            </Small>
          ) : null}
          <Small muted style={styles.cState}>
            State
          </Small>
        </View>
        {filtered.map((u, i) => (
          <View
            key={u.id}
            style={[
              styles.trow,
              {
                borderBottomColor: t.line.subtle,
                backgroundColor: i % 2 ? t.bg.sunken : 'transparent',
              },
            ]}
          >
            <Stack gap={2} style={styles.cName}>
              <Small>{u.full_name}</Small>
              <Small muted style={{ fontSize: 11.5 }}>
                {u.email}
              </Small>
            </Stack>
            <View style={styles.cRole}>
              <Pill label={ROLE_LABEL[u.role] ?? u.role} tone={u.role === 'platform_admin' ? 'info' : 'neutral'} />
            </View>
            {isDesktop ? (
              <Small muted style={styles.cScope}>
                {u.hospital ?? u.district ?? '—'}
              </Small>
            ) : null}
            {isDesktop ? (
              <Small muted style={styles.cSeen}>
                {u.last_login_at ? relativeFromIso(u.last_login_at) : 'never'}
              </Small>
            ) : null}
            <Row gap={space.sm} align="center" style={styles.cState}>
              <StatusDot tone={u.is_active ? 'live' : 'neutral'} />
              <Small muted>{u.is_active ? 'active' : 'disabled'}</Small>
              <Button
                label={u.is_active ? 'Disable' : 'Enable'}
                size="sm"
                variant="ghost"
                onPress={() => toggleActive(u)}
                loading={busy === u.id}
                disabled={u.id === user?.id}
              />
            </Row>
          </View>
        ))}
      </Card>

      <Card>
        <SectionHeader label="Why this is not self-service" />
        <Small muted>
          Registration is open to the public for citizen accounts only. Every operational account is provisioned
          here, by a named operator, and written to the audit log with who created it and when — which is what
          makes an incident review possible later.
        </Small>
      </Card>
    </Stack>
  );
}

/* ------------------------------------------------------------- connectors */

function ConnectorsPanel({
  connectors,
  estate,
  templates,
  facilities,
  onChange,
  onFlash,
}: {
  connectors: Connector[];
  estate: ConnectorEstate | null;
  templates: ConnectorTemplate[];
  facilities: Facility[];
  onChange: () => void;
  onFlash: (f: { tone: 'live' | 'warm' | 'critical'; title: string; body?: string }) => void;
}) {
  const { t } = useTheme();
  const { token } = useAuth();
  const { isDesktop } = useResponsive();

  const [creating, setCreating] = useState(false);
  const [facilityId, setFacilityId] = useState('');
  const [kind, setKind] = useState<'fhir_r4' | 'vendor_rest' | 'csv_sftp' | 'manual'>('fhir_r4');
  const [sourceSystem, setSourceSystem] = useState('');
  const [issued, setIssued] = useState<IssuedConnectorKey | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [testing, setTesting] = useState<{ id: number; ok: boolean; message: string } | null>(null);
  const [openTemplate, setOpenTemplate] = useState<string | null>(null);

  const selected = facilities.find((f) => String(f.id) === facilityId);
  const selectedTemplate = templates.find((tp) => tp.kind === kind);

  const create = useCallback(async () => {
    if (!token || !selected) return;
    setBusy(-1);
    try {
      const res = await api.post<IssuedConnectorKey>(
        '/connectors',
        { hospital_id: selected.id, kind, source_system: sourceSystem.trim() },
        { token },
      );
      setIssued(res);
      setCreating(false);
      onChange();
    } catch (err) {
      onFlash({
        tone: 'critical',
        title: 'Connector not created',
        body: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }, [token, selected, kind, sourceSystem, onChange, onFlash]);

  const rotate = useCallback(
    async (c: Connector) => {
      if (!token) return;
      setBusy(c.id);
      try {
        const res = await api.post<IssuedConnectorKey>(`/connectors/${c.id}/rotate`, {}, { token });
        setIssued(res);
        onChange();
      } catch (err) {
        onFlash({
          tone: 'critical',
          title: 'Rotation failed',
          body: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [token, onChange, onFlash],
  );

  const test = useCallback(
    async (c: Connector) => {
      if (!token) return;
      setBusy(c.id);
      try {
        const res = await api.post<{ ok: boolean; message: string }>(`/connectors/${c.id}/test`, {}, { token });
        setTesting({ id: c.id, ok: res.ok, message: res.message });
      } catch (err) {
        setTesting({
          id: c.id,
          ok: false,
          message: err instanceof ApiError ? err.message : 'Test failed',
        });
      } finally {
        setBusy(null);
      }
    },
    [token],
  );

  const setActive = useCallback(
    async (c: Connector) => {
      if (!token) return;
      setBusy(c.id);
      try {
        await api.post(`/connectors/${c.id}/active`, { active: !c.active }, { token });
        onFlash({
          tone: c.active ? 'warm' : 'live',
          title: `${c.hospital_short_name} connector ${c.active ? 'disabled' : 'enabled'}`,
          body: c.active
            ? 'Its pushes will be refused until it is re-enabled.'
            : 'It can push capacity again with the same key.',
        });
        onChange();
      } finally {
        setBusy(null);
      }
    },
    [token, onChange, onFlash],
  );

  return (
    <Stack gap={space.lg}>
      <Row gap={space.md} wrap>
        <Card style={{ flex: 1, minWidth: 170 }}>
          <Label>Pushing data</Label>
          <Num size={21}>{estate?.by_integration?.api ?? 0}</Num>
          <Small muted>facilities marked API-integrated</Small>
        </Card>
        <Card style={{ flex: 1, minWidth: 170 }}>
          <Label>Keyed by hand</Label>
          <Num size={21}>{estate?.manual_facilities ?? 0}</Num>
          <Small muted>no compatible system</Small>
        </Card>
        <Card style={{ flex: 1, minWidth: 170 }}>
          <Label>Failing</Label>
          <Num size={21} color={(estate?.by_health?.failing ?? 0) ? t.status.critical.base : undefined}>
            {(estate?.by_health?.failing ?? 0) + (estate?.by_health?.quiet ?? 0)}
          </Num>
          <Small muted>erroring or silent &gt; 6 h</Small>
        </Card>
        <Card style={{ flex: 1, minWidth: 170 }}>
          <Label>Live connectors</Label>
          <Num size={21}>{connectors.length}</Num>
          <Small muted>credentials issued</Small>
        </Card>
      </Row>

      {issued ? (
        <Banner
          tone="live"
          icon="key"
          title={`Key for ${facilities.find((f) => f.id === issued.hospital_id)?.short_name ?? issued.hospital_id} — copy it now`}
          body={issued.warning}
          action={
            <Stack gap={space.sm} style={{ marginTop: space.sm }}>
            <View style={[styles.keyBox, { backgroundColor: t.bg.sunken, borderColor: t.line.base }]}>
              <Num size={13} style={{ flex: 1 }}>
                {issued.key}
              </Num>
            </View>
            <Row gap={space.sm} wrap>
              <KV label="Ingest URL" value={issued.ingest_url ?? '—'} mono />
              <KV label="Header" value={"X-Connector-Key"} mono />
              <Button label="Dismiss" size="sm" variant="ghost" onPress={() => setIssued(null)} />
            </Row>
              <Small muted>
                Only the hash is stored. If this is lost, rotate — there is no way to recover it, which is the
                point of a machine credential.
              </Small>
            </Stack>
          }
        />
      ) : null}

      <Card>
        <Row justify="space-between" align="center" wrap gap={space.md}>
          <Stack gap={2}>
            <SectionHeader label="Connect an existing system" />
            <Small muted>
              One canonical FHIR mapping first, vendor aliases second, the keypad last — the order the
              integration work has to be done in, because each one covers the facilities the previous one
              cannot.
            </Small>
          </Stack>
          <Button
            label={creating ? 'Close' : 'New connector'}
            icon={creating ? 'x' : 'link'}
            variant={creating ? 'ghost' : 'primary'}
            onPress={() => setCreating((v) => !v)}
          />
        </Row>

        {creating ? (
          <Stack gap={space.md} style={{ marginTop: space.lg }}>
            <Divider />
            <Stack gap={6}>
              <Label>Facility</Label>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <Row gap={space.sm}>
                  {facilities
                    .filter((f) => f.verification === 'verified')
                    .map((f) => {
                      const active = String(f.id) === facilityId;
                      return (
                        <Button
                          key={f.id}
                          label={f.short_name}
                          size="sm"
                          variant={active ? 'primary' : 'secondary'}
                          onPress={() => setFacilityId(String(f.id))}
                        />
                      );
                    })}
                </Row>
              </ScrollView>
              {selected ? (
                <Small muted>
                  {selected.name} · currently {selected.integration === 'api' ? 'API' : 'manual entry'}
                </Small>
              ) : null}
            </Stack>

            <Stack gap={6}>
              <Label>What their system speaks</Label>
              <Segmented
                size="sm"
                value={kind}
                onChange={setKind}
                options={[
                  { value: 'fhir_r4' as const, label: 'FHIR R4' },
                  { value: 'vendor_rest' as const, label: 'Vendor REST' },
                  { value: 'csv_sftp' as const, label: 'File drop' },
                  { value: 'manual' as const, label: 'Manual only' },
                ]}
              />
              {selectedTemplate ? <Small muted>{selectedTemplate.description}</Small> : null}
            </Stack>

            {kind !== 'manual' ? (
              <View style={{ maxWidth: 360 }}>
                <TextField
                  label="Their system name"
                  value={sourceSystem}
                  onChangeText={setSourceSystem}
                  placeholder="Cerner Millennium, TrakCare, Insta HMS…"
                />
              </View>
            ) : null}

            <Row gap={space.md} align="center" wrap>
              <Button
                label="Issue a key"
                icon="key"
                variant="primary"
                onPress={create}
                loading={busy === -1}
                disabled={!selected}
              />
              <Small muted>Shown once. The connector starts in the healthy-but-never-seen state.</Small>
            </Row>
          </Stack>
        ) : null}
      </Card>

      {estate?.api_without_connector?.length ? (
        <Banner
          tone="warm"
          icon="alert"
          title={`${estate.api_without_connector.length} facilities are marked API-integrated but have no connector`}
          body={`${estate.api_without_connector.slice(0, 10).join(', ')}${estate.api_without_connector.length > 10 ? '…' : ''} — their figures can only go stale, and dispatchers route on them.`}
        />
      ) : null}

      <Card padded={false}>
        <View style={[styles.thead, { borderBottomColor: t.line.base }]}>
          <Small muted style={styles.cName}>
            Facility
          </Small>
          <Small muted style={styles.cKind}>
            Speaks
          </Small>
          {isDesktop ? (
            <Small muted style={styles.cScope}>
              Last push
            </Small>
          ) : null}
          {isDesktop ? (
            <Small muted style={styles.cSeen}>
              Accepted 24 h
            </Small>
          ) : null}
          <Small muted style={styles.cState}>
            Health
          </Small>
        </View>

        {connectors.length === 0 ? (
          <EmptyState
            icon="link"
            title="No connectors yet"
            body="Every facility is currently reporting by hand or not at all."
          />
        ) : (
          connectors.map((c, i) => {
            const tone = HEALTH_TONE[c.health] ?? 'neutral';
            return (
              <View key={c.id}>
                <View
                  style={[
                    styles.trow,
                    {
                      borderBottomColor: t.line.subtle,
                      backgroundColor: i % 2 ? t.bg.sunken : 'transparent',
                    },
                  ]}
                >
                  <Stack gap={2} style={styles.cName}>
                    <Small>{c.hospital_short_name ?? c.hospital_name}</Small>
                    <Small muted style={{ fontSize: 11.5 }}>
                      {c.source_system || 'not named'} · key {c.key_prefix ?? '—'}
                    </Small>
                  </Stack>
                  <View style={styles.cKind}>
                    <Pill label={c.kind.replace('_', ' ')} tone="neutral" />
                  </View>
                  {isDesktop ? (
                    <Small muted style={styles.cScope}>
                      {c.last_seen_at ? relativeFromIso(c.last_seen_at) : 'never'}
                    </Small>
                  ) : null}
                  {isDesktop ? (
                    <Num size={13} style={styles.cSeen}>
                      {c.accepted_24h}
                      {c.rejected_24h ? `  (${c.rejected_24h} refused)` : ''}
                    </Num>
                  ) : null}
                  <Stack gap={4} style={styles.cState}>
                    <Row gap={space.sm} align="center">
                      <StatusDot tone={tone} />
                      <Small muted>{c.health.replace('_', ' ')}</Small>
                    </Row>
                    <Row gap={space.xs} wrap>
                      <Button label="Test" size="sm" variant="ghost" onPress={() => test(c)} loading={busy === c.id} />
                      <Button label="Rotate" size="sm" variant="ghost" onPress={() => rotate(c)} disabled={busy === c.id} />
                      <Button
                        label={c.active ? 'Disable' : 'Enable'}
                        size="sm"
                        variant="ghost"
                        onPress={() => setActive(c)}
                        disabled={busy === c.id}
                      />
                    </Row>
                  </Stack>
                </View>
                {c.last_error ? (
                  <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
                    <Small style={{ color: t.status.critical.base }}>{c.last_error}</Small>
                  </View>
                ) : null}
                {testing?.id === c.id ? (
                  <View style={{ paddingHorizontal: space.lg, paddingBottom: space.md }}>
                    <Small style={{ color: testing.ok ? t.status.live.base : t.status.critical.base }}>
                      {testing.message}
                    </Small>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </Card>

      <Card>
        <SectionHeader label="What an integrator gets" />
        <Stack gap={space.sm}>
          {templates.map((tp) => (
            <View key={tp.kind}>
              <Row justify="space-between" align="center" wrap gap={space.md}>
                <Stack gap={2} style={{ flex: 1 }}>
                  <Row gap={space.sm} align="center">
                    <Heading style={{ fontSize: 14 }}>{tp.label}</Heading>
                    {tp.ingest_url ? <Num size={12}>{tp.ingest_url}</Num> : <Small muted>staff sign-in only</Small>}
                  </Row>
                  <Small muted>{tp.description}</Small>
                </Stack>
                <Button
                  label={openTemplate === tp.kind ? 'Hide sample' : 'Show sample'}
                  size="sm"
                  variant="ghost"
                  onPress={() => setOpenTemplate(openTemplate === tp.kind ? null : tp.kind)}
                />
              </Row>
              {openTemplate === tp.kind ? (
                <>
                  {tp.population_codes?.length ? (
                    <Row gap={space.sm} wrap style={{ marginTop: space.sm }}>
                      {tp.population_codes.map((code) => (
                        <Pill key={code} label={code} tone="neutral" />
                      ))}
                    </Row>
                  ) : null}
                  {tp.fields?.length ? (
                    <Stack gap={2} style={{ marginTop: space.sm }}>
                      {tp.fields.map((f) => (
                        <Small key={f} muted>
                          · {f}
                        </Small>
                      ))}
                    </Stack>
                  ) : null}
                  <View style={[styles.codeBox, { backgroundColor: t.bg.sunken, borderColor: t.line.base }]}>
                    <Body style={{ fontFamily: 'monospace', fontSize: 11.5, lineHeight: 16 }}>
                      {JSON.stringify(tp.sample, null, 2)}
                    </Body>
                  </View>
                </>
              ) : null}
            </View>
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}


/* ------------------------------------------------------- complaints & audit */

/**
 * Complaint / feedback loop (§6.3, §7).
 *
 * A citizen or a dispatcher says the directory was wrong; that report is the
 * only external check on self-reported capacity, so it has to be visible to the
 * people who can act on it and it has to be closable. The trust engine sees the
 * volume of open complaints against a facility — leaving them unread degrades
 * that facility's score, which is the intended pressure.
 */
function ComplaintsPanel({
  complaints,
  onChange,
  onFlash,
}: {
  complaints: Complaint[];
  onChange: () => void;
  onFlash: (f: { tone: 'live' | 'warm' | 'critical'; title: string; body?: string }) => void;
}) {
  const { t } = useTheme();
  const { token } = useAuth();
  const { isDesktop } = useResponsive();
  const [busy, setBusy] = useState<number | null>(null);
  const [onlyOpen, setOnlyOpen] = useState(true);

  const rows = useMemo(
    () => complaints.filter((c) => (onlyOpen ? c.status === 'open' : true)),
    [complaints, onlyOpen],
  );

  const resolve = useCallback(
    async (c: Complaint) => {
      if (!token) return;
      setBusy(c.id);
      try {
        await api.post(
          `/governance/feedback/${c.id}/resolve`,
          { resolution: 'resolved', note: 'Confirmed against the facility bed-control desk' },
          { token },
        );
        onFlash({
          tone: 'live',
          title: `Complaint against ${c.hospital_name} closed`,
          body: 'It no longer counts against the facility\u2019s trust score.',
        });
        onChange();
      } catch (err) {
        onFlash({
          tone: 'critical',
          title: 'Could not close the complaint',
          body: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [token, onChange, onFlash],
  );

  if (!complaints.length) {
    return (
      <Card>
        <EmptyState
          icon="check"
          title="No complaints recorded"
          body="Citizens and dispatchers flag inaccurate listings from the facility page and the console. Nothing has been flagged yet."
        />
      </Card>
    );
  }

  return (
    <Stack gap={space.lg}>
      <Card>
        <Row justify="space-between" align="center" wrap gap={space.md}>
          <Stack gap={2}>
            <SectionHeader label="Reported inaccuracies" />
            <Small muted>
              These are the only external check on self-reported capacity. A facility with several open reports is
              a facility dispatchers should not trust blindly.
            </Small>
          </Stack>
          <Segmented
            size="sm"
            value={onlyOpen ? 'open' : 'all'}
            onChange={(v) => setOnlyOpen(v === 'open')}
            options={[
              { value: 'open', label: `Open ${complaints.filter((c) => c.status === 'open').length}` },
              { value: 'all', label: `All ${complaints.length}` },
            ]}
          />
        </Row>
      </Card>

      {rows.map((c) => (
        <Card key={c.id}>
          <Row justify="space-between" align="flex-start" wrap gap={space.md}>
            <Stack gap={space.sm} style={{ flex: 1, minWidth: 260 }}>
              <Row gap={space.sm} align="center" wrap>
                <Pill label={c.kind_label} tone={c.status === 'open' ? 'warm' : 'neutral'} />
                <Pill label={c.reporter_role} tone="neutral" />
                <Small muted>reported {c.age} ago</Small>
              </Row>
              <Body>{c.comment || 'No detail supplied.'}</Body>
              <Row gap={space.lg} wrap>
                <KV label="Facility" value={c.hospital_name} />
                <KV label="Status" value={c.status} />
                {c.incident_id ? <KV label="Case" value={`#${c.incident_id}`} mono /> : null}
              </Row>
            </Stack>
            {c.status === 'open' ? (
              <Button
                label="Mark resolved"
                icon="check"
                variant="secondary"
                onPress={() => resolve(c)}
                loading={busy === c.id}
              />
            ) : (
              <Row gap={6} align="center">
                <Icon name="check" size={12} color={t.fg.faint} />
                <Small muted>closed</Small>
              </Row>
            )}
          </Row>
        </Card>
      ))}
    </Stack>
  );
}

/**
 * Audit log (§7).
 *
 * Every capacity write, dispatch, hold, verification and account change is
 * attributed to a named actor. This screen exists because emergency
 * infrastructure gets reviewed after the fact: when a district asks "who told
 * the ambulance that hospital had a free ICU bed", this is where the answer is.
 *
 * Read-only, deliberately. An editable audit log is not an audit log.
 */
function AuditPanel({ entries }: { entries: AuditEntry[] }) {
  const { t } = useTheme();
  const { isDesktop } = useResponsive();
  const [action, setAction] = useState<string>('all');
  const [query, setQuery] = useState('');

  const families = useMemo(() => {
    const seen = new Map<string, number>();
    entries.forEach((e) => {
      const family = e.action.split('.')[0];
      seen.set(family, (seen.get(family) ?? 0) + 1);
    });
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [entries]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (action !== 'all' && !e.action.startsWith(action)) return false;
      if (q && !`${e.actor} ${e.summary} ${e.action} ${e.entity}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, action, query]);

  return (
    <Stack gap={space.lg}>
      <Card>
        <SectionHeader label="Who changed what" />
        <Small muted>
          Capacity reports, dispatches, bed holds, verification decisions and account changes — attributed to a
          named actor with a timestamp and source address. Entries are never edited or deleted.
        </Small>
        <Row gap={space.md} wrap style={{ marginTop: space.md }} align="center">
          <View style={{ minWidth: 240, flex: 1 }}>
            <TextField
              label="Search"
              value={query}
              onChangeText={setQuery}
              placeholder="actor, action or summary"
              icon="search"
            />
          </View>
        </Row>
        <Row gap={space.sm} wrap style={{ marginTop: space.md }}>
          <Segmented
            size="sm"
            value={action}
            onChange={setAction}
            options={[
              { value: 'all', label: `All ${entries.length}` },
              ...families.slice(0, 6).map(([f, n]) => ({ value: f, label: `${f} ${n}` })),
            ]}
          />
        </Row>
      </Card>

      <Card padded={false}>
        <View style={[styles.thead, { borderBottomColor: t.line.base }]}>
          <Small muted style={styles.aTime}>
            When
          </Small>
          <Small muted style={styles.aActor}>
            Actor
          </Small>
          <Small muted style={styles.aAction}>
            Action
          </Small>
          <Small muted style={styles.aSummary}>
            Summary
          </Small>
        </View>
        {rows.length === 0 ? (
          <EmptyState icon="activity" title="Nothing matches" body="Widen the time window or clear the filter." />
        ) : (
          rows.slice(0, 250).map((e, i) => (
            <View
              key={e.id}
              style={[
                styles.trow,
                {
                  borderBottomColor: t.line.subtle,
                  backgroundColor: i % 2 ? t.bg.sunken : 'transparent',
                },
              ]}
            >
              <Stack gap={1} style={styles.aTime}>
                <Small>{relativeFromIso(e.at)}</Small>
                {isDesktop ? (
                  <Small muted style={{ fontSize: 10.5 }}>
                    {e.at.slice(11, 19)}Z
                  </Small>
                ) : null}
              </Stack>
              <Stack gap={1} style={styles.aActor}>
                <Small>{e.actor}</Small>
                <Small muted style={{ fontSize: 10.5 }}>
                  {e.role}
                </Small>
              </Stack>
              <View style={styles.aAction}>
                <Pill label={e.action} tone="neutral" />
              </View>
              <Stack gap={1} style={styles.aSummary}>
                <Small>{e.summary}</Small>
                <Small muted style={{ fontSize: 10.5 }}>
                  {e.entity}
                  {e.ip ? ` · ${e.ip}` : ''}
                </Small>
              </Stack>
            </View>
          ))
        )}
      </Card>
    </Stack>
  );
}

/* ------------------------------------------------------------- onboarding */

function OnboardingPanel({
  queue,
  onChange,
  onFlash,
}: {
  queue: OnboardingApplication[];
  onChange: () => void;
  onFlash: (f: { tone: 'live' | 'warm' | 'critical'; title: string; body?: string }) => void;
}) {
  const { t } = useTheme();
  const { token } = useAuth();
  const [busy, setBusy] = useState<number | null>(null);
  const [choice, setChoice] = useState<Record<number, 'manual' | 'fhir_r4' | 'vendor_rest'>>({});

  const decide = useCallback(
    async (app: OnboardingApplication, decision: 'verify' | 'refuse') => {
      if (!token) return;
      setBusy(app.hospital_id);
      const integration = choice[app.hospital_id] ?? 'manual';
      try {
        await api.post(
          '/onboarding/decide',
          {
            hospital_id: app.hospital_id,
            decision,
            ...(decision === 'verify'
              ? {
                  integration,
                  connector_kind: integration === 'manual' ? 'manual' : integration,
                }
              : {}),
          },
          { token },
        );
        onFlash({
          tone: decision === 'verify' ? 'live' : 'warm',
          title:
            decision === 'verify'
              ? `${app.short_name} is verified and published`
              : `${app.short_name} was not admitted`,
          body:
            decision === 'verify'
              ? integration === 'manual'
                ? 'They will appear in the directory once they enter figures through the facility portal.'
                : 'A connector was created for them — issue its key from the connectors tab.'
              : 'The decision is recorded against the application in the audit log.',
        });
        onChange();
      } catch (err) {
        onFlash({
          tone: 'critical',
          title: 'Decision not recorded',
          body: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [token, choice, onChange, onFlash],
  );

  return (
    <Stack gap={space.lg}>
      <Card>
        <SectionHeader label="Verification queue" />
        <Small muted>
          A facility lands here when it applies through the public form. It is not published until somebody
          looks at it: an unverified listing that turns out to be wrong costs a family an hour they do not have,
          and the directory carries the reputation of the whole platform.
        </Small>
      </Card>

      {queue.length === 0 ? (
        <Card>
          <EmptyState icon="shield" title="Nothing waiting" body="Every application has been decided." />
        </Card>
      ) : (
        queue.map((app) => {
          const pick = choice[app.hospital_id] ?? 'manual';
          return (
            <Card key={app.hospital_id}>
              <Row justify="space-between" align="flex-start" wrap gap={space.md}>
                <Stack gap={space.sm} style={{ flex: 1, minWidth: 260 }}>
                  <Row gap={space.sm} align="center" wrap>
                    <Title style={{ fontSize: 16 }}>{app.name}</Title>
                    <Pill label={app.type} tone="neutral" />
                    {app.connector_kind ? <Pill label={`connector: ${app.connector_kind}`} tone="info" /> : null}
                  </Row>
                  <Row gap={space.lg} wrap>
                    <KV label="Reference" value={`MM-ONB-${String(app.hospital_id).padStart(5, '0')}`} mono />
                    <KV label="District" value={app.district ?? '—'} />
                    <KV label="Applied" value={app.applied_at ? relativeFromIso(app.applied_at) : '—'} />
                    <KV label="Phone" value={"on file"} />
                  </Row>
                  <Row gap={space.lg} wrap>
                    <KV label="Beds" value={String(app.beds)} mono />
                    <KV label="ICU" value={String(app.icu)} mono />
                    <KV label="Ventilators" value={String(app.ventilators)} mono />
                  </Row>
                  <Row gap={space.sm} wrap>
                    {app.specialties.map((s) => (
                      <Pill key={s} label={s.replace(/_/g, ' ')} tone="neutral" />
                    ))}
                  </Row>
                  <Small muted>{app.address}</Small>
                </Stack>

                <Stack gap={space.sm} style={{ minWidth: 220 }}>
                  <Label>How will they report</Label>
                  <Segmented
                    size="sm"
                    value={pick}
                    onChange={(v) =>
                      setChoice((prev) => ({ ...prev, [app.hospital_id]: v as 'manual' | 'fhir_r4' | 'vendor_rest' }))
                    }
                    options={[
                      { value: 'manual' as const, label: 'Keypad' },
                      { value: 'fhir_r4' as const, label: 'FHIR' },
                      { value: 'vendor_rest' as const, label: 'REST' },
                    ]}
                  />
                  <Small muted>
                    {pick === 'manual'
                      ? 'Staff type figures into the facility portal. Still the majority of the network.'
                      : 'A connector is created in the never-seen state; send them the ingest URL.'}
                  </Small>
                  <Row gap={space.sm}>
                    <Button
                      label="Verify"
                      icon="check"
                      variant="primary"
                      onPress={() => decide(app, 'verify')}
                      loading={busy === app.hospital_id}
                    />
                    <Button
                      label="Refuse"
                      variant="ghost"
                      onPress={() => decide(app, 'refuse')}
                      disabled={busy === app.hospital_id}
                    />
                  </Row>
                </Stack>
              </Row>
            </Card>
          );
        })
      )}

      <Card>
        <SectionHeader label="What the applicant is told" />
        <Small muted>
          Approving is not the end of the process: a manual facility needs somebody walked through the keypad,
          and an API facility needs the key handed over and a first successful push confirmed. That handover is
          why the queue keeps the decision rather than just flipping a flag.
        </Small>
      </Card>
    </Stack>
  );
}

const styles = StyleSheet.create({
  thead: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.md,
  },
  trow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: space.md,
  },
  cName: { flex: 3, minWidth: 150 },
  cRole: { flex: 2, minWidth: 110 },
  cKind: { flex: 2, minWidth: 100 },
  cScope: { flex: 2, minWidth: 100 },
  cSeen: { flex: 2, minWidth: 100 },
  cState: { flex: 3, minWidth: 140 },
  aTime: { flex: 1, minWidth: 84 },
  aActor: { flex: 1.4, minWidth: 110 },
  aAction: { flex: 1.4, minWidth: 110 },
  aSummary: { flex: 4, minWidth: 180 },
  codeBox: {
    marginTop: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: 260,
    overflow: 'hidden',
  },
  keyBox: {
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
