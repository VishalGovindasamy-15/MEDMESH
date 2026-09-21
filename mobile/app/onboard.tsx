import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../src/api/client';
import type { OnboardingReceipt } from '../src/api/types';
import { useAuth } from '../src/state/AuthProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { radius, space } from '../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  Divider,
  Heading,
  KeyValue,
  Label,
  Num,
  Pill,
  Row,
  SectionHeader,
  Segmented,
  Small,
  Stack,
  SwitchRow,
  TextField,
  Title,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';
import { useResponsive } from '../src/ui/useResponsive';

/**
 * Facility onboarding (§6.10) — the public application form.
 *
 * This is the front door for a hospital that has never heard of MedMesh, and
 * it is the one surface that is deliberately *not* dense. Whoever fills it in
 * is a hospital administrator or a district officer doing the platform a
 * favour, once, on a phone, with no training: so it asks for operational facts
 * only, in the order a facility already knows them, and it says what happens
 * next instead of thanking them and going quiet.
 *
 * Two things it will not ask for, on purpose:
 *  - anything about patients — a hospital describing itself describes its beds,
 *    its theatre and its blood bank, not its caseload;
 *  - a system integration — that is a separate conversation the platform starts
 *    after a human has verified the facility exists.
 */

interface District {
  id: number;
  code: string;
  name: string;
  name_ta: string | null;
  lat: number;
  lng: number;
  hospital_count: number;
}

const SPECIALTY_CHOICES: { value: string; label: string }[] = [
  { value: 'general_medicine', label: 'General medicine' },
  { value: 'general_surgery', label: 'General surgery' },
  { value: 'obstetrics', label: 'Obstetrics' },
  { value: 'paediatrics', label: 'Paediatrics' },
  { value: 'orthopaedics', label: 'Orthopaedics' },
  { value: 'cardiology', label: 'Cardiology' },
  { value: 'neurology', label: 'Neurology' },
  { value: 'nephrology', label: 'Nephrology' },
  { value: 'pulmonology', label: 'Pulmonology' },
  { value: 'burns', label: 'Burns' },
  { value: 'psychiatry', label: 'Psychiatry' },
];

const STEPS = ['Facility', 'Capacity', 'Services', 'Contact'];

