import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Facility } from '../api/types';
import { congestionStatus, freshnessStatus, useTheme } from '../theme/ThemeProvider';
import { space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Body, KeyValue, Label, Meter, Num, Pill, Row, Small, Stack, TrustChip } from '../ui';
import { ageFromSeconds, CAPABILITY_LABELS } from '../lib/format';
import { useResponsive } from '../ui/useResponsive';

type Tone = keyof ReturnType<typeof useTheme>['t']['status'];

/**
 * One row in the directory.
 *
 * Deliberate choices: the three counters are laid out as a fixed-width numeric
 * block so they line up vertically down a long list; the meter underneath each
 * is the *effective* figure (holds subtracted), because a dispatcher reading
 * "3 free" and finding 2 is a worse failure than reading "2".
 */
export function FacilityRow({
  facility,
  onPress,
  showMeters = true,
  etaMinutes,
  compact,
}: {
  facility: Facility;
  onPress?: () => void;
  showMeters?: boolean;
  etaMinutes?: number;
  compact?: boolean;
}) {
  const { t } = useTheme();
  // On a phone the three counters drop below the name instead of fighting it
  // for horizontal space. Squeezing a 176px counter block next to a facility
  // name at 390px produces truncated names and unreadable meters.
  const { isPhone } = useResponsive();
  const cap = facility.capacity;
  const fresh = freshnessStatus(cap?.trust_state);
  const capages = facility.capabilities;

  if (!cap) {
    return (
      <Pressable onPress={onPress} style={{ paddingVertical: space.md, opacity: 0.65 }}>
        <Row justify="space-between" align="center">
          <Stack gap="xxs">
            <Body style={{ fontWeight: '600' }}>{facility.short_name}</Body>
            <Small muted>{facility.name}</Small>
          </Stack>
          <Pill label="No live data" tone="critical" icon="alert" compact />
        </Row>
      </Pressable>
    );
  }

  const bedTone: Tone =
    cap.beds_effective === 0 ? 'critical' : cap.beds_effective < facility.declared.beds * 0.05 ? 'stale' : 'live';
  const icuTone: Tone = cap.icu_effective === 0 ? 'critical' : cap.icu_effective < 3 ? 'stale' : 'live';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => ({
        paddingVertical: compact ? space.md : space.lg,
        paddingHorizontal: compact ? 0 : space.lg,
        backgroundColor: pressed ? t.bg.sunken : 'transparent',
        borderRadius: 8,
        opacity: pressed ? 0.92 : 1,
      })}
    >
      <View
        style={
          isPhone
            ? { gap: space.md }
            : { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.md }
        }
      >
        <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
          <Row gap="sm" align="center">
            <Body style={{ fontWeight: '600', letterSpacing: -0.15 }} numberOfLines={1}>
              {facility.short_name}
            </Body>
            <Pill
              label={facility.type === 'public' ? 'Govt' : facility.type === 'private' ? 'Private' : 'Trust'}
              tone="neutral"
              compact
              outline
            />
            {facility.verification === 'verified' ? (
              <Icon name="shield" size={13} color={t.status.live.base} />
            ) : (
              <Pill label={facility.verification} tone="warm" compact />
            )}
          </Row>

          <Small muted numberOfLines={1}>
            {facility.name}
          </Small>

          <Row gap="sm" align="center" wrap>
            <Row gap="xxs" align="center">
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: t.status[fresh].base,
                }}
              />
              <Label tone={t.status[fresh].base} style={{ fontSize: 10 }}>
                {cap.trust_state === 'live' ? 'live' : ageFromSeconds(ageFrom(cap.recorded_at))}
              </Label>
            </Row>
            {facility.district_name ? <Label style={{ fontSize: 10 }}>{facility.district_name}</Label> : null}
            {etaMinutes != null ? (
              <Row gap="xxs" align="center">
                <Icon name="route" size={11} color={t.fg.faint} />
                <Label style={{ fontSize: 10 }}>{etaMinutes} min</Label>
              </Row>
            ) : null}
            {cap.holds_active > 0 ? (
              <Pill label={`${cap.holds_active} held`} tone="info" compact icon="lock" />
            ) : null}
            {/* Specialist cover, which the row never carried. Beds and ICU say
                how much room a facility has; they say nothing about whether
                anyone there can treat the patient, and for a snakebite at
                midnight that is the question. Named specialties rather than a
                count, so the row answers "do they have what this needs". */}
            {facility.doctors && !compact ? (
              facility.doctors.on_duty > 0 ? (
                <Pill
                  label={
                    facility.doctors.specialties.length
                      ? `On duty: ${facility.doctors.specialties.slice(0, 2).join(', ')}${
                          facility.doctors.specialties.length > 2 ? ` +${facility.doctors.specialties.length - 2}` : ''
                        }`
                      : `${facility.doctors.on_duty} on duty`
                  }
                  tone="live"
                  compact
                  icon="pulse"
                />
              ) : facility.doctors.withheld ? (
                <Pill label="roster withheld" tone="neutral" compact outline icon="lock" />
              ) : (
                <Pill label="no clinician on duty" tone="warm" compact icon="alert" />
              )
            ) : null}
          </Row>

          {(capages.trauma_centre || capages.blood_bank || capages.burn_unit || capages.cath_lab) && !compact ? (
            <Row gap="xs" wrap style={{ marginTop: 1 }}>
              {Object.entries(capages)
                .filter(([, v]) => v)
                .slice(0, 4)
                .map(([k]) => (
                  <Pill key={k} label={CAPABILITY_LABELS[k] ?? k} tone="neutral" compact outline />
                ))}
            </Row>
          ) : null}
        </Stack>

        <Stack gap="md" style={{ width: isPhone ? '100%' : 176 }}>
          <Row gap="md" justify="space-between">
            <Counter label="Beds" value={cap.beds_effective} total={facility.declared.beds} tone={bedTone} meter={showMeters} />
            <Counter label="ICU" value={cap.icu_effective} total={facility.declared.icu} tone={icuTone} meter={showMeters} />
            <Counter
              label="Vent"
              value={cap.vent_effective}
              total={facility.declared.ventilators}
              tone={cap.vent_effective === 0 ? 'stale' : 'info'}
              meter={showMeters}
            />
          </Row>

          <Row justify="space-between" align="center">
            <Pill
              label={`ED ${cap.ed_congestion}`}
              tone={congestionStatus(cap.ed_congestion)}
              compact
            />
            {cap.ed_waiting > 0 ? (
              <Label style={{ fontSize: 10 }}>{cap.ed_waiting} waiting</Label>
            ) : null}
            <TrustChip score={facility.trust?.score} />
          </Row>
        </Stack>
      </View>
    </Pressable>
  );
}

function Counter({
  label,
  value,
  total,
  tone,
  meter,
}: {
  label: string;
  value: number;
  total: number;
  tone: Tone;
  meter?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Stack gap="xxs" style={{ flex: 1 }}>
      <Label style={{ fontSize: 9.5 }}>{label}</Label>
      <Row gap="xxs" align="baseline">
        <Num size={15.5} color={t.status[tone].base}>
          {value}
        </Num>
        <Num size={10} color={t.fg.faint} weight="500">
          /{total}
        </Num>
      </Row>
      {meter ? <Meter value={value} total={total} tone={tone} height={3} /> : null}
    </Stack>
  );
}

function ageFrom(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 1000));
}
