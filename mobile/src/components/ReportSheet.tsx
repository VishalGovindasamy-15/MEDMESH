import React, { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../api/client';
import { useAuth } from '../state/AuthProvider';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import {
  Banner,
  Body,
  Button,
  Heading,
  Label,
  Pill,
  Row,
  Small,
  Stack,
  TextField,
} from '../ui';
import { Icon } from '../ui/Icon';
import { useResponsive } from '../ui/useResponsive';

/**
 * "This hospital said no beds on arrival."
 *
 * Feedback is the only mechanism that catches a facility whose self-reported
 * numbers have drifted from reality, so the sheet is deliberately low-friction
 * and honest about consequence: it tells the reporter what happens next, and it
 * does not promise a reply it cannot deliver.
 */

const KINDS = [
  { key: 'beds_unavailable', label: 'Said no beds available', icon: 'bed' },
  { key: 'closed', label: 'Closed / not accepting', icon: 'x' },
  { key: 'wrong_hours', label: 'No one answered', icon: 'phone' },
  { key: 'wrong_contact', label: 'Wrong number', icon: 'phone' },
  { key: 'other', label: 'Something else', icon: 'dots' },
] as const;

export function ReportSheet({
  visible,
  hospitalId,
  hospitalName,
  incidentId,
  onClose,
}: {
  visible: boolean;
  hospitalId: number;
  hospitalName: string;
  incidentId?: number;
  onClose: () => void;
}) {
  const { t } = useTheme();
  const { user, token } = useAuth();
  const { isPhone } = useResponsive();

  const [kind, setKind] = useState<string>('beds_unavailable');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'sent' | string | null>(null);

  /** Same shapes the server refuses, mirrored so the warning arrives while the
   *  note is being typed rather than after a round trip. */
  const piiWarning = useMemo(() => {
    const v = comment.trim();
    if (!v) return null;
    if (/(?:\+?91[\s-]?)?[6-9]\d{9}\b/.test(v)) return 'A phone number';
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(v)) return 'An email address';
    if (/\b\d{6,}\b/.test(v) || /\b(?:\d{4,5}[\s-]){2,}\d{4,5}\b/.test(v)) return 'A record or card number';
    if (/\b(?:age|aged|yr[s]?\.? old)\b[\s:]*\d{1,3}/i.test(v)) return 'Somebody\u2019s age';
    if (/\b(?:patient|name(?:d)?|pt)\b[\s:]+[A-Z][a-z]+/.test(v)) return 'A named patient';
    return null;
  }, [comment]);

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      await api.post(
        '/governance/feedback',
        {
          hospital_id: hospitalId,
          kind,
          comment: user ? comment : '',
          incident_id: incidentId ?? null,
        },
        { token },
      );
      setResult('sent');
    } catch (err) {
      setResult(err instanceof ApiError ? err.message : 'Could not send the report');
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setResult(null);
    setComment('');
    setKind('beds_unavailable');
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
      <Pressable
        onPress={close}
        style={{ flex: 1, backgroundColor: 'rgba(8,11,16,0.45)', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      >
        <Pressable
          onPress={(e) => e.stopPropagation()}
          style={{
            width: '100%',
            maxWidth: 460,
            backgroundColor: t.bg.surface,
            borderRadius: radius.xl,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.line.base,
            padding: space.lg,
            gap: space.md,
          }}
        >
          <Row justify="space-between" align="center">
            <Stack gap="xxs" style={{ flex: 1 }}>
              <Heading>Report a problem</Heading>
              <Small muted>{hospitalName}</Small>
            </Stack>
            <Pressable onPress={close} hitSlop={8} accessibilityLabel="Close">
              <Icon name="x" size={18} color={t.fg.muted} />
            </Pressable>
          </Row>

          {result === 'sent' ? (
            <>
              <Banner
                tone="live"
                icon="check"
                title="Report received"
                body="The district health office reviews reported mismatches. Repeated confirmed reports lower this facility's trust score until resolved — that is what keeps the directory honest."
              />
              <Button label="Close" variant="primary" onPress={close} full />
            </>
          ) : (
            <>
              <Stack gap="xs">
                <Label>What happened</Label>
                <Stack gap="xs">
                  {KINDS.map((k) => {
                    const active = k.key === kind;
                    return (
                      <Pressable
                        key={k.key}
                        onPress={() => setKind(k.key)}
                        accessibilityRole="radio"
                        accessibilityState={{ selected: active }}
                        style={({ pressed }) => ({
                          flexDirection: 'row',
                          alignItems: 'center',
                          gap: 10,
                          paddingVertical: 10,
                          paddingHorizontal: 12,
                          borderRadius: radius.md,
                          borderWidth: StyleSheet.hairlineWidth,
                          borderColor: active ? t.accent.base : t.line.base,
                          backgroundColor: active ? t.accent.wash : t.bg.surface,
                          opacity: pressed ? 0.8 : 1,
                        })}
                      >
                        <Icon name={k.icon} size={15} color={active ? t.accent.base : t.fg.muted} />
                        <Body style={{ fontSize: 13.5 }}>{k.label}</Body>
                        {active ? <Icon name="check" size={15} color={t.accent.base} /> : null}
                      </Pressable>
                    );
                  })}
                </Stack>
              </Stack>

              {/* #47: this used to be a 400-character free-text box open to
                  anybody, signed in or not — the one hole in an otherwise
                  structural rule that MedMesh holds no personal detail. The
                  category chips are the report; a note is allowed only from a
                  named account, is capped short, and the server refuses one
                  that carries a phone number, an email or a digit run. The
                  client check below is courtesy, not defence: the same rules
                  run again on the way in. */}
              {user ? (
                <Stack gap={6}>
                  <TextField
                    label="Operational note (optional)"
                    value={comment}
                    onChangeText={setComment}
                    placeholder="e.g. casualty desk said no beds and directed us elsewhere"
                    multiline
                    maxLength={200}
                    hint="Facts about the facility only. Names, phone numbers and record numbers are refused."
                  />
                  {piiWarning ? (
                    <Banner
                      tone="warm"
                      icon="alert"
                      title="That note looks personal"
                      body={piiWarning + ' — remove it before sending; the server will refuse the report otherwise.'}
                    />
                  ) : null}
                </Stack>
              ) : (
                <Small muted style={{ fontSize: 11.5 }}>
                  Anonymous reports carry the category only. Sign in to attach an operational note — a note
                  without an author is a note nobody can follow up.
                </Small>
              )}

              {typeof result === 'string' && result !== 'sent' ? (
                <Banner tone="critical" icon="alert" title="Could not send" body={result} />
              ) : null}

              <Row gap="sm" justify="flex-end">
                <Button label="Cancel" onPress={close} />
                <Button
                  label={busy ? 'Sending…' : 'Send report'}
                  variant="primary"
                  icon="upload"
                  loading={busy}
                  disabled={Boolean(user && piiWarning)}
                  onPress={submit}
                />
              </Row>
              {!user ? (
                <Row gap="xs" align="center">
                  <Pill label="anonymous" tone="neutral" compact />
                  <Small muted style={{ fontSize: 11 }}>
                    You can report without an account — nothing that identifies you is stored.
                  </Small>
                </Row>
              ) : null}
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}