export default function Onboard() {
  const { t } = useTheme();
  const { token } = useAuth();
  const { isDesktop } = useResponsive();
  const router = useRouter();

  const [districts, setDistricts] = useState<District[]>([]);
  const [step, setStep] = useState(0);
  const [receipt, setReceipt] = useState<OnboardingReceipt | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

  const [form, setForm] = useState({
    name: '',
    short_name: '',
    type: 'private' as 'public' | 'private' | 'trust',
    district_id: '',
    lat: '',
    lng: '',
    address: '',
    total_beds: '',
    total_icu: '',
    total_ventilators: '',
    specialties: [] as string[],
    has_blood_bank: false,
    has_trauma_centre: false,
    contact_phone: '',
    emergency_phone: '',
    contact_email: '',
    has_existing_system: false,
  });

  useEffect(() => {
    (async () => {
      try {
        const res = await api.get<{ results: District[] }>('/hospitals/districts');
        setDistricts(res.results);
      } catch {
        setDistricts([]);
      }
    })();
  }, []);

  const district = districts.find((d) => String(d.id) === form.district_id) ?? null;

  // Coordinates are the one field a hospital administrator will not know, so
  // the district centre is used as the starting point and they only have to
  // nudge it if the facility is a long way from the town.
  const applyDistrictCentre = useCallback(
    (d: District) => {
      setForm((f) => ({
        ...f,
        district_id: String(d.id),
        lat: d.lat.toFixed(4),
        lng: d.lng.toFixed(4),
      }));
    },
    [],
  );

  const readiness = useMemo(() => {
    const problems: string[] = [];
    if (step === 0) {
      if (form.name.trim().length < 3) problems.push('Facility name is too short to identify');
      if (!form.district_id) problems.push('Choose the district the facility sits in');
      if (!form.lat || !form.lng) problems.push('Coordinates are needed for ambulance routing');
    }
    if (step === 1) {
      if (!form.total_beds) problems.push('Enter the total bed count (0 is allowed)');
      if (form.total_icu === '') problems.push('Enter the ICU bed count (0 is allowed)');
    }
    if (step === 2) {
      if (form.specialties.length === 0) problems.push('Select at least one specialty, or the matcher cannot use you');
    }
    if (step === 3) {
      const digits = form.contact_phone.replace(/\D/g, '');
      if (digits.length < 6) problems.push('A facility phone number is required — it is how verification calls you');
    }
    return problems;
  }, [step, form]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    setFieldErrors([]);
    try {
      const res = await api.post<OnboardingReceipt>(
        '/onboarding/facility',
        {
          name: form.name.trim(),
          short_name: form.short_name.trim(),
          type: form.type,
          district_id: Number(form.district_id),
          lat: Number(form.lat),
          lng: Number(form.lng),
          address: form.address.trim(),
          total_beds: Number(form.total_beds || 0),
          total_icu: Number(form.total_icu || 0),
          total_ventilators: Number(form.total_ventilators || 0),
          specialties: form.specialties,
          has_blood_bank: form.has_blood_bank,
          has_trauma_centre: form.has_trauma_centre,
          contact_phone: form.contact_phone.trim(),
          emergency_phone: form.emergency_phone.trim(),
          contact_email: form.contact_email.trim() || null,
          has_existing_system: form.has_existing_system,
        },
        { token },
      );
      setReceipt(res);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Could not submit the application');
      }
    } finally {
      setSubmitting(false);
    }
  }, [form, token]);

  if (receipt) {
    return (
      <AppShell title="Application received" subtitle={receipt.reference} maxWidth={880}>
        <ScrollView contentContainerStyle={{ paddingBottom: space.xxl, gap: space.lg }}>
          <Card>
            <Row gap={space.md} align="flex-start">
              <View
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: radius.lg,
                  backgroundColor: t.status.live.soft,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon name="check" size={18} color={t.status.live.base} strokeWidth={2.2} />
              </View>
              <Stack gap={space.sm} style={{ flex: 1 }}>
                <Title>{form.name.trim()}</Title>
                <Row gap={space.lg} wrap>
                  <KeyValue label="Reference">
                    <Num size={12.5}>{receipt.reference}</Num>
                  </KeyValue>
                  <KeyValue label="Status">
                    <Small>{receipt.verification.replace('_', ' ')}</Small>
                  </KeyValue>
                  <KeyValue label="District">
                    <Small>{district?.name ?? '—'}</Small>
                  </KeyValue>
                </Row>
                <Body muted>{receipt.message}</Body>
              </Stack>
            </Row>
          </Card>

          <Card>
            <SectionHeader label="What happens next" />
            <Stack gap={space.sm}>
              {receipt.next_steps.map((s, i) => (
                <Row key={s} gap={space.sm} align="flex-start">
                  <Num size={13} color={t.fg.faint}>
                    {i + 1}
                  </Num>
                  <Small style={{ flex: 1 }}>{s}</Small>
                </Row>
              ))}
            </Stack>
            <Divider />
            <Small muted style={{ marginTop: space.sm }}>
              Nothing about this facility is published while it sits unverified. That is deliberate: a listing
              nobody has checked is worse than no listing, because a family will act on it.
            </Small>
          </Card>

          <Row gap={space.md}>
            <Button label="Back to the directory" variant="secondary" onPress={() => router.push('/' as never)} />
            <Button
              label="Apply for another facility"
              variant="ghost"
              onPress={() => {
                setReceipt(null);
                setStep(0);
              }}
            />
          </Row>
        </ScrollView>
      </AppShell>
    );
  }

  return (
    <AppShell
      title="Add your hospital"
      subtitle="Public onboarding · no login needed"
      maxWidth={980}
      actions={
        <Button label="Directory" variant="ghost" icon="hospital" onPress={() => router.push('/' as never)} />
      }
    >
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxl, gap: space.lg }}>
        <Card>
          <Row justify="space-between" align="center" wrap gap={space.md}>
            <Stack gap={2} style={{ flex: 1, minWidth: 240 }}>
              <Heading>Register a facility with MedMesh</Heading>
              <Small muted>
                Any hospital in the state can join — government, trust or private. Registration is free, and the
                network is more useful to everyone the more of the district is in it. Nothing you submit is
                published until a district officer has verified the facility.
              </Small>
            </Stack>
            <Row gap={space.sm}>
              {STEPS.map((label, i) => (
                <Pill
                  key={label}
                  label={`${i + 1}. ${label}`}
                  tone={i === step ? 'info' : i < step ? 'live' : 'neutral'}
                />
              ))}
            </Row>
          </Row>
        </Card>

        {error ? (
          <Banner
            tone="critical"
            icon="alert"
            title="The application was not accepted"
            body={error}
            action={
              fieldErrors.length ? (
                <Stack gap={2} style={{ marginTop: space.xs }}>
                  {fieldErrors.map((f) => (
                    <Small key={f} style={{ color: t.status.critical.base }}>
                      · {f}
                    </Small>
                  ))}
                </Stack>
              ) : undefined
            }
          />
        ) : null}

        {step === 0 ? (
          <Card>
            <SectionHeader label="The facility" />
            <Stack gap={space.md}>
              <TextField
                label="Registered name"
                value={form.name}
                onChangeText={(v) => setForm((f) => ({ ...f, name: v }))}
                placeholder="Coimbatore North Taluk Hospital"
              />
              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 180 }}>
                  <TextField
                    label="Short name (optional)"
                    value={form.short_name}
                    onChangeText={(v) => setForm((f) => ({ ...f, short_name: v }))}
                    placeholder="CNTH"
                    autoCapitalize="characters"
                  />
                </View>
                <View style={{ flex: 2, minWidth: 240 }}>
                  <TextField
                    label="Street address"
                    value={form.address}
                    onChangeText={(v) => setForm((f) => ({ ...f, address: v }))}
                    placeholder="Mettupalayam Road, Coimbatore"
                  />
                </View>
              </Row>

              <Stack gap={6}>
                <Label>Type</Label>
                <Segmented
                  size="sm"
                  value={form.type}
                  onChange={(v) => setForm((f) => ({ ...f, type: v as 'public' | 'private' | 'trust' }))}
                  options={[
                    { value: 'public' as const, label: 'Government' },
                    { value: 'trust' as const, label: 'Trust' },
                    { value: 'private' as const, label: 'Private' },
                  ]}
                />
              </Stack>

              <Stack gap={6}>
                <Label>District</Label>
                <Row gap={space.sm} wrap>
                  {districts.map((d) => {
                    const active = String(d.id) === form.district_id;
                    return (
                      <Button
                        key={d.id}
                        label={`${d.name}${d.name_ta ? ` · ${d.name_ta}` : ''}`}
                        size="sm"
                        variant={active ? 'primary' : 'secondary'}
                        onPress={() => applyDistrictCentre(d)}
                      />
                    );
                  })}
                </Row>
                <Small muted>
                  Choosing a district fills in its centre as a starting point. Ambulance routing uses the
                  coordinates, so move them if the facility is well outside the town.
                </Small>
              </Stack>

              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 160 }}>
                  <TextField
                    label="Latitude"
                    value={form.lat}
                    onChangeText={(v) => setForm((f) => ({ ...f, lat: v }))}
                    placeholder="11.0168"
                    keyboardType="numeric"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 160 }}>
                  <TextField
                    label="Longitude"
                    value={form.lng}
                    onChangeText={(v) => setForm((f) => ({ ...f, lng: v }))}
                    placeholder="76.9558"
                    keyboardType="numeric"
                  />
                </View>
              </Row>
            </Stack>
          </Card>
        ) : null}

        {step === 1 ? (
          <Card>
            <SectionHeader label="Declared capacity" />
            <Stack gap={space.md}>
              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 150 }}>
                  <TextField
                    label="Total beds"
                    value={form.total_beds}
                    onChangeText={(v) => setForm((f) => ({ ...f, total_beds: v }))}
                    placeholder="240"
                    keyboardType="number-pad"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 150 }}>
                  <TextField
                    label="ICU beds"
                    value={form.total_icu}
                    onChangeText={(v) => setForm((f) => ({ ...f, total_icu: v }))}
                    placeholder="16"
                    keyboardType="number-pad"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 150 }}>
                  <TextField
                    label="Ventilators"
                    value={form.total_ventilators}
                    onChangeText={(v) => setForm((f) => ({ ...f, total_ventilators: v }))}
                    placeholder="8"
                    keyboardType="number-pad"
                  />
                </View>
              </Row>
              <Small muted>
                These are the totals the trust engine checks daily reports against. A figure of 4,000 beds on a
                40-bed facility is quarantined, not published — so it is worth counting once, properly.
              </Small>
            </Stack>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card>
            <SectionHeader label="Services" />
            <Stack gap={space.md}>
              <Stack gap={6}>
                <Label>Departments you can receive emergencies into</Label>
                <Row gap={space.sm} wrap>
                  {SPECIALTY_CHOICES.map((s) => {
                    const active = form.specialties.includes(s.value);
                    return (
                      <Button
                        key={s.value}
                        label={s.label}
                        size="sm"
                        variant={active ? 'primary' : 'secondary'}
                        onPress={() =>
                          setForm((f) => ({
                            ...f,
                            specialties: active
                              ? f.specialties.filter((x) => x !== s.value)
                              : [...f.specialties, s.value],
                          }))
                        }
                      />
                    );
                  })}
                </Row>
                <Small muted>
                  Select a department only if it is staffed for emergencies. A cardiology department with no
                  cardiologist on call ranks below one that has both — the matcher scores on the doctor, not the
                  sign on the door.
                </Small>
              </Stack>

              <Divider />
              <SwitchRow
                label="Blood bank on site"
                value={form.has_blood_bank}
                onChange={(v) => setForm((f) => ({ ...f, has_blood_bank: v }))}
              />
              <SwitchRow
                label="Trauma centre"
                value={form.has_trauma_centre}
                onChange={(v) => setForm((f) => ({ ...f, has_trauma_centre: v }))}
              />
              <SwitchRow
                label="We already have a hospital management system"
                value={form.has_existing_system}
                onChange={(v) => setForm((f) => ({ ...f, has_existing_system: v }))}
              />
              {form.has_existing_system ? (
                <Banner
                  tone="info"
                  icon="link"
                  title="You will not be asked to change systems"
                  body="Verification will ask which system you run and, if it can emit FHIR or a scheduled export, MedMesh will read from it. Otherwise staff enter figures through the facility portal — the majority of the network does this today."
                />
              ) : null}
            </Stack>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card>
            <SectionHeader label="Who we call" />
            <Stack gap={space.md}>
              <Row gap={space.md} wrap>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label="Facility phone"
                    value={form.contact_phone}
                    onChangeText={(v) => setForm((f) => ({ ...f, contact_phone: v }))}
                    placeholder="0422-2345678"
                    keyboardType="phone-pad"
                  />
                </View>
                <View style={{ flex: 1, minWidth: 200 }}>
                  <TextField
                    label="Emergency / casualty line"
                    value={form.emergency_phone}
                    onChangeText={(v) => setForm((f) => ({ ...f, emergency_phone: v }))}
                    placeholder="0422-2345699"
                    keyboardType="phone-pad"
                  />
                </View>
              </Row>
              <TextField
                label="Contact email"
                value={form.contact_email}
                onChangeText={(v) => setForm((f) => ({ ...f, contact_email: v }))}
                placeholder="bedcontrol@hospital.gov.in"
                keyboardType="email-address"
                autoCapitalize="none"
              />
              <Small muted>
                These are facility lines, not personal numbers, and they are stored against the facility. The
                platform holds no patient information at all, at any point, which is what lets it be shared
                across hospitals.
              </Small>
              <Divider />
              <Row justify="space-between" align="center" wrap gap={space.md}>
                <Stack gap={2}>
                  <Label>Ready to submit</Label>
                  <Small muted>
                    {form.name.trim() || 'Unnamed facility'} · {form.total_beds || 0} beds ·{' '}
                    {form.specialties.length} departments
                  </Small>
                </Stack>
                <Button
                  label="Submit application"
                  icon="check"
                  variant="primary"
                  onPress={submit}
                  loading={submitting}
                  disabled={readiness.length > 0}
                />
              </Row>
            </Stack>
          </Card>
        ) : null}

        {readiness.length ? (
          <Card tone="warm">
            <SectionHeader label="Before you continue" />
            <Stack gap={space.xs}>
              {readiness.map((r) => (
                <Small key={r}>· {r}</Small>
              ))}
            </Stack>
          </Card>
        ) : null}

        <Row justify="space-between" align="center">
          <Button
            label="Back"
            variant="ghost"
            icon="arrowleft"
            onPress={() => setStep((s) => Math.max(0, s - 1))}
            disabled={step === 0}
          />
          <Row gap={space.sm} align="center">
            <Small muted>
              Step {step + 1} of {STEPS.length}
            </Small>
            <Button
              label="Next"
              iconRight="arrowright"
              variant="secondary"
              onPress={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              disabled={step === STEPS.length - 1 || readiness.length > 0}
            />
          </Row>
        </Row>
      </ScrollView>
    </AppShell>
  );
}

const styles = StyleSheet.create({});
