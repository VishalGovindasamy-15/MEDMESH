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
}: {
  districts: PickerDistrict[];
  value: number | null;
  onChange: (id: number) => void;
  label?: string;
  hint?: string;
  placeholder?: string;
  disabled?: boolean;
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
            <Small muted style={{ fontSize: 11 }}>
              {chosen.facilities} facilit{chosen.facilities === 1 ? 'y' : 'ies'}
              {chosen.headquarters ? ` · HQ ${chosen.headquarters}` : ''}
            </Small>
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
          onPick={(id) => {
            // "All districts" is a filter concept, not a jurisdiction. A caller
            // that maps a field to a single value ignores the null and keeps
            // what it had, which is the safe reading of an accidental tap.
            if (id !== null) onChange(id);
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
}: {
  facilities: PickerFacility[];
  districts: PickerDistrict[];
  value: number | null;
  onPick: (id: number) => void;
  onClose: () => void;
  title?: string;
  scopeToDistrictId?: number | null;
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
          />
        </>
      ) : null}
    </Stack>
  );
}
