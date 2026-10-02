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
import { DistrictField, FacilityPicker, VehicleField } from '../../src/components/Selectors';
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
  ConfirmDialog,
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
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditHasMore, setAuditHasMore] = useState(false);
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
          api.get<{ results: AuditEntry[]; total?: number; has_more?: boolean }>(
            '/governance/audit?hours=72&limit=200',
            { token },
          ),
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
        setAuditTotal(a.total ?? a.results.length);
        setAuditHasMore(Boolean(a.has_more));
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

  /**
   * Fetch the next page of the audit trail.
   *
   * The panel pages locally first — 200 rows is more than anyone reads in one
   * sitting — and calls this only when the reader has actually reached the end
   * of what was fetched. Rows already held are dropped by id, so a page boundary
   * that shifts under a live write cannot duplicate an entry.
   */
  const loadMoreAudit = useCallback(async () => {
    if (!token) return;
    const res = await api.get<{ results: AuditEntry[]; total?: number; has_more?: boolean }>(
      `/governance/audit?hours=72&limit=200&offset=${audit.length}`,
      { token },
    );
    setAudit((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      return [...prev, ...res.results.filter((e) => !seen.has(e.id))];
    });
    setAuditTotal(res.total ?? auditTotal);
    setAuditHasMore(Boolean(res.has_more));
  }, [token, audit.length, auditTotal]);

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
          {/* scroll: the five tab labels need ~500px; letting them wrap inside
              the segmented row is how this page keeps working at 360px. */}
          <Segmented
            size="sm"
            scroll
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
            districts={districts}
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

        {tab === 'audit' ? (
          <AuditPanel entries={audit} total={auditTotal} hasMore={auditHasMore} onLoadMore={loadMoreAudit} />
        ) : null}
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
  const [facilityPickerOpen, setFacilityPickerOpen] = useState(false);
  const [toggleTarget, setToggleTarget] = useState<AdminUser | null>(null);
  const [facilityPickerForEdit, setFacilityPickerForEdit] = useState(false);
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: '',
    email: '',
    role: 'hospital_admin' as Role,
    hospital_id: '',
    district_id: '',
    ambulance_id: '',
  });

  // The vehicle picker in the edit form. Fetched only when a crew account is
  // being edited — sixty-six call signs is nothing, but there is no reason to
  // carry them for a ward account edit.
  const [fleet, setFleet] = useState<Ambulance[]>([]);
  useEffect(() => {
    if (editForm.role !== 'driver' || !token) return;
    let cancelled = false;
    api
      .get<{ results: Ambulance[] }>('/ambulances?limit=200', { token })
      .then((res) => !cancelled && setFleet(res.results))
      .catch(() => !cancelled && setFleet([]));
    return () => {
      cancelled = true;
    };
  }, [editForm.role, token]);

  const startEdit = useCallback((u: AdminUser) => {
    setEditing(u);
    setEditForm({
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      hospital_id: u.hospital_id ? String(u.hospital_id) : '',
      district_id: u.district_id ? String(u.district_id) : '',
      ambulance_id: u.ambulance_id ? String(u.ambulance_id) : '',
    });
  }, []);

  /**
   * Save an account edit (#37).
   *
   * Provisioning used to be one-way: a dispatcher who moved hospitals, or a
   * ward account that should have been scoped to the new annex, had to be
   * disabled and recreated — which throws away the audit history attached to
   * the old id, and the audit history is the part anybody comes back for.
   */
  const saveEdit = useCallback(async () => {
    if (!token || !editing) return;
    setBusy(editing.id);
    try {
      await api.patch(
        `/governance/users/${editing.id}`,
        {
          full_name: editForm.full_name.trim(),
          email: editForm.email.trim().toLowerCase(),
          role: editForm.role,
          hospital_id: editForm.hospital_id ? Number(editForm.hospital_id) : null,
          district_id: editForm.district_id ? Number(editForm.district_id) : null,
          ambulance_id: editForm.ambulance_id ? Number(editForm.ambulance_id) : null,
        },
        { token },
      );
      onFlash({ tone: 'live', title: `${editForm.full_name} updated`, body: 'The change is in the audit log.' });
      setEditing(null);
      onChange();
    } catch (err) {
      onFlash({
        tone: 'critical',
        title: 'That edit was refused',
        body: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }, [token, editing, editForm, onChange, onFlash]);

  const selectedFacility = useMemo(
    () => facilities.find((f) => String(f.id) === form.hospital_id) ?? null,
    [facilities, form.hospital_id],
  );

  // The pickers want a facility count per district and the admin list calls it
  // `hospital_count`. Mapped here rather than widening either type.
  const pickerDistricts = useMemo(
    () =>
      districts.map((d: District) => ({
        id: d.id,
        name: d.name,
        name_ta: d.name_ta ?? null,
        facilities: d.hospital_count ?? 0,
      })),
    [districts],
  );

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

  /**
   * Disable or re-enable an account, behind a confirmation (#38).
   *
   * The row's button used to flip `is_active` on a single click, in a table of
   * forty accounts where a mis-click is one wrong row. Disabling someone is the
   * kind of action that pages a platform operator at midnight, so it now says
   * who, what and what it means before it happens. Re-enabling is the same
   * dialog — the asymmetry would imply one direction is safe to hit by accident.
   */
  const confirmToggle = useCallback(
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
        /* align flex-start, not center: on a wrapping row the default
           alignment lets the button column keep its intrinsic width on a
           narrow phone instead of moving under the title. */
        <Row justify="space-between" align="flex-start" wrap gap={space.md}>
          <Stack gap={2} style={{ flexShrink: 1 }}>
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
                  {/* Was a chip row of the first fourteen facilities, with no
                      indication that there were a hundred and thirty more and no
                      way to reach them: an account for any facility outside the
                      first page of the list simply could not be created. The
                      shared picker searches all of them and says when it is
                      showing a subset. */}
                  {facilityPickerOpen ? (
                    <FacilityPicker
                      facilities={facilities}
                      districts={pickerDistricts}
                      value={form.hospital_id ? Number(form.hospital_id) : null}
                      title="Facility this account reports for"
                      districtField
                      onPick={(id) => {
                        setForm((prev) => ({ ...prev, hospital_id: String(id) }));
                        setFacilityPickerOpen(false);
                      }}
                      onClose={() => setFacilityPickerOpen(false)}
                    />
                  ) : (
                    <Button
                      label={
                        selectedFacility
                          ? `${selectedFacility.short_name} · ${selectedFacility.district_name ?? ''}`.trim()
                          : `Choose from ${facilities.length} facilities`
                      }
                      icon="hospital"
                      variant={selectedFacility ? 'secondary' : 'primary'}
                      onPress={() => setFacilityPickerOpen(true)}
                    />
                  )}
                  <Small muted>
                    A hospital account is scoped to one facility, and the API refuses it without one — an
                    unscoped bed-control login is how a facility ends up editing somebody else's numbers.
                  </Small>
                </Stack>
              ) : null}

              {form.role !== 'hospital_admin' ? (
                <Stack gap="sm">
                  {/* Role-specific wording (#9): "jurisdiction" is what a
                      dispatcher or official is scoped to; a driver's district
                      is where they report. Same control, honest label. */}
                  <DistrictField
                    districts={pickerDistricts}
                    value={form.district_id ? Number(form.district_id) : null}
                    onChange={(id) => setForm((f) => ({ ...f, district_id: String(id) }))}
                    label={form.role === 'driver' ? 'Reporting district' : 'Jurisdiction'}
                    placeholder="Choose district"
                    hideAll
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
                      <VehicleField
                        vehicles={crewless}
                        districts={pickerDistricts}
                        value={form.ambulance_id ? Number(form.ambulance_id) : null}
                        onChange={(id) => setForm((f) => ({ ...f, ambulance_id: id ? String(id) : '' }))}
                        label="Vehicle"
                        placeholder={`Choose from ${crewless.length} uncrewed vehicles`}
                        clearLabel="Link later"
                        title="Vehicles without a crew"
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
          scroll
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
        {/* The header row describes the desktop table's columns. On a phone the
            rows are two stacked lines, so column headings would label nothing —
            the strip says what the list is instead. */}
        <View style={[styles.thead, { borderBottomColor: t.line.base }]}>
          {isDesktop ? (
            <>
              <Small muted style={styles.cName}>
                Person
              </Small>
              <Small muted style={styles.cRole}>
                Role
              </Small>
              <Small muted style={styles.cScope}>
                Scope
              </Small>
              <Small muted style={styles.cSeen}>
                Last sign-in
              </Small>
              <Small muted style={styles.cState}>
                State
              </Small>
            </>
          ) : (
            <Small muted>
              {filtered.length} account{filtered.length === 1 ? '' : 's'}
            </Small>
          )}
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
              /* One line on a desktop, two on a phone. The single-row layout
                 needs ~400px of minimums (name, role pill, state + two ghost
                 buttons); at 360px that either overflowed the card or wrapped
                 the header differently from the rows. Stacked, every element
                 has room and nothing has to shrink below its content. */
              isDesktop ? null : { flexDirection: 'column', alignItems: 'stretch', gap: space.xs },
            ]}
          >
            {isDesktop ? (
              <>
                <Stack gap={2} style={styles.cName}>
                  <Small>{u.full_name}</Small>
                  <Small muted style={{ fontSize: 11.5 }}>
                    {u.email}
                  </Small>
                </Stack>
                <View style={styles.cRole}>
                  <Pill label={ROLE_LABEL[u.role] ?? u.role} tone={u.role === 'platform_admin' ? 'info' : 'neutral'} />
                </View>
                <Small muted style={styles.cScope}>
                  {u.hospital ?? u.district ?? '—'}
                </Small>
                <Small muted style={styles.cSeen}>
                  {u.last_login_at ? relativeFromIso(u.last_login_at) : 'never'}
                </Small>
                <Row gap={space.sm} align="center" wrap style={styles.cState}>
                  <StatusDot tone={u.is_active ? 'live' : 'neutral'} />
                  <Small muted>{u.is_active ? 'active' : 'disabled'}</Small>
                  <Button label="Edit" size="sm" variant="ghost" onPress={() => startEdit(u)} />
                  <Button
                    label={u.is_active ? 'Disable' : 'Enable'}
                    size="sm"
                    variant="ghost"
                    onPress={() => setToggleTarget(u)}
                    disabled={u.id === user?.id}
                  />
                </Row>
              </>
            ) : (
              <>
                <Row gap={space.sm} align="center" justify="space-between" wrap>
                  <Stack gap={2} style={{ flexShrink: 1 }}>
                    <Small>{u.full_name}</Small>
                    {/* minWidth:0 lets the address ellipsize instead of holding
                        the row open — RN-web text will not shrink below its
                        longest word otherwise. */}
                    <View style={{ minWidth: 0 }}>
                      <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
                        {u.email}
                      </Small>
                    </View>
                  </Stack>
                  <Pill label={ROLE_LABEL[u.role] ?? u.role} tone={u.role === 'platform_admin' ? 'info' : 'neutral'} />
                </Row>
                <Row gap={space.sm} align="center" wrap>
                  <StatusDot tone={u.is_active ? 'live' : 'neutral'} />
                  <Small muted>{u.is_active ? 'active' : 'disabled'}</Small>
                  {u.last_login_at ? (
                    <Small muted style={{ fontSize: 11 }}>· seen {relativeFromIso(u.last_login_at)}</Small>
                  ) : null}
                  <View style={{ flexGrow: 1 }} />
                  <Button label="Edit" size="sm" variant="ghost" onPress={() => startEdit(u)} />
                  <Button
                    label={u.is_active ? 'Disable' : 'Enable'}
                    size="sm"
                    variant="ghost"
                    onPress={() => setToggleTarget(u)}
                    disabled={u.id === user?.id}
                  />
                </Row>
              </>
            )}
          </View>
        ))}
      </Card>

      {editing ? (
        <Card style={{ gap: space.md }}>
          <Row justify="space-between" align="center">
            <SectionHeader label={`Editing ${editing.full_name}`} />
            <Button label="Close" size="sm" variant="ghost" onPress={() => setEditing(null)} />
          </Row>
          <Row gap="md" wrap>
            <View style={{ flex: 1, minWidth: 200 }}>
              <TextField
                label="Full name"
                value={editForm.full_name}
                onChangeText={(v) => setEditForm((f) => ({ ...f, full_name: v }))}
              />
            </View>
            <View style={{ flex: 1, minWidth: 220 }}>
              <TextField
                label="Email"
                value={editForm.email}
                onChangeText={(v) => setEditForm((f) => ({ ...f, email: v }))}
                autoCapitalize="none"
              />
            </View>
          </Row>
          <Stack gap={6}>
            <Label>Role</Label>
            <Segmented
              size="sm"
              value={editForm.role}
              onChange={(v) => setEditForm((f) => ({ ...f, role: v }))}
              options={[
                { value: 'hospital_admin' as Role, label: 'Hospital' },
                { value: 'dispatcher' as Role, label: 'Dispatcher' },
                { value: 'driver' as Role, label: 'Crew' },
                { value: 'gov_official' as Role, label: 'Govt' },
                { value: 'platform_admin' as Role, label: 'Platform' },
              ]}
            />
          </Stack>

          {editForm.role === 'hospital_admin' ? (
            <Stack gap={6}>
              <Label>Facility</Label>
              {facilityPickerForEdit ? (
                <FacilityPicker
                  facilities={facilities}
                  districts={pickerDistricts}
                  value={editForm.hospital_id ? Number(editForm.hospital_id) : null}
                  title="Facility this account reports for"
                  districtField
                  onPick={(id) => {
                    setEditForm((f) => ({ ...f, hospital_id: String(id) }));
                    setFacilityPickerForEdit(false);
                  }}
                  onClose={() => setFacilityPickerForEdit(false)}
                />
              ) : (
                <Button
                  label={
                    facilities.find((f) => String(f.id) === editForm.hospital_id)?.short_name ??
                    `Choose from ${facilities.length} facilities`
                  }
                  icon="hospital"
                  variant={editForm.hospital_id ? 'secondary' : 'primary'}
                  onPress={() => setFacilityPickerForEdit(true)}
                />
              )}
            </Stack>
          ) : null}

          {editForm.role === 'dispatcher' || editForm.role === 'gov_official' ? (
            <DistrictField
              districts={pickerDistricts}
              value={editForm.district_id ? Number(editForm.district_id) : null}
              onChange={(id) => setEditForm((f) => ({ ...f, district_id: String(id) }))}
              label="Jurisdiction"
              placeholder="Choose district"
              hideAll
            />
          ) : null}

          {editForm.role === 'driver' ? (
            <Stack gap={6}>
              <VehicleField
                vehicles={fleet}
                districts={pickerDistricts}
                value={editForm.ambulance_id ? Number(editForm.ambulance_id) : null}
                onChange={(id) => setEditForm((f) => ({ ...f, ambulance_id: id ? String(id) : '' }))}
                label="Vehicle — optional, a crew account can be unlinked"
                placeholder={`Choose from ${fleet.length} vehicles`}
                clearLabel="No vehicle"
                title="Link this account to a vehicle"
              />
              <Small muted>
                The whole fleet is listed here, not only uncrewed units: re-linking an account to a
                vehicle that already has a driver moves them, and the previous vehicle is released in
                the same request.
              </Small>
            </Stack>
          ) : null}

          <Row gap="sm">
            <Button
              label="Save changes"
              icon="check"
              onPress={saveEdit}
              loading={busy === editing.id}
              disabled={!editForm.full_name.trim() || !editForm.email.includes('@')}
            />
            <Button label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
          </Row>
        </Card>
      ) : null}

      {/* #38: the disable switch used to fire on the row's own button. */}
      <ConfirmDialog
        visible={toggleTarget !== null}
        tone={toggleTarget?.is_active ? 'danger' : undefined}
        title={
          toggleTarget
            ? toggleTarget.is_active
              ? `Disable ${toggleTarget.full_name}?`
              : `Re-enable ${toggleTarget.full_name}?`
            : 'Change account'
        }
        body={
          toggleTarget?.is_active
            ? 'They keep the record of their work and it stays in the audit log, but every open session dies at the next request and they cannot sign in again until somebody re-enables them.'
            : 'Their existing sessions become valid again and they can sign in with their current password.'
        }
        confirmLabel={toggleTarget?.is_active ? 'Disable account' : 'Re-enable account'}
        busy={toggleTarget ? busy === toggleTarget.id : false}
        onConfirm={() => {
          const target = toggleTarget;
          setToggleTarget(null);
          if (target) void confirmToggle(target);
        }}
        onCancel={() => setToggleTarget(null)}
      />

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
  districts,
  onChange,
  onFlash,
}: {
  connectors: Connector[];
  estate: ConnectorEstate | null;
  templates: ConnectorTemplate[];
  facilities: Facility[];
  districts: District[];
  onChange: () => void;
  onFlash: (f: { tone: 'live' | 'warm' | 'critical'; title: string; body?: string }) => void;
}) {
  const { t } = useTheme();
  const { token } = useAuth();
  const { isDesktop } = useResponsive();

  const [creating, setCreating] = useState(false);
  const [connectorPickerOpen, setConnectorPickerOpen] = useState(false);
  const [facilityId, setFacilityId] = useState('');
  const [kind, setKind] = useState<'fhir_r4' | 'vendor_rest' | 'csv_sftp' | 'manual'>('fhir_r4');
  const [sourceSystem, setSourceSystem] = useState('');
  const [issued, setIssued] = useState<IssuedConnectorKey | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [testing, setTesting] = useState<{ id: number; ok: boolean; message: string } | null>(null);
  const [openTemplate, setOpenTemplate] = useState<string | null>(null);

  const selected = facilities.find((f) => String(f.id) === facilityId);
  const selectedTemplate = templates.find((tp) => tp.kind === kind);

  const verifiedFacilities = useMemo(
    () =>
      facilities
        .filter((f) => f.verification === 'verified')
        .map((f) => ({
          id: f.id,
          name: f.name,
          short_name: f.short_name,
          district_id: f.district_id,
          district_name: f.district_name,
          type_label: f.type_label,
          verification: f.verification,
          integration: f.integration,
        })),
    [facilities],
  );

  const pickerDistricts = useMemo(
    () =>
      districts.map((d) => ({
        id: d.id,
        name: d.name,
        name_ta: d.name_ta ?? null,
        facilities: d.hospital_count ?? 0,
      })),
    [districts],
  );

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
        <Row justify="space-between" align="flex-start" wrap gap={space.md}>
          <Stack gap={2} style={{ flexShrink: 1 }}>
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
              {/* #20: this was every verified facility in a horizontal scroll —
                  152 chips on the pilot dataset, and reaching the one you wanted
                  meant dragging past the alphabet. Search plus a district filter,
                  the same picker the rest of the console uses. */}
              {connectorPickerOpen ? (
                <FacilityPicker
                  facilities={verifiedFacilities}
                  districts={pickerDistricts}
                  value={facilityId ? Number(facilityId) : null}
                  title="Facility this connector reports for"
                  districtField
                  onPick={(id) => {
                    setFacilityId(String(id));
                    setConnectorPickerOpen(false);
                  }}
                  onClose={() => setConnectorPickerOpen(false)}
                />
              ) : (
                <Button
                  label={
                    selected
                      ? `${selected.short_name} · ${selected.district_name ?? ''}`.trim()
                      : `Choose from ${verifiedFacilities.length} verified facilities`
                  }
                  icon="search"
                  variant={selected ? 'secondary' : 'primary'}
                  onPress={() => setConnectorPickerOpen(true)}
                />
              )}
              {selected ? (
                <Small muted>
                  {selected.name} · currently {selected.integration === 'api' ? 'API' : 'manual entry'}
                </Small>
              ) : (
                <Small muted>
                  A connector is bound to one facility and can only write that facility's figures.
                </Small>
              )}
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
              <Row justify="space-between" align="flex-start" wrap gap={space.md}>
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
  // The complaint being closed, with the reviewer's decision attached. Null when
  // nothing is open.
  const [closing, setClosing] = useState<{
    complaint: Complaint;
    outcome: 'upheld' | 'dismissed' | 'under_review';
    note: string;
  } | null>(null);

  const rows = useMemo(
    () => complaints.filter((c) => (onlyOpen ? c.status === 'open' : true)),
    [complaints, onlyOpen],
  );

  /**
   * Close a complaint, with the decision the reviewer actually made.
   *
   * The old handler sent a fixed `{resolution: "resolved"}` with the note
   * "Confirmed against the facility bed-control desk" and a button that said
   * "Mark resolved" — so every complaint in the pilot's audit trail claimed the
   * same investigation, whether or not there had been one. A report that is
   * upheld costs the facility trust score and one that is dismissed does not,
   * and that distinction is the entire point of the record.
   */
  const submitResolution = useCallback(async () => {
    if (!token || !closing) return;
    const { complaint, outcome, note } = closing;
    setBusy(complaint.id);
    try {
      await api.post(
        `/governance/feedback/${complaint.id}/resolve`,
        { status: outcome, resolution_note: note.trim() || null },
        { token },
      );
      onFlash({
        tone: outcome === 'upheld' ? 'warm' : 'live',
        title:
          outcome === 'upheld'
            ? `Upheld — ${complaint.hospital_name} is penalised`
            : outcome === 'dismissed'
              ? `Dismissed — ${complaint.hospital_name} is cleared`
              : `Left under review`,
        body:
          outcome === 'upheld'
            ? 'An upheld report continues to count against the facility trust score.'
            : outcome === 'dismissed'
              ? 'It no longer counts against the facility trust score.'
              : 'The report stays open against the facility until it is decided.',
      });
      setClosing(null);
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
  }, [token, closing, onChange, onFlash]);

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
        <Row justify="space-between" align="flex-start" wrap gap={space.md}>
          <Stack gap={2} style={{ flexShrink: 1 }}>
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
                label="Review & close"
                icon="check"
                variant="secondary"
                onPress={() =>
                  setClosing({ complaint: c, outcome: 'upheld', note: '' })
                }
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

      {/* The resolution form. Closing a report is a decision about a facility's
          trust score, so it asks which decision: upheld costs them, dismissed
          clears them, and the note is what the next reviewer reads. */}
      <ConfirmDialog
        visible={closing !== null}
        title={closing ? `Close the report against ${closing.complaint.hospital_name}` : 'Close report'}
        body={
          closing ? (
            <Stack gap={space.sm}>
              <Small muted style={{ fontSize: 12 }}>
                “{closing.complaint.comment || 'No detail supplied.'}”
              </Small>
              <Label>Outcome</Label>
              <Segmented
                size="sm"
                scroll
                value={closing.outcome}
                onChange={(v) => setClosing((prev) => (prev ? { ...prev, outcome: v } : prev))}
                options={[
                  { value: 'upheld', label: 'Upheld' },
                  { value: 'dismissed', label: 'Dismissed' },
                  { value: 'under_review', label: 'Under review' },
                ]}
              />
              <Small muted style={{ fontSize: 11.5 }}>
                {closing.outcome === 'upheld'
                  ? 'The report stands. It continues to count against the facility trust score.'
                  : closing.outcome === 'dismissed'
                    ? 'The report was checked and found wrong. It stops counting against the score.'
                    : 'Keep it open pending the facility\u2019s response.'}
              </Small>
            </Stack>
          ) : null
        }
        confirmLabel="Record decision"
        busy={closing ? busy === closing.complaint.id : false}
        onConfirm={submitResolution}
        onCancel={() => setClosing(null)}
      >
        {closing ? (
          <TextField
            label="How was it checked?"
            value={closing.note}
            onChangeText={(v) => setClosing((prev) => (prev ? { ...prev, note: v } : prev))}
            placeholder="e.g. rung the bed-control desk; they had four beds free and the listing was stale"
            multiline
            maxLength={300}
            hint="Read by the next reviewer and written to the audit trail."
          />
        ) : null}
      </ConfirmDialog>
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
function AuditPanel({
  entries,
  total,
  hasMore,
  onLoadMore,
}: {
  entries: AuditEntry[];
  total: number;
  hasMore: boolean;
  onLoadMore: () => Promise<void>;
}) {
  const { t } = useTheme();
  const { isDesktop } = useResponsive();
  const [action, setAction] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [paging, setPaging] = useState(false);
  // How many of the fetched rows are on screen. The list used to be cut at 250
  // without a word; now the page size is ours to set and the control says how
  // many are left, so "there is more" is never something the reader has to infer.
  const [shown, setShown] = useState(50);

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

  // A filter change is a new question, so the list starts again from the top
  // rather than keeping a page depth that no longer means anything.
  useEffect(() => {
    setShown(50);
  }, [action, query]);

  const page = rows.slice(0, shown);
  const remaining = rows.length - page.length;
  const reachable = total - entries.length;

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
          page.map((e, i) => (
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

        {/* Paging control. Two distinct "more": rows already fetched and hidden,
            and rows the server has that we have not asked for yet. The reader is
            told which, because the two cost different things to get. */}
        {(remaining > 0 || (hasMore && reachable > 0)) && !query ? (
          <Row
            justify="space-between"
            align="center"
            gap={space.md}
            wrap
            style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}
          >
            <Small muted style={{ fontSize: 11.5 }}>
              Showing {page.length} of {total.toLocaleString()} entries in this window
              {reachable > 0 && hasMore ? ` · ${reachable.toLocaleString()} not yet fetched` : ''}
            </Small>
            <Row gap={space.sm}>
              {remaining > 0 ? (
                <Button
                  label={`Show ${Math.min(50, remaining)} more`}
                  size="sm"
                  variant="secondary"
                  onPress={() => setShown((v) => v + 50)}
                />
              ) : null}
              {hasMore && reachable <= 0 ? (
                <Button
                  label="Fetch older entries"
                  size="sm"
                  variant="secondary"
                  icon="chevronDown"
                  loading={paging}
                  onPress={async () => {
                    setPaging(true);
                    try {
                      await onLoadMore();
                      setShown((v) => v + 50);
                    } finally {
                      setPaging(false);
                    }
                  }}
                />
              ) : null}
            </Row>
          </Row>
        ) : null}
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
  /* minWidths are what keep the mobile card's columns side by side instead of
     collapsing; they are sized so the whole row still fits a 360px phone. */
  cName: { flex: 5, minWidth: 110 },
  cRole: { flex: 3, minWidth: 84 },
  cKind: { flex: 2, minWidth: 100 },
  cScope: { flex: 4, minWidth: 104 },
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
