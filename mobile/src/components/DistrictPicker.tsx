import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Body, Button, Label, Num, Row, Small, Stack, TextField } from '../ui';
import { Icon } from '../ui/Icon';

/**
 * District chooser.
 *
 * Tamil Nadu has 38 districts and this platform publishes facilities in every
 * one of them, so a horizontal chip row is the wrong control: it puts
 * Kanniyakumari thirty-nine taps away and gives no way to search. This is a
 * filterable list instead, ordered by the data rather than by the alphabet —
 * each row carries how many facilities it has, because "which district has
 * anything in it" is the question a person actually arrives with.
 */
export interface PickerDistrict {
  id: number;
  name: string;
  /** English name where the API also returns a Tamil one. */
  name_ta?: string | null;
  headquarters?: string | null;
  facilities: number;
}

export function DistrictPicker({
  districts,
  value,
  onPick,
  onClose,
}: {
  districts: PickerDistrict[];
  value: number | null;
  onPick: (id: number | null) => void;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = districts
      .filter((d) => {
        if (!q) return true;
        return (
          d.name.toLowerCase().includes(q) ||
          (d.name_ta ?? '').toLowerCase().includes(q) ||
          (d.headquarters ?? '').toLowerCase().includes(q)
        );
      })
      .sort((a, b) => b.facilities - a.facilities || a.name.localeCompare(b.name));
    return matched;
  }, [districts, query]);

  const empty = districts.filter((d) => d.facilities === 0).length;

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
          <Label>Choose a district</Label>
          <Small muted style={{ fontSize: 11.5 }}>
            {rows.length} of {districts.length} shown, most facilities first
            {empty > 0 ? ` · ${empty} with nothing published yet` : ''}
          </Small>
        </Stack>
        <Button label="Close" size="sm" variant="ghost" onPress={onClose} />
      </Row>

      <View style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="District or headquarters"
          icon="search"
          autoCapitalize="none"
        />
      </View>

      <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
        <Pressable
          onPress={() => onPick(null)}
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
          <Icon name="globe" size={15} color={value === null ? t.accent.base : t.fg.faint} />
          <Body style={{ flex: 1, fontSize: 13.5, fontWeight: '600' }}>All districts</Body>
          <Num size={12} color={t.fg.muted}>
            {districts.reduce((sum, d) => sum + d.facilities, 0)}
          </Num>
        </Pressable>

        {rows.map((d) => {
          const selected = d.id === value;
          return (
            <Pressable
              key={d.id}
              onPress={() => onPick(d.id)}
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
                  {d.name}
                  {d.name_ta ? <Small muted style={{ fontSize: 12 }}> · {d.name_ta}</Small> : null}
                </Body>
                {d.headquarters ? (
                  <Small muted style={{ fontSize: 11 }} numberOfLines={1}>
                    HQ {d.headquarters}
                  </Small>
                ) : null}
              </Stack>
              <Num size={12} color={d.facilities ? t.fg.muted : t.fg.faint}>
                {d.facilities}
              </Num>
            </Pressable>
          );
        })}

        {rows.length === 0 ? (
          <View style={{ padding: space.lg }}>
            <Small muted>No district matches “{query}”.</Small>
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
