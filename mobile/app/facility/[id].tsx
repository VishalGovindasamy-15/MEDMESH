import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { api, ApiError } from '../../src/api/client';
import type { FacilityDetail } from '../../src/api/types';
import { CAPABILITY_LABELS, countdown, specialtyLabel } from '../../src/lib/format';
import { ageLabel, useLive } from '../../src/state/LiveProvider';
import { congestionStatus, freshnessStatus, useTheme } from '../../src/theme/ThemeProvider';
import { space } from '../../src/theme/tokens';
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
  Meter,
  Num,
  Pill,
  Row,
  Small,
  Stack,
  Sparkline,
  Stat,
  TrustChip,
} from '../../src/ui';
import { Icon } from '../../src/ui/Icon';
import { AppShell } from '../../src/ui/Shell';
import { useResponsive } from '../../src/ui/useResponsive';
import { MapSurface } from '../../src/components/MapSurface';
import { toMapPoints } from '../../src/components/mapTypes';
import { ReportSheet } from '../../src/components/ReportSheet';

export default function FacilityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const facilityId = Number(id);
  const { t } = useTheme();
  const router = useRouter();
  const { isDesktop } = useResponsive();
  const { facilities: liveFacilities } = useLive();

  const [detail, setDetail] = useState<FacilityDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reporting, setReporting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await api.get<FacilityDetail>(`/hospitals/${facilityId}?history_hours=24`);
        if (!cancelled) {
          setDetail(data);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof ApiError ? err.message : 'Could not load this facility');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [facilityId]);

  const live = liveFacilities[facilityId];
  const capacity = live?.capacity ?? detail?.capacity ?? null;

  const sparkBeds = useMemo(() => detail?.history.map((h) => h.beds) ?? [], [detail]);
  const sparkIcu = useMemo(() => detail?.history.map((h) => h.icu) ?? [], [detail]);

  if (error) {
    return (
      <AppShell title="Facility" subtitle="Directory">
        <EmptyState
          icon="alert"
          title="That facility could not be loaded"
          body={error}
          action={<Button label="Back to directory" icon="chevronLeft" onPress={() => router.push('/')} />}
        />
      </AppShell>
    );
  }

  if (!detail || !capacity) {
    return (
      <AppShell title="Facility" subtitle="Loading">
        <Loading label="Loading facility record…" />
      </AppShell>
    );
  }

  const fresh = freshnessStatus(capacity.trust_state);
  const edTone = congestionStatus(capacity.ed_congestion);
  const contactNumber = detail.emergency_phone || detail.phone;

  return (
    <AppShell
      title={detail.short_name}
      subtitle={`${detail.type_label} · ${detail.district_name ?? ''}`}
      maxWidth={1180}
      actions={
        <Row gap="xs">
          <Button label="Back" icon="chevronLeft" size="sm" onPress={() => router.push('/')} />
          <Button
            label="Call"
            icon="phone"
            size="sm"
            variant="primary"
            onPress={() => Linking.openURL(`tel:${contactNumber.replace(/[^\d+]/g, '')}`)}
          />
        </Row>
      }
      footerNote="Figures are self-reported by the facility and timestamped. MedMesh does not store patient data."
      scroll={false}
    >
      <ScrollView contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}>
        <Row gap="sm" align="center" wrap>
          <Row gap="xs" align="center">
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.status[fresh].base }} />
            <Label tone={t.status[fresh].base}>
              {capacity.trust_state === 'live'
                ? 'Live'
                : `Reported ${ageLabel(Math.floor((Date.now() - new Date(capacity.recorded_at).getTime()) / 1000))}`}
            </Label>
          </Row>
          {detail.verification === 'verified' ? (
            <Pill label="Verified facility" tone="live" icon="shield" compact />
          ) : (
            <Pill label={`${detail.verification} — treat with caution`} tone="warm" icon="alert" compact />
          )}
          <Pill
            label={detail.integration === 'api' ? `System feed · ${detail.source_system ?? 'API'}` : 'Manual entry by staff'}
            tone={detail.integration === 'api' ? 'info' : 'neutral'}
            icon={detail.integration === 'api' ? 'activity' : 'user'}
            compact
          />
          <TrustChip score={detail.trust?.score} band={detail.trust?.band} />
        </Row>

        {capacity.holds_active > 0 ? (
          <Banner
            tone="info"
            icon="lock"
            title={`${capacity.holds_active} resource${capacity.holds_active > 1 ? 's' : ''} held for inbound ambulances`}
            body="Held capacity is already committed and is excluded from the numbers below."
          />
        ) : null}

        {/* Headline capacity -------------------------------------------- */}
        <Card style={{ gap: space.lg }}>
          <Row gap="xl" wrap>
            <Stat
              label="General beds free"
              value={capacity.beds_effective}
              unit={`of ${detail.declared.beds}`}
              tone={capacity.beds_effective === 0 ? 'critical' : capacity.beds_effective < 8 ? 'warm' : 'live'}
              meter={{ value: capacity.beds_effective, total: detail.declared.beds }}
              sub={`${Math.round((1 - capacity.beds_effective / detail.declared.beds) * 100)}% occupancy`}
            />
            <Stat
              label="ICU free"
              value={capacity.icu_effective}
              unit={`of ${detail.declared.icu}`}
              tone={capacity.icu_effective === 0 ? 'critical' : capacity.icu_effective < 3 ? 'warm' : 'live'}
              meter={{ value: capacity.icu_effective, total: detail.declared.icu }}
              sub="adult / paediatric combined"
            />
            <Stat
              label="Ventilators free"
              value={capacity.vent_effective}
              unit={`of ${detail.declared.ventilators}`}
              tone={capacity.vent_effective === 0 ? 'stale' : 'info'}
              meter={{ value: capacity.vent_effective, total: detail.declared.ventilators }}
              sub="ventilated beds"
            />
            <Stat
              label="Emergency dept."
              value={capacity.ed_waiting}
              unit="waiting"
              tone={edTone}
              sub={`congestion ${capacity.ed_congestion}`}
            />
          </Row>

          <Divider />

          <Row gap="xl" wrap>
            <Stack gap="xs" style={{ flex: 1, minWidth: 200 }}>
              <Label>Last 24 hours — beds available</Label>
              <Row align="center" gap="md">
                <Spark data={sparkBeds} colour={t.status.live.base} />
                <MiniStats data={sparkBeds} label="beds" />
              </Row>
            </Stack>
            <Stack gap="xs" style={{ flex: 1, minWidth: 200 }}>
              <Label>Last 24 hours — ICU available</Label>
              <Row align="center" gap="md">
                <Spark data={sparkIcu} colour={t.accent.base} />
                <MiniStats data={sparkIcu} label="ICU" />
              </Row>
            </Stack>
            <Stack gap="xs" style={{ flex: 1, minWidth: 160 }}>
              <Label>Blood & stock</Label>
              <KeyValue label="Blood units" dense>
                <Num size={13}>{capacity.blood_units}</Num>
              </KeyValue>
              <KeyValue label="Antivenom vials" dense>
                <Num size={13}>{capacity.antivenom_vials}</Num>
              </KeyValue>
              <KeyValue label="Records (24 h)" dense last>
                <Num size={13}>{detail.history.length}</Num>
              </KeyValue>
            </Stack>
          </Row>
        </Card>

        <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
          {/* Left column ------------------------------------------------ */}
          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 340 : '100%' }}>
            <Card style={{ gap: space.md }}>
              <Heading>Doctors on duty</Heading>
              {detail.doctors_on_duty.length === 0 ? (
                <Small muted>
                  No roster is published for this facility. Call the emergency desk to confirm specialist cover.
                </Small>
              ) : (
                <Stack gap="sm">
                  {detail.doctors_on_duty.slice(0, 8).map((doc) => (
                    <Row key={doc.id} justify="space-between" align="center" gap="md">
                      <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                        <Body style={{ fontWeight: '600', fontSize: 13.5 }}>{doc.full_name}</Body>
                        <Small muted style={{ fontSize: 12 }}>
                          {specialtyLabel(doc.specialty)} · {doc.designation}
                        </Small>
                      </Stack>
                      <Stack gap="xxs" align="flex-end">
                        <Pill label={doc.shift} tone="neutral" compact outline />
                        {doc.accepts_emergency ? (
                          <Label style={{ fontSize: 9.5 }} tone={t.status.live.base}>
                            takes emergency
                          </Label>
                        ) : null}
                      </Stack>
                    </Row>
                  ))}
                  {detail.doctors_on_duty.length > 8 ? (
                    <Small muted>+ {detail.doctors_on_duty.length - 8} more on the roster</Small>
                  ) : null}
                </Stack>
              )}
              {detail.expose_doctor_directory === false ? (
                <Banner
                  tone="neutral"
                  icon="lock"
                  title="Roster withheld"
                  body="This facility has opted out of publishing clinician detail. Aggregate capacity remains visible."
                />
              ) : null}
            </Card>

            <Card style={{ gap: space.sm }}>
              <Heading>Capabilities</Heading>
              <Row gap="xs" wrap>
                {Object.entries(detail.capabilities)
                  .filter(([, v]) => v)
                  .map(([k]) => (
                    <Pill key={k} label={CAPABILITY_LABELS[k] ?? k} tone="info" icon="check" compact />
                  ))}
                {Object.values(detail.capabilities).every((v) => !v) ? (
                  <Small muted>No specialised units listed for this facility.</Small>
                ) : null}
              </Row>
              <Divider />
              <Label>Services</Label>
              <Row gap="xs" wrap>
                {detail.specialties.map((s) => (
                  <Pill key={s} label={specialtyLabel(s)} tone="neutral" compact outline />
                ))}
              </Row>
            </Card>

            {detail.trust?.factors?.length ? (
              <Card style={{ gap: space.sm }}>
                <Row justify="space-between" align="center">
                  <Heading>Why this facility scores {detail.trust.score}</Heading>
                  <Pill label={detail.trust.band} tone={detail.trust.band === 'high' ? 'live' : detail.trust.band === 'medium' ? 'warm' : 'stale'} compact />
                </Row>
                <Stack gap={0}>
                  {detail.trust.factors.map((f, i) => (
                    <Row key={f.label} justify="space-between" align="flex-start" gap="md" style={{ paddingVertical: 7, borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth, borderTopColor: t.line.subtle }}>
                      <Stack gap="xxs" style={{ flex: 1 }}>
                        <Body style={{ fontSize: 13, fontWeight: '600' }}>{f.label}</Body>
                        <Small muted style={{ fontSize: 12 }}>
                          {f.detail}
                        </Small>
                      </Stack>
                      <Num
                        size={12.5}
                        color={f.delta.startsWith('-') ? t.status.stale.base : t.status.live.base}
                      >
                        {f.delta}
                      </Num>
                    </Row>
                  ))}
                </Stack>
                <Small muted style={{ fontSize: 11 }}>
                  Trust score is a summary of data provenance, freshness, verification and reported mismatches. It is
                  never a judgement about clinical quality.
                </Small>
              </Card>
            ) : null}
          </Stack>

          {/* Right column ---------------------------------------------- */}
          <Stack gap="lg" style={{ flex: 1, minWidth: isDesktop ? 320 : '100%' }}>
            <MapSurface
              points={toMapPoints([detail])}
              center={{ lat: detail.lat, lng: detail.lng }}
              zoom={14}
              height={isDesktop ? 220 : 200}
              selectedId={detail.id}
              showLegend={false}
            />

            <Card style={{ gap: space.sm }}>
              <Heading>Contact & location</Heading>
              <KeyValue label="Emergency desk" dense>
                <Pressable onPress={() => Linking.openURL(`tel:${contactNumber.replace(/[^\d+]/g, '')}`)}>
                  <Num size={13} color={t.accent.base}>
                    {contactNumber}
                  </Num>
                </Pressable>
              </KeyValue>
              <KeyValue label="Switchboard" dense>
                <Num size={13}>{detail.phone}</Num>
              </KeyValue>
              <KeyValue label="Address" dense>
                <Small style={{ textAlign: 'right', maxWidth: 190 }}>{detail.address}</Small>
              </KeyValue>
              <KeyValue label="Coordinates" dense last>
                <Num size={12}>
                  {detail.lat.toFixed(4)}, {detail.lng.toFixed(4)}
                </Num>
              </KeyValue>
            </Card>

            {detail.active_holds.length ? (
              <Card style={{ gap: space.sm }} tone="info">
                <Heading>Active holds</Heading>
                {detail.active_holds.map((h) => (
                  <Row key={h.id} justify="space-between" align="center">
                    <Pill label={h.resource} tone="info" compact icon="lock" />
                    <Num size={12.5} color={t.status.info.base}>
                      {countdown(h.seconds_remaining)}
                    </Num>
                  </Row>
                ))}
                <Small muted style={{ fontSize: 11 }}>
                  Holds reserve capacity for a specific inbound ambulance and release automatically.
                </Small>
              </Card>
            ) : null}

            {detail.history.some((h) => h.quarantined) ? (
              <Banner
                tone="warm"
                icon="alert"
                title="Anomalous updates were withheld"
                body="Some reported figures were implausible and are excluded from the live view pending review. The facility is not at fault — clerical errors are common during shift change."
              />
            ) : null}

            <Row gap="sm" wrap>
              <Button label="Report incorrect info" icon="flag" onPress={() => setReporting(true)} />
              <Button
                label="Guiding directions"
                icon="route"
                onPress={() =>
                  Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${detail.lat},${detail.lng}`)
                }
              />
            </Row>

            <Small muted style={{ fontSize: 11 }}>
              Bed counts are indicative. Always confirm with the receiving facility before committing a patient — the
              number shown can be minutes old and does not reflect a bed that has just been allocated by ward staff.
            </Small>
          </Stack>
        </Row>
      </ScrollView>

      <ReportSheet
        visible={reporting}
        hospitalId={facilityId}
        hospitalName={detail.short_name}
        onClose={() => setReporting(false)}
      />
    </AppShell>
  );
}

/* --------------------------------------------------------------- fragments */

function Spark({ data, colour }: { data: number[]; colour: string }) {
  if (data.length < 3) {
    return (
      <View style={{ height: 34, justifyContent: 'center' }}>
        <Small muted style={{ fontSize: 11 }}>
          Not enough history yet
        </Small>
      </View>
    );
  }
  return <Sparkline data={data} width={132} height={34} colour={colour} />;
}

function MiniStats({ data, label }: { data: number[]; label: string }) {
  const { t } = useTheme();
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const last = data[data.length - 1];
  const delta = last - data[0];
  return (
    <Stack gap="xxs">
      <Row gap="xs" align="baseline">
        <Num size={14}>{last}</Num>
        <Small muted style={{ fontSize: 11 }}>
          now
        </Small>
      </Row>
      <Small muted style={{ fontSize: 10.5 }}>
        low {min} · high {max}
      </Small>
      <Small
        style={{ fontSize: 10.5 }}
        muted={delta === 0}
      >
        {delta === 0 ? 'flat over 24 h' : `${delta > 0 ? '↑' : '↓'} ${Math.abs(delta)} ${label} over 24 h`}
      </Small>
    </Stack>
  );
}
