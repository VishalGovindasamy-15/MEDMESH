/**
 * Fleet management — the panel that makes an ambulance a real record.
 *
 * Until this existed, `Ambulance.driver_id` was a column the seeder happened to
 * fill in. There was no way to add a vehicle, no way to re-base one, no way to
 * change what it carried, and no way to say who drove it. The practical effect
 * was that the demo worked and nothing else did: a control room onboarding a
 * real unit had to edit the database, and a driver account created through the
 * account screen had no vehicle, so `GET /crew/assignment` could not tell them
 * what they were driving.
 *
 * The panel is deliberately organised the way a fleet office works rather than
 * the way the table is shaped. The list answers "what do we have and is it
 * crewed"; the row answers "what is wrong with this one"; editing is one form
 * per attribute of the vehicle, and the crew link is its own control because
 * moving a driver between vehicles is the operation that actually happens.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { api, ApiError } from '../../src/api/client';
import type { Ambulance, District, Facility, FleetDirectory } from '../../src/api/types';
import { relativeFromIso } from '../../src/lib/format';
import { useAuth } from '../../src/state/AuthProvider';
import { useTheme } from '../../src/theme/ThemeProvider';
import { space } from '../../src/theme/tokens';
import {
  Banner,
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
  Segmented,
  Small,
  Stack,
  TextField,
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';

const CAPABILITIES: { value: string; label: string; short: string }[] = [
  { value: 'bls', label: 'BLS · basic life support', short: 'BLS' },
  { value: 'als', label: 'ALS · advanced life support', short: 'ALS' },
  { value: 'nicu', label: 'NICU · neonatal transport', short: 'NICU' },
  { value: 'mortuary', label: 'Mortuary transport', short: 'Mortuary' },
];

const STATUS_TONE: Record<string, 'live' | 'warm' | 'critical' | 'neutral'> = {
  available: 'live',
  en_route: 'warm',
  at_scene: 'warm',
  transporting: 'warm',
  out_of_service: 'critical',
};

const EMPTY_FORM = {
  call_sign: '',
  registration: '',
  operator_type: '108' as '108' | 'private',
  operator_name: '108 Emergency Response',
  base_district_id: '',
  capabilities: ['bls'] as string[],
  lat: '',
  lng: '',
};

type Flash = (f: { tone: 'live' | 'warm' | 'critical'; title: string; body?: string }) => void;

/**
 * `KeyValue` renders a label and a right-aligned value; this wrapper spells out
 * the monospace case so a figure is not formatted by hand at every call site.
 */
function KV({
  label,
  value,
  mono,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'warn';
}) {
  const { t } = useTheme();
  return (
    <View style={{ minWidth: 150 }}>
      <Small muted style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Small>
      {mono ? (
        <Num size={12.5}>{value}</Num>
      ) : (
        <Small style={tone === 'warn' ? { color: t.status.warm.base } : undefined}>{value}</Small>
      )}
    </View>
  );
}

