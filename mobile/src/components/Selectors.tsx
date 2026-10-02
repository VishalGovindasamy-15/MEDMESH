/**
 * Reusable choosers for the two lists that are too long to render inline.
 *
 * Tamil Nadu has 38 districts and the platform publishes ~150 facilities. Both
 * numbers grew during this project, and both are still rendered as chip rows or
 * segmented controls in several screens: a horizontal scroll that puts
 * Kanniyakumari thirty-nine swipes away, and — in one case — a `.slice(0, 14)`
 * that silently made facilities 15 onwards unselectable.
 *
 * These two components exist so that fixing that is a one-line change per
 * screen rather than eight bespoke pickers. Both are the same shape:
 *
 *   <DistrictField districts={districts} value={id} onChange={setId} />
 *
 * which renders a button showing the current choice and opens a searchable
 * panel behind it. Nothing here fetches: the caller already has the list, and a
 * picker that invents its own request would fetch the same payload twice on a
 * screen that is already polling.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Body, Button, Label, Num, Row, Small, Stack, TextField } from '../ui';
import { Icon } from '../ui/Icon';
import { DistrictPicker, type PickerDistrict } from './DistrictPicker';

export type { PickerDistrict };

/* ------------------------------------------------------------------ district */

export function DistrictField({
  districts,
  value,
  onChange,
  label = 'District',
  /** Prefixed to the button, e.g. "Incident district". */
  hint,
  /** Shown in the button when nothing is selected. */
  placeholder = 'Select district',
  disabled,
  hideAll = false,
  allowClear = false,
  showCount = true,
  countUnit,
}: {
  districts: PickerDistrict[];
  value: number | null;
  onChange: (id: number | null) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Jurisdiction fields pass this: a dispatcher is scoped to one district, a
   * vehicle is based in one, and "All districts" in those forms is an option
   * that means nothing. Filter fields leave it off and get the row, which for
   * them is the most-used choice on the list.
   */
  hideAll?: boolean;
  /**
   * Filters also pass this: picking "All districts" has to be able to clear
   * the field, so the null from the picker is forwarded instead of swallowed.
   * Forms leave it off, where an accidental All tap keeps what was selected.
   */
  allowClear?: boolean;
  /**
   * Callers whose districts carry no meaningful count (the fleet edit modal
   * has the district list but not the fleet) pass false and the subtitle line
   * is dropped rather than printing "0 units" as though it knew something.
   */
  showCount?: boolean;
  /** Noun for the per-district count when it is not counting facilities. */
  countUnit?: string;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const chosen = districts.find((d) => d.id === value) ?? null;

  return (
    <Stack gap="xs">
      <Row justify="space-between" align="center" gap="sm">
        <Label>{label}</Label>
        {hint ? (
          <Small muted style={{ fontSize: 10.5 }}>
            {hint}
          </Small>
        ) : null}
      </Row>

      <Pressable
        onPress={() => !disabled && setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open, disabled: !!disabled }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: 10,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: open ? t.accent.base : t.line.base,
          backgroundColor: t.bg.surface,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        })}
      >
        <Icon name="grid" size={15} color={chosen ? t.accent.base : t.fg.faint} />
        <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
          <Body style={{ fontSize: 13.5, fontWeight: '600', color: chosen ? t.fg.strong : t.fg.muted }} numberOfLines={1}>
            {chosen ? chosen.name : placeholder}
          </Body>
          {/* The count is the reason this is a list and not an alphabet: an
              operator picking a district usually wants one that has something
              in it. */}
          {chosen ? (
            showCount || chosen.headquarters ? (
              <Small muted style={{ fontSize: 11 }}>
                {showCount
                  ? countUnit
                    ? `${chosen.facilities} ${countUnit}`
                    : `${chosen.facilities} facilit${chosen.facilities === 1 ? 'y' : 'ies'}`
                  : ''}
                {chosen.headquarters ? `${showCount ? ' · ' : ''}HQ ${chosen.headquarters}` : ''}
              </Small>
            ) : null
          ) : (
            <Small muted style={{ fontSize: 11 }}>
              {districts.length} districts
            </Small>
          )}
        </Stack>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={15} color={t.fg.faint} />
      </Pressable>

      {open ? (
        <DistrictPicker
          districts={districts}
          value={value}
          hideAll={hideAll}
          onPick={(id) => {
            // "All districts" is a filter concept, not a jurisdiction. A form
            // field ignores the null and keeps what it had — the safe reading
            // of an accidental tap. A filter field (allowClear) forwards it,
            // because clearing the filter is the whole point of that row.
            if (id !== null || allowClear) onChange(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------ facility */

export interface PickerFacility {
  id: number;
  name: string;
  short_name: string;
  district_id: number;
  district_name?: string | null;
  type_label?: string;
  verification?: string;
  integration?: string;
  /** Grouping label used when a district filter is on. */
  beds_available?: number | null;
}

export function FacilityPicker({
  facilities,
  districts,
  value,
  onPick,
  onClose,
  title = 'Choose a facility',
  /** Rendered above the list — a district filter for long lists. */
  scopeToDistrictId,
  districtField = false,
  clearLabel,
  onClear,
}: {
  facilities: PickerFacility[];
  districts: PickerDistrict[];
  value: number | null;
  onPick: (id: number) => void;
  onClose: () => void;
  title?: string;
  scopeToDistrictId?: number | null;
  /**
   * Render the searchable DistrictField above the chip row.
   *
   * The chips below are the eight districts with the most facilities — a
   * shortcut, and a fair one, but a shortcut is not a control: with chips
   * alone, thirty of the thirty-eight districts were reachable only by typing
   * their name into the facility search, which nobody discovers by looking.
   * Callers that pass this get the full picker; the chips stay as the
   * one-tap path for the common case.
   */
  districtField?: boolean;
  /** Label for an optional "none of these" first row, e.g. "No vehicle". */
  clearLabel?: string;
  /** Handler for that row. When absent, the row is not rendered. */
  onClear?: () => void;
}) {
  const { t } = useTheme();
  const [query, setQuery] = useState('');
  const [districtOnly, setDistrictOnly] = useState<number | null>(scopeToDistrictId ?? null);

  const districtName = useMemo(() => {
    const map = new Map(districts.map((d) => [d.id, d.name]));
    return (id: number) => map.get(id) ?? '';
  }, [districts]);

  /**
   * Districts worth a chip: the ones that actually hold facilities in this list,
   * most populous first.
   *
   * The list runs to a hundred and fifty rows on this dataset, and a reader
   * hunting for one of them is almost always hunting inside one district. A chip
   * row costs one line and turns a ninety-row scroll into six. The rest are
   * still reachable by typing the district name, which the search already
   * matches on.
   */
  const districtChips = useMemo(() => {
    const counts = new Map<number, number>();
    const base = scopeToDistrictId ? facilities.filter((f) => f.district_id === scopeToDistrictId) : facilities;
    base.forEach((f) => counts.set(f.district_id, (counts.get(f.district_id) ?? 0) + 1));
    return [...counts.entries()]
      .map(([id, n]) => ({ id, name: districtName(id) || `District ${id}`, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 8);
  }, [facilities, scopeToDistrictId, districtName]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scoped = scopeToDistrictId ? facilities.filter((f) => f.district_id === scopeToDistrictId) : facilities;
    return scoped
      .filter((f) => {
        if (districtOnly && f.district_id !== districtOnly) return false;
        if (!q) return true;
        return (
          f.name.toLowerCase().includes(q) ||
          (f.short_name ?? '').toLowerCase().includes(q) ||
          districtName(f.district_id).toLowerCase().includes(q)
        );
      })
      .sort(
        (a, b) =>
          districtName(a.district_id).localeCompare(districtName(b.district_id)) ||
          a.name.localeCompare(b.name),
      );
  }, [facilities, query, scopeToDistrictId, districtName, districtOnly]);

  // A cap, stated. Sliding a list this long silently is exactly the failure the
  // audit found in the admin selector, so when it bites it says so.
  const LIMIT = 80;
  const shown = rows.slice(0, LIMIT);

  return (
    <View
      style={{
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.line.base,
        borderRadius: radius.lg,
        backgroundColor: t.bg.surface,
        overflow: 'hidden',
      }}
    >
      <Row
        justify="space-between"
        align="center"
        style={{ paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.sm }}
      >
        <Stack gap="xxs">
          <Label>{title}</Label>
          <Small muted style={{ fontSize: 11.5 }}>
            {rows.length} match{rows.length === 1 ? '' : 'es'}
            {rows.length > LIMIT ? ` · showing the first ${LIMIT}, keep typing to narrow` : ''}
          </Small>
        </Stack>
        <Button label="Close" size="sm" variant="ghost" onPress={onClose} />
      </Row>

      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Search facility by name or district"
          icon="search"
          autoCapitalize="none"
        />
      </View>

      {districtField && districts.length > 8 ? (
        <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
          <DistrictField
            districts={districts}
            value={districtOnly}
            onChange={(id) => setDistrictOnly((prev) => (prev === id ? null : id))}
            label="District"
            hint="optional filter — pick again to clear"
            placeholder="All districts"
          />
        </View>
      ) : null}

      {districtChips.length > 1 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ maxHeight: 46 }}
          contentContainerStyle={{ paddingHorizontal: space.lg, paddingBottom: space.sm, gap: 6 }}
        >
          <Pressable
            onPress={() => setDistrictOnly(null)}
            accessibilityRole="button"
            accessibilityState={{ selected: districtOnly === null }}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 999,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: districtOnly === null ? t.accent.base : t.line.base,
              backgroundColor: districtOnly === null ? t.accent.soft : 'transparent',
            }}
          >
            <Small style={{ fontSize: 11.5 }}>All districts</Small>
          </Pressable>
          {districtChips.map((d) => {
            const active = d.id === districtOnly;
            return (
              <Pressable
                key={d.id}
                onPress={() => setDistrictOnly(active ? null : d.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  paddingHorizontal: 10,
                  paddingVertical: 5,
                  borderRadius: 999,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: active ? t.accent.base : t.line.base,
                  backgroundColor: active ? t.accent.soft : 'transparent',
                }}
              >
                <Small style={{ fontSize: 11.5 }}>
                  {d.name} {d.n}
                </Small>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}

      <ScrollView style={{ maxHeight: 340 }} keyboardShouldPersistTaps="handled">
        {clearLabel && onClear ? (
          <Pressable
            onPress={onClear}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              paddingHorizontal: space.lg,
              paddingVertical: space.sm,
              borderTopWidth: StyleSheet.hairlineWidth,
              borderTopColor: t.line.subtle,
              backgroundColor: value === null ? t.accent.soft : 'transparent',
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Icon name="x" size={15} color={value === null ? t.accent.base : t.fg.faint} />
            <Body style={{ flex: 1, fontSize: 13.5, fontWeight: '600' }}>{clearLabel}</Body>
          </Pressable>
        ) : null}
        {shown.map((f) => {
          const selected = f.id === value;
          return (
            <Pressable
              key={f.id}
              onPress={() => onPick(f.id)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: space.md,
                paddingHorizontal: space.lg,
                paddingVertical: space.sm,
                borderTopWidth: StyleSheet.hairlineWidth,
                borderTopColor: t.line.subtle,
                backgroundColor: selected ? t.accent.soft : 'transparent',
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <View style={{ width: 15 }}>
                {selected ? <Icon name="check" size={15} color={t.accent.base} /> : null}
              </View>
              <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                <Body style={{ fontSize: 13.5, fontWeight: selected ? '600' : '500' }} numberOfLines={1}>
                  {f.name}
                </Body>
                <Small muted style={{ fontSize: 11 }} numberOfLines={1}>
                  {[f.short_name, districtName(f.district_id), f.type_label].filter(Boolean).join(' · ')}
                </Small>
              </Stack>
              {typeof f.beds_available === 'number' ? (
                <Num size={12} color={f.beds_available > 0 ? t.status.live.base : t.fg.faint}>
                  {f.beds_available}
                </Num>
              ) : null}
            </Pressable>
          );
        })}

        {shown.length === 0 ? (
          <View style={{ padding: space.lg }}>
            <Small muted>No facility matches “{query}”.</Small>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/**
 * The facility chooser as a field: a button that opens {@link FacilityPicker}.
 *
 * Exists as a pair with {@link DistrictField} because the two are almost always
 * used together — a facility belongs to a district, and an operator picking a
 * facility usually wants the district as a filter rather than as a second list
 * to scroll.
 */
export function FacilityField({
  facilities,
  districts,
  value,
  onChange,
  label = 'Hospital',
  placeholder = 'Select facility',
  title,
  disabled,
}: {
  facilities: PickerFacility[];
  districts: PickerDistrict[];
  value: number | null;
  onChange: (id: number) => void;
  label?: string;
  placeholder?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);
  const [districtFilter, setDistrictFilter] = useState<number | null>(null);

  const chosen = facilities.find((f) => f.id === value) ?? null;
  const districtLabel = districts.find((d) => d.id === chosen?.district_id)?.name ?? '';

  return (
    <Stack gap="xs">
      <Label>{label}</Label>

      <Pressable
        onPress={() => !disabled && setOpen((v) => !v)}
        accessibilityRole="button"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: 10,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: open ? t.accent.base : t.line.base,
          backgroundColor: t.bg.surface,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        })}
      >
        <Icon name="hospital" size={15} color={chosen ? t.accent.base : t.fg.faint} />
        <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
          <Body style={{ fontSize: 13.5, fontWeight: '600', color: chosen ? t.fg.strong : t.fg.muted }} numberOfLines={1}>
            {chosen ? chosen.name : placeholder}
          </Body>
          <Small muted style={{ fontSize: 11 }} numberOfLines={1}>
            {chosen ? [chosen.short_name, districtLabel].filter(Boolean).join(' · ') : `${facilities.length} facilities`}
          </Small>
        </Stack>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={15} color={t.fg.faint} />
      </Pressable>

      {open ? (
        <>
          <DistrictField
            districts={districts}
            value={districtFilter}
            onChange={(id) => setDistrictFilter((prev) => (prev === id ? null : id))}
            label="Filter by district"
            hint="optional — tap again to clear"
            placeholder="All districts"
          />
          <FacilityPicker
            facilities={facilities}
            districts={districts}
            value={value}
            onPick={(id) => {
              onChange(id);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
            title={title ?? label}
            scopeToDistrictId={districtFilter}
            districtField
          />
        </>
      ) : null}
    </Stack>
  );
}

/* ------------------------------------------------------------------ vehicle */

export interface PickerVehicle {
  id: number;
  call_sign: string;
  registration: string;
  capability_label?: string | null;
  status_label?: string | null;
  base_district_id?: number | null;
  driver?: { full_name: string } | null;
}

/**
 * Vehicle chooser, same shape as the other two fields.
 *
 * The fleet runs to sixty-six units statewide. The account forms used to render
 * them as a horizontally scrolling segmented control, which has the same defect
 * the district rows had — the vehicle you want is a swipe-scroll away and there
 * is no search — and one more: a scroll row of sixty-six pills on a phone is
 * where mis-taps live. Reuses {@link FacilityPicker}'s list machinery (search,
 * district filter, stated cap) because a vehicle row and a facility row are the
 * same thing to a chooser: a name, a subtitle, a district.
 */
export function VehicleField({
  vehicles,
  districts,
  value,
  onChange,
  label = 'Vehicle',
  placeholder = 'Select vehicle',
  clearLabel,
  title,
}: {
  vehicles: PickerVehicle[];
  districts: PickerDistrict[];
  /** Null means "no vehicle linked". */
  value: number | null;
  /** Called with null for the clear row, otherwise the picked vehicle id. */
  onChange: (id: number | null) => void;
  label?: string;
  placeholder?: string;
  /** When set, the list gets a first row that unlinks, e.g. "No vehicle". */
  clearLabel?: string;
  title?: string;
}) {
  const { t } = useTheme();
  const [open, setOpen] = useState(false);

  const rows = useMemo<PickerFacility[]>(
    () =>
      vehicles.map((v) => ({
        id: v.id,
        name: v.call_sign,
        short_name: v.registration,
        district_id: v.base_district_id ?? 0,
        district_name: districts.find((d) => d.id === v.base_district_id)?.name ?? null,
        type_label: [v.capability_label, v.driver?.full_name ? `crew ${v.driver.full_name}` : null]
          .filter(Boolean)
          .join(' · '),
      })),
    [vehicles, districts],
  );

  const chosen = vehicles.find((v) => v.id === value) ?? null;
  const chosenDistrict = districts.find((d) => d.id === chosen?.base_district_id)?.name ?? '';

  return (
    <Stack gap="xs">
      <Label>{label}</Label>

      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: 10,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: open ? t.accent.base : t.line.base,
          backgroundColor: t.bg.surface,
          opacity: pressed ? 0.8 : 1,
        })}
      >
        <Icon name="ambulance" size={15} color={chosen ? t.accent.base : t.fg.faint} />
        <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
          <Body style={{ fontSize: 13.5, fontWeight: '600', color: chosen ? t.fg.strong : t.fg.muted }} numberOfLines={1}>
            {chosen ? chosen.call_sign : placeholder}
          </Body>
          <Small muted style={{ fontSize: 11 }} numberOfLines={1}>
            {chosen
              ? [chosen.registration, chosen.capability_label, chosenDistrict].filter(Boolean).join(' · ')
              : `${vehicles.length} vehicles`}
          </Small>
        </Stack>
        <Icon name={open ? 'chevronUp' : 'chevronDown'} size={15} color={t.fg.faint} />
      </Pressable>

      {open ? (
        <FacilityPicker
          facilities={rows}
          districts={districts}
          value={value}
          onPick={(id) => {
            onChange(id);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
          title={title ?? label}
          districtField
          clearLabel={clearLabel}
          onClear={
            clearLabel
              ? () => {
                  onChange(null);
                  setOpen(false);
                }
              : undefined
          }
        />
      ) : null}
    </Stack>
  );
}
