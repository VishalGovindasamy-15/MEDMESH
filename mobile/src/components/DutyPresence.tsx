/**
 * Whether a clinician is here right now, stated rather than implied.
 *
 * The audit's finding was the same on four surfaces: the doctor cards carried
 * `on_duty` and rendered it as a six-pixel green dot, so "is there a
 * cardiologist at this hospital tonight" — the question a citizen opens the
 * directory to ask, and the question the matching engine answers when it ranks a
 * facility for a cardiac case — required reading a colour. Several cards showed
 * `night` or `on_call`, which is a shift *name*, not a statement about now.
 *
 * One component, used everywhere a doctor is listed: the public directory, the
 * facility page, the hospital dashboard roster and the doctor search. It says
 * ON DUTY NOW or OFF DUTY in words, and when a window is open it says how long
 * is left, because "ends in 12 minutes" and "ends in 9 hours" are different
 * answers to whether to send a patient across the district.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Body, Row, Small } from '../ui';

export interface DutyLike {
  on_duty?: boolean;
  /** `on_duty` | `expired` | `off_duty`, as the server computes it. */
  duty_state?: string;
  /** Signed: negative once the window has passed. */
  minutes_remaining?: number | null;
  shift_window?: string | null;
  /** The raw stored flag, exposed only where the distinction matters. */
  roster_flag?: boolean;
}

/** How long is left, in the form a person reads out loud. */
export function dutyCountdown(minutes: number | null | undefined): string | null {
  if (minutes === null || minutes === undefined) return null;
  if (minutes < 0) return null;
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  return rest ? `${hours}h ${rest}m left` : `${hours}h left`;
}

/**
 * The bare statement: a dot and a word.
 *
 * `compact` is the inline form for a dense list; the full form adds the
 * countdown and the shift window.
 */
export function DutyBadge({
  doctor,
  compact,
  /** Rendered beside the badge when on duty, e.g. "Emergency referrals". */
  emergency,
}: {
  doctor: DutyLike;
  compact?: boolean;
  emergency?: boolean;
}) {
  const { t } = useTheme();

  const expired = doctor.duty_state === 'expired';
  const on = doctor.on_duty === true && !expired;
  const colour = on ? t.status.live.base : t.fg.faint;
  const left = on ? dutyCountdown(doctor.minutes_remaining) : null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: compact ? 6 : 8,
        paddingVertical: compact ? 2 : 3,
        borderRadius: radius.sm,
        backgroundColor: on ? t.status.live.soft : t.bg.sunken,
      }}
    >
      {/* Filled when on duty, hollow when not: the shape carries the meaning for
          anyone who cannot separate green from grey. */}
      <View
        style={{
          width: 7,
          height: 7,
          borderRadius: 4,
          borderWidth: on ? 0 : StyleSheet.hairlineWidth,
          borderColor: t.fg.faint,
          backgroundColor: on ? colour : 'transparent',
        }}
      />
      <Body
        style={{
          fontSize: compact ? 10.5 : 11.5,
          fontWeight: '700',
          letterSpacing: 0.4,
          color: on ? colour : t.fg.muted,
        }}
      >
        {on ? 'ON DUTY NOW' : expired ? 'OFF DUTY — SHIFT ENDED' : 'OFF DUTY'}
      </Body>
      {left && !compact ? (
        <Small muted style={{ fontSize: 10.5 }}>
          · {left}
        </Small>
      ) : null}
      {emergency && on ? (
        <Small style={{ fontSize: 10.5, color: t.status.live.base }}>· emergency referrals</Small>
      ) : null}
    </View>
  );
}

/**
 * The full card line: name, speciality, presence, shift and next window.
 *
 * Returns a stack rather than a row so it drops into a list of any density, and
 * so the presence line is never the thing that gets truncated — the audit's
 * complaint about the green dot was precisely that the least legible element was
 * carrying the most important fact.
 */
export function DoctorPresence({
  name,
  speciality,
  designation,
  doctor,
  /** The next duty window when off duty, if the roster knows it. */
  nextWindow,
  right,
}: {
  name: string;
  speciality: string;
  designation?: string | null;
  doctor: DutyLike;
  nextWindow?: string | null;
  right?: React.ReactNode;
}) {
  const { t } = useTheme();
  const on = doctor.on_duty === true && doctor.duty_state !== 'expired';
  const left = on ? dutyCountdown(doctor.minutes_remaining) : null;

  return (
    <Row gap="md" align="flex-start" style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Body style={{ fontWeight: '600', fontSize: 13.5 }} numberOfLines={1}>
          {name}
        </Body>
        <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
          {speciality}
          {designation ? ` · ${designation}` : ''}
        </Small>

        <Row gap="xs" align="center" style={{ flexWrap: 'wrap' }}>
          <DutyBadge doctor={doctor} compact />
          {on ? (
            <Small muted style={{ fontSize: 10.5 }}>
              Shift {doctor.shift_window ?? '—'}
              {left ? ` · ends in ${left.replace(' left', '')}` : ''}
            </Small>
          ) : nextWindow ? (
            <Small muted style={{ fontSize: 10.5 }}>
              Next shift {nextWindow}
            </Small>
          ) : null}
          {on && doctor.duty_state === 'on_duty' && doctor.minutes_remaining !== null && doctor.minutes_remaining !== undefined && doctor.minutes_remaining < 30 ? (
            <Small style={{ fontSize: 10.5, color: t.status.warm.base }}>
              handover imminent
            </Small>
          ) : null}
        </Row>
      </View>
      {right}
    </Row>
  );
}