export function FleetPanel({
  districts,
  onChange,
  onFlash,
}: {
  districts: District[];
  onChange: () => void;
  onFlash: Flash;
}) {
  const { token } = useAuth();
  const { t } = useTheme();

  const [fleet, setFleet] = useState<Ambulance[] | null>(null);
  const [directory, setDirectory] = useState<FleetDirectory | null>(null);
  const [filter, setFilter] = useState<'all' | 'uncrewed' | 'out_of_service'>('all');
  const [districtFilter, setDistrictFilter] = useState<string>('all');
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [editing, setEditing] = useState<Ambulance | null>(null);
  // #39: releasing a crew account makes the vehicle undispatchable, which in a
  // live district is a decision, not a click. The dialog states what it costs.
  const [releasing, setReleasing] = useState<Ambulance | null>(null);
  const [busy, setBusy] = useState<number | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const [units, dir] = await Promise.all([
        api.get<{ results: Ambulance[]; count: number }>('/ambulances?limit=500', { token }),
        api.get<FleetDirectory>('/ambulances/drivers', { token }),
      ]);
      setFleet(units.results);
      setDirectory(dir);
    } catch (err) {
      setFleet([]);
      setError(err instanceof ApiError ? err.message : 'Could not load the fleet');
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const districtName = useCallback(
    (id?: number | null) => districts.find((d) => d.id === id)?.name ?? '—',
    [districts],
  );

  const units = useMemo(() => {
    const all = fleet ?? [];
    const needle = query.trim().toLowerCase();
    return all.filter((a) => {
      if (filter === 'uncrewed' && a.driver) return false;
      if (filter === 'out_of_service' && a.status !== 'out_of_service') return false;
      if (districtFilter !== 'all' && String(a.base_district_id) !== districtFilter) return false;
      if (!needle) return true;
      return (
        a.call_sign.toLowerCase().includes(needle) ||
        a.registration.toLowerCase().includes(needle) ||
        (a.driver?.full_name ?? '').toLowerCase().includes(needle)
      );
    });
  }, [fleet, filter, districtFilter, query]);

  const counts = useMemo(() => {
    const all = fleet ?? [];
    return {
      total: all.length,
      available: all.filter((a) => a.status === 'available').length,
      out: all.filter((a) => a.status === 'out_of_service').length,
      uncrewed: all.filter((a) => !a.driver).length,
    };
  }, [fleet]);

  const create = useCallback(async () => {
    if (!token) return;
    setBusy('new');
    try {
      await api.post(
        '/ambulances',
        {
          call_sign: form.call_sign.trim(),
          registration: form.registration.trim(),
          operator_type: form.operator_type,
          operator_name: form.operator_name.trim(),
          base_district_id: Number(form.base_district_id),
          capabilities: form.capabilities,
          lat: form.lat.trim() ? Number(form.lat) : null,
          lng: form.lng.trim() ? Number(form.lng) : null,
        },
        { token },
      );
      onFlash({
        tone: 'live',
        title: `${form.call_sign.trim()} added to the fleet`,
        body: 'It is dispatchable as soon as a crew is linked to it.',
      });
      setForm({ ...EMPTY_FORM });
      setAdding(false);
      await load();
      onChange();
    } catch (err) {
      onFlash({
        tone: 'critical',
        title: 'Vehicle not created',
        body: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(null);
    }
  }, [token, form, load, onChange, onFlash]);

  const setStatus = useCallback(
    async (unit: Ambulance, status: string) => {
      if (!token) return;
      setBusy(unit.id);
      try {
        await api.post(`/ambulances/${unit.id}/status`, { status }, { token });
        onFlash({
          tone: status === 'available' ? 'live' : 'warm',
          title: `${unit.call_sign} is now ${status.replace(/_/g, ' ')}`,
          body:
            status === 'available'
              ? 'The matching engine can commit it again.'
              : 'It will not be offered for dispatch while it is out of service.',
        });
        await load();
      } catch (err) {
        onFlash({
          tone: 'critical',
          title: 'Status change refused',
          body: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [token, load, onFlash],
  );

  const assignDriver = useCallback(
    async (unit: Ambulance, driverUserId: number | null) => {
      if (!token) return;
      setBusy(unit.id);
      try {
        await api.post(`/ambulances/${unit.id}/crew`, { driver_user_id: driverUserId }, { token });
        onFlash({
          tone: 'live',
          title: driverUserId ? 'Crew linked' : 'Crew released',
          body: driverUserId
            ? `The crew's own screen now shows ${unit.call_sign}. Any vehicle they were on before has been released.`
            : `${unit.call_sign} has no driver and cannot be dispatched until one is linked.`,
        });
        await load();
      } catch (err) {
        onFlash({
          tone: 'critical',
          title: 'Crew change refused',
          body: err instanceof ApiError ? err.message : undefined,
        });
      } finally {
        setBusy(null);
      }
    },
    [token, load, onFlash],
  );

  if (fleet === null) return <Loading label="Loading the fleet" />;

  return (
    <Stack gap={space.lg}>
      <Card>
        <Row justify="space-between" align="center" wrap gap={space.md}>
          <Stack gap={2}>
            <Row gap="xs" align="center">
              <Icon name="ambulance" size={16} color={t.accent.base} />
              <Heading>Ambulance fleet</Heading>
            </Row>
            <Small muted>
              {counts.total} units · {counts.available} available · {counts.uncrewed} without a crew
              {counts.out ? ` · ${counts.out} out of service` : ''}
            </Small>
          </Stack>
          <Button
            label={adding ? 'Close' : 'Add a vehicle'}
            icon={adding ? 'x' : 'plus'}
            variant={adding ? 'ghost' : 'primary'}
            onPress={() => setAdding((v) => !v)}
          />
        </Row>

        {adding ? (
          <View style={{ marginTop: space.lg }}>
            <Divider />
            <Stack gap={space.md} style={{ marginTop: space.lg }}>
              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <TextField
                    label="Call sign"
                    value={form.call_sign}
                    onChangeText={(v) => setForm((f) => ({ ...f, call_sign: v }))}
                    placeholder="108-TN37-4412"
                    hint="What the control room says on the radio."
                  />
                </View>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <TextField
                    label="Registration"
                    value={form.registration}
                    onChangeText={(v) => setForm((f) => ({ ...f, registration: v }))}
                    placeholder="TN 37 AB 4412"
                  />
                </View>
              </Row>

              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <TextField
                    label="Operator"
                    value={form.operator_name}
                    onChangeText={(v) => setForm((f) => ({ ...f, operator_name: v }))}
                    placeholder="108 Emergency Response"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <Stack gap={6}>
                    <Label>Operator type</Label>
                    <Segmented
                      size="sm"
                      value={form.operator_type}
                      onChange={(v) => setForm((f) => ({ ...f, operator_type: v as '108' | 'private' }))}
                      options={[
                        { value: '108', label: '108' },
                        { value: 'private', label: 'Private' },
                      ]}
                    />
                  </Stack>
                </View>
              </Row>

              <Stack gap="sm">
                <Label>Base district</Label>
                <Segmented
                  size="sm"
                  scroll
                  value={form.base_district_id}
                  onChange={(v) => setForm((f) => ({ ...f, base_district_id: v }))}
                  options={districts.map((d) => ({ value: String(d.id), label: d.name }))}
                />
                <Small muted>
                  Determines which district&apos;s incidents this unit answers first. It is not a hard
                  boundary — cross-district mutual aid is escalated explicitly rather than assumed.
                </Small>
              </Stack>

              <Stack gap="sm">
                <Label>Capability</Label>
                <Row gap="xs" wrap>
                  {CAPABILITIES.map((c) => {
                    const on = form.capabilities.includes(c.value);
                    return (
                      <Button
                        key={c.value}
                        size="sm"
                        variant={on ? 'primary' : 'secondary'}
                        label={c.short}
                        onPress={() =>
                          setForm((f) => ({
                            ...f,
                            capabilities: on
                              ? f.capabilities.filter((x) => x !== c.value)
                              : [...f.capabilities, c.value],
                          }))
                        }
                      />
                    );
                  })}
                </Row>
                <Small muted>
                  Matched against the incident&apos;s clinical requirements. A P1 cardiac call is not
                  answered by a BLS van if an ALS unit is anywhere reachable.
                </Small>
              </Stack>

              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 160 }}>
                  <TextField
                    label="Base latitude"
                    value={form.lat}
                    onChangeText={(v) => setForm((f) => ({ ...f, lat: v }))}
                    placeholder="11.0168"
                    hint="Optional. Defaults to the district centre."
                  />
                </View>
                <View style={{ flex: 1, minWidth: 160 }}>
                  <TextField
                    label="Base longitude"
                    value={form.lng}
                    onChangeText={(v) => setForm((f) => ({ ...f, lng: v }))}
                    placeholder="76.9558"
                  />
                </View>
              </Row>

              <Row gap="sm" justify="flex-end">
                <Button label="Cancel" variant="ghost" onPress={() => setAdding(false)} />
                <Button
                  label="Add vehicle"
                  onPress={create}
                  loading={busy === 'new'}
                  disabled={!form.call_sign.trim() || !form.registration.trim() || !form.base_district_id}
                />
              </Row>
            </Stack>
          </View>
        ) : null}
      </Card>

      {error ? <Banner tone="critical" icon="alert" title="Fleet unavailable" body={error} /> : null}

      {directory && (directory.orphan_drivers > 0 || directory.crewless_units.length > 0) ? (
        <Banner
          tone="warm"
          icon="alert"
          title="Fleet gaps that will fail at dispatch"
          body={
            `${directory.orphan_drivers} crew account(s) have no vehicle and ` +
            `${directory.crewless_units.length} vehicle(s) have no crew linked. A driver with no ` +
            'vehicle has no assignment screen at all. An uncrewed vehicle can still be committed — ' +
            'it ranks below a crewed one in the same district and the dispatcher is warned — but ' +
            'the crew app is how a trip is actually worked, so a vehicle nobody is linked to is a ' +
            'gap worth closing.'
          }
        />
      ) : null}

      <Card>
        <Stack gap={space.md}>
          <Row gap="sm" wrap align="center" justify="space-between">
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `All ${counts.total}` },
                { value: 'uncrewed', label: `No crew ${counts.uncrewed}` },
                { value: 'out_of_service', label: `Out of service ${counts.out}` },
              ]}
            />
            <View style={{ minWidth: 220, flexShrink: 1 }}>
              <TextField
                value={query}
                onChangeText={setQuery}
                placeholder="Call sign, registration or driver"
                icon="search"
              />
            </View>
          </Row>

          <Stack gap="sm">
            <Label>Base district</Label>
            <Segmented
              size="sm"
              scroll
              value={districtFilter}
              onChange={setDistrictFilter}
              options={[
                { value: 'all', label: 'All districts' },
                ...districts.map((d) => ({ value: String(d.id), label: d.name })),
              ]}
            />
          </Stack>

          {units.length === 0 ? (
            <EmptyState
              icon="ambulance"
              title="No units match"
              body="Nothing in the fleet matches this combination of filters."
            />
          ) : (
            <Stack gap="xs">
              {units.map((unit) => (
                <UnitRow
                  key={unit.id}
                  unit={unit}
                  districtName={districtName(unit.base_district_id)}
                  drivers={directory?.results ?? []}
                  busy={busy === unit.id}
                  onStatus={setStatus}
                  onAssign={assignDriver}
                  onRelease={(u) => setReleasing(u)}
                  onEdit={() => setEditing(unit)}
                />
              ))}
            </Stack>
          )}
        </Stack>
      </Card>

      {editing ? (
        <EditVehicle
          unit={editing}
          districts={districts}
          onClose={() => setEditing(null)}
          onDone={async () => {
            setEditing(null);
            await load();
          }}
          onFlash={onFlash}
        />
      ) : null}

      <ConfirmDialog
        visible={releasing !== null}
        tone="danger"
        title={releasing ? `Release ${releasing.driver?.full_name ?? 'crew'} from ${releasing.call_sign}?` : 'Release crew'}
        body="The vehicle becomes undispatchable until another crew account is linked to it. If it is on a live trip the crew keeps the assignment they are working, but the next call cannot go to this unit."
        confirmLabel="Release crew"
        busy={releasing ? busy === releasing.id : false}
        onConfirm={() => {
          const unit = releasing;
          setReleasing(null);
          if (unit) void assignDriver(unit, null);
        }}
        onCancel={() => setReleasing(null)}
      />
    </Stack>
  );
}

/* --------------------------------------------------------------- one unit */

function UnitRow({
  unit,
  districtName,
  drivers,
  busy,
  onStatus,
  onAssign,
  onRelease,
  onEdit,
}: {
  unit: Ambulance;
  districtName: string;
  drivers: FleetDirectory['results'];
  busy: boolean;
  onStatus: (u: Ambulance, s: string) => void;
  onAssign: (u: Ambulance, id: number | null) => void;
  onRelease: (u: Ambulance) => void;
  onEdit: () => void;
}) {
  const { t } = useTheme();
  const [picking, setPicking] = useState(false);
  const outOfService = unit.status === 'out_of_service';
  const [showAll, setShowAll] = useState(false);

  // Stale GPS. A vehicle that has not reported for more than ten minutes is a
  // vehicle whose position on the map may be a lie, and dispatching to it is how
  // an ETA gets promised off a coordinate nobody has confirmed since morning.
  const gpsStale = useMemo(() => {
    if (!unit.updated_at) return false;
    const ms = Date.now() - new Date(unit.updated_at).getTime();
    return !Number.isNaN(ms) && ms > 10 * 60 * 1000;
  }, [unit.updated_at]);

  /**
   * Driver choices, drivers with no vehicle first.
   *
   * A driver already on another unit is still offered -- moving a paramedic to
   * a new vehicle is a normal fleet operation and the server releases the old
   * one in the same transaction -- but they are listed after the free ones,
   * because an operator re-crewing a vehicle almost always means the free ones.
   * Hidden behind "Show all" rather than shown, because listing all 66 crew in a
   * district by default makes the picker useless for the common case.
   */
  const free = drivers.filter((d) => !d.linked_ambulance);
  const taken = drivers.filter((d) => d.linked_ambulance);
  const options = showAll ? [...free, ...taken] : free;

  return (
    <View
      style={{
        borderWidth: 1,
        borderColor: t.line.subtle,
        borderRadius: 6,
        padding: space.md,
        backgroundColor: t.bg.raised,
        gap: space.sm,
      }}
    >
      <Row justify="space-between" align="center" wrap gap="sm">
        <Row gap="sm" align="center" wrap>
          <Num size={13.5}>{unit.call_sign}</Num>
          <Pill label={unit.capability_label} tone="neutral" compact />
          <Pill
            label={unit.status.replace(/_/g, ' ')}
            tone={STATUS_TONE[unit.status] ?? 'neutral'}
            compact
          />
          {!unit.driver ? <Pill label="no crew" tone="warm" compact /> : null}
        </Row>
        <Row gap="xs" align="center" wrap>
          <Button size="sm" variant="ghost" label={picking ? 'Cancel' : unit.driver ? 'Change driver' : 'Link driver'} onPress={() => setPicking((v) => !v)} />
          <Button
            size="sm"
            variant={outOfService ? 'secondary' : 'ghost'}
            label={outOfService ? 'Return to service' : 'Out of service'}
            loading={busy}
            onPress={() => onStatus(unit, outOfService ? 'available' : 'out_of_service')}
          />
          <Button size="sm" variant="ghost" label="Edit" onPress={onEdit} />
        </Row>
      </Row>

      <Row gap={space.lg} wrap>
        <KV label="Registration" value={unit.registration} mono />
        <KV label="Base" value={districtName} />
        <KV label="Operator" value={`${unit.operator_name} (${unit.operator_type})`} />
        <KV label="Driver" value={unit.driver?.full_name ?? 'Not linked'} />
        {/* #40: this printed the raw ISO timestamp, so a vehicle whose position
            had not moved since the previous afternoon read the same as one
            reporting every twenty seconds — you had to do the arithmetic against
            the current time to tell. The age is what a fleet office acts on. */}
        {unit.updated_at ? (
          <KV
            label="Last position"
            value={relativeFromIso(unit.updated_at)}
            tone={gpsStale ? 'warn' : undefined}
          />
        ) : null}
      </Row>

      {picking ? (
        <Stack gap="xs">
          <Divider />
          {unit.driver ? (
            <Row justify="space-between" align="center">
              <Small>
                {unit.driver.full_name} is currently linked. Releasing them leaves the vehicle
                undispatchable until somebody else is linked.
              </Small>
              <Button size="sm" variant="danger" label="Release crew" onPress={() => onRelease(unit)} />
            </Row>
          ) : null}

          {options.length === 0 ? (
            <Small muted>
              {showAll
                ? 'No crew accounts are available to link.'
                : 'Every crew account is already linked to a vehicle. Use “Show crew already assigned” to move one.'}
            </Small>
          ) : (
            <Row gap="xs" wrap>
              {options.map((d) => (
                <Button
                  key={d.id}
                  size="sm"
                  variant="secondary"
                  label={
                    d.linked_ambulance ? `${d.full_name} · ${d.linked_ambulance.call_sign}` : d.full_name
                  }
                  onPress={() => onAssign(unit, d.id)}
                />
              ))}
            </Row>
          )}

          {!showAll && taken.length > 0 ? (
            <Button size="sm" variant="ghost" label={`Show ${taken.length} crew already assigned`} onPress={() => setShowAll(true)} />
          ) : null}
        </Stack>
      ) : null}
    </View>
  );
}

/* ------------------------------------------------------------ edit dialog */

function EditVehicle({
  unit,
  districts,
  onClose,
  onDone,
  onFlash,
}: {
  unit: Ambulance;
  districts: District[];
  onClose: () => void;
  onDone: () => Promise<void>;
  onFlash: Flash;
}) {
  const { token } = useAuth();
  const { t } = useTheme();
  const [form, setForm] = useState({
    call_sign: unit.call_sign,
    registration: unit.registration,
    operator_name: unit.operator_name,
    base_district_id: String(unit.base_district_id ?? ''),
    capabilities: unit.capabilities ?? [unit.capability],
  });
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!token) return;
    setBusy(true);
    try {
      await api.patch(
        `/ambulances/${unit.id}`,
        {
          call_sign: form.call_sign.trim(),
          registration: form.registration.trim(),
          operator_name: form.operator_name.trim(),
          base_district_id: Number(form.base_district_id),
          capabilities: form.capabilities,
        },
        { token },
      );
      onFlash({ tone: 'live', title: `${form.call_sign.trim()} updated` });
      await onDone();
    } catch (err) {
      onFlash({
        tone: 'critical',
        title: 'Change refused',
        body: err instanceof ApiError ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <View
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0,0,0,0.45)',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.lg,
        zIndex: 40,
      }}
    >
      <View style={{ width: '100%', maxWidth: 560 }}>
        <Card>
          <Stack gap={space.md}>
            <Row justify="space-between" align="center">
              <Stack gap={2}>
                <Heading>Edit {unit.call_sign}</Heading>
                <Small muted>
                  Changing the base district changes which incidents this unit is offered for first.
                </Small>
              </Stack>
              <Button size="sm" variant="ghost" icon="x" label="" onPress={onClose} />
            </Row>

            <Row gap={space.md} wrap>
              <View style={{ flex: 1, minWidth: 160 }}>
                <TextField
                  label="Call sign"
                  value={form.call_sign}
                  onChangeText={(v) => setForm((f) => ({ ...f, call_sign: v }))}
                />
              </View>
              <View style={{ flex: 1, minWidth: 160 }}>
                <TextField
                  label="Registration"
                  value={form.registration}
                  onChangeText={(v) => setForm((f) => ({ ...f, registration: v }))}
                />
              </View>
            </Row>

            <TextField
              label="Operator"
              value={form.operator_name}
              onChangeText={(v) => setForm((f) => ({ ...f, operator_name: v }))}
            />

            <Stack gap="sm">
              <Label>Base district</Label>
              <Segmented
                size="sm"
                scroll
                value={form.base_district_id}
                onChange={(v) => setForm((f) => ({ ...f, base_district_id: v }))}
                options={districts.map((d) => ({ value: String(d.id), label: d.name }))}
              />
            </Stack>

            <Stack gap="sm">
              <Label>Capability</Label>
              <Row gap="xs" wrap>
                {CAPABILITIES.map((c) => {
                  const on = form.capabilities.includes(c.value);
                  return (
                    <Button
                      key={c.value}
                      size="sm"
                      variant={on ? 'primary' : 'secondary'}
                      label={c.short}
                      onPress={() =>
                        setForm((f) => ({
                          ...f,
                          capabilities: on
                            ? f.capabilities.filter((x) => x !== c.value)
                            : [...f.capabilities, c.value],
                        }))
                      }
                    />
                  );
                })}
              </Row>
            </Stack>

            <Row gap="sm" justify="flex-end">
              <Button label="Cancel" variant="ghost" onPress={onClose} />
              <Button label="Save changes" onPress={save} loading={busy} disabled={!form.capabilities.length} />
            </Row>
          </Stack>
        </Card>
      </View>
    </View>
  );
}

/** Re-exported so the accounts screen can label the vehicle picker identically. */
export { CAPABILITIES };
