import { useRouter } from 'expo-router';
import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { api } from '../src/api/client';
import type { District, Facility } from '../src/api/types';
import { FacilityRow } from '../src/components/FacilityRow';
import { DistrictPicker } from '../src/components/DistrictPicker';
import { MapSurface } from '../src/components/MapSurface';
import { toMapPoints } from '../src/components/mapTypes';
import { VoiceSearchField } from '../src/components/VoiceSearch';
import { CAPABILITY_LABELS } from '../src/lib/format';
import { useAuth } from '../src/state/AuthProvider';
import { ageLabel, useLive } from '../src/state/LiveProvider';
import { useTheme } from '../src/theme/ThemeProvider';
import { space } from '../src/theme/tokens';
import {
  Banner,
  Body,
  Button,
  Card,
  EmptyState,
  Label,
  Loading,
  Num,
  Pill,
  Row,
  Segmented,
  Small,
  Stack,
  Stat,
  TextField,
  Title,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { AppShell } from '../src/ui/Shell';
import { useResponsive } from '../src/ui/useResponsive';

type FilterKey =
  | 'all'
  | 'icu'
  | 'ventilator'
  | 'public'
  | 'private'
  | 'trauma'
  | 'blood'
  | 'antivenom';

/**
 * Filters are ordered by what someone is actually looking for under pressure.
 * `blood` and `antivenom` are in the same list as `icu` because §7 is right that
 * they are equally time-critical, and neither is discoverable by name alone —
 * the facility page always showed the counts, but a family searching for a
 * snakebite antivenom had no way to filter down to the hospitals that have it.
 */
const FILTERS: { value: FilterKey; key: string }[] = [
  { value: 'all', key: 'filter.all' },
  { value: 'icu', key: 'filter.icu' },
  { value: 'ventilator', key: 'filter.ventilator' },
  { value: 'trauma', key: 'filter.trauma' },
  { value: 'blood', key: 'filter.bloodBank' },
  { value: 'antivenom', key: 'filter.antivenom' },
  { value: 'public', key: 'filter.public' },
  { value: 'private', key: 'filter.private' },
];

export default function DirectoryScreen() {
  const { t, tr, lang, setLang } = useTheme();
  const router = useRouter();
  const { isDesktop, isPhone, width } = useResponsive();
  const { facilities: liveFacilities, connected, lastEventAt } = useLive();
  const { user } = useAuth();

  const [facilities, setFacilities] = useState<Facility[] | null>(null);
  const [districts, setDistricts] = useState<District[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterKey>('all');
  const [districtId, setDistrictId] = useState<number | null>(null);
  const [districtPickerOpen, setDistrictPickerOpen] = useState(false);
  // #22: on a phone the map used to open first and full-width, pushing the
  // search box, the filters and the first hospital below the fold — the reader
  // who came for "where can I go right now" got scenery. Desktop keeps it open;
  // a phone starts with the list and the map is one tap away.
  const [showMap, setShowMap] = useState(!isPhone);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [dir, dist] = await Promise.all([
        api.get<{ count: number; results: Facility[] }>('/hospitals?limit=400'),
        api.get<{ results: District[] }>('/hospitals/districts'),
      ]);
      setFacilities(dir.results);
      setDistricts(dist.results);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach the API');
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    // The socket pushes deltas; this poll is a slow safety net for the case
    // where the socket reconnected mid-change and missed a frame.
    const id = setInterval(() => load(true), 60_000);
    return () => clearInterval(id);
  }, []);

  // Overlay live socket values onto the fetched directory so the list moves
  // without a refetch.
  const merged = useMemo(() => {
    if (!facilities) return [];
    return facilities.map((f) => {
      const live = liveFacilities[f.id];
      if (!live?.capacity) return f;
      return {
        ...f,
        capacity: live.capacity,
        trust: live.trust ?? f.trust,
      };
    });
  }, [facilities, liveFacilities]);

  /**
   * The directory narrowed by district and search only — the scope a filter
   * count is supposed to describe.
   *
   * A facet count has to be computed over the list the facet will act on, with
   * the facet itself excluded. Counting the ICU filter over the raw directory
   * meant the badge read "ICU 96" while the reader was looking at a district
   * with nine hospitals in it, and counting it over `filtered` instead would
   * make the number collapse the moment you selected it. This is the middle
   * list: everything the reader has already chosen, before the chip.
   */
  /**
   * Everything a search term is allowed to match (#51).
   *
   * The search used to look at the name, the short name and the street address,
   * which is what a gazetteer searches — not what somebody looking for care
   * searches. "snakebite Pollachi" is a capability and a place; "trauma centre
   * government" is a capability and an ownership; neither found anything here.
   * So the haystack now carries the district, the ownership label, the
   * specialties the facility declares, and a plain-language line per capability,
   * plus a few synonyms the field actually uses ("snakebite" for antivenom,
   * "nicu" for neonatal intensive care).
   */
  const haystack = useMemo(() => {
    const capabilityWords = (f: Facility) =>
      [
        f.capabilities.blood_bank ? 'blood bank transfusion' : '',
        f.capabilities.trauma_centre ? 'trauma centre accident injury' : '',
        f.capabilities.cath_lab ? 'cath lab cardiac catheterisation angioplasty heart' : '',
        f.capabilities.burn_unit ? 'burns burn unit fire scald' : '',
        f.capabilities.dialysis ? 'dialysis renal kidney' : '',
        f.capabilities.neonatal_icu ? 'neonatal icu nicu newborn baby premature' : '',
        (f.capacity?.antivenom_vials ?? 0) > 0 ? 'antivenom snakebite snake bite venom' : '',
        (f.capacity?.blood_units ?? 0) > 0 ? 'blood units stocked' : '',
      ]
        .filter(Boolean)
        .join(' ');
    const map = new Map<number, string>();
    merged.forEach((f) => {
      map.set(
        f.id,
        [
          f.name,
          f.short_name,
          f.address,
          f.district_name ?? '',
          f.type_label,
          f.specialties.join(' ').replace(/_/g, ' '),
          capabilityWords(f),
        ]
          .join(' ')
          .toLowerCase(),
      );
    });
    return map;
  }, [merged]);

  const scoped = useMemo(() => {
    const q = query.trim().toLowerCase();
    return merged.filter((f) => {
      if (districtId && f.district_id !== districtId) return false;
      if (q) {
        // Every word of the query has to land somewhere, in any order, so a
        // capability plus a place works without either being a prefix of the
        // other.
        const hay = haystack.get(f.id) ?? '';
        if (!q.split(/\s+/).every((word) => hay.includes(word))) return false;
      }
      return true;
    });
  }, [merged, query, districtId, haystack]);

  const filtered = useMemo(() => {
    return scoped.filter((f) => {
      const cap = f.capacity;
      switch (filter) {
        case 'icu':
          return !!cap && cap.icu_effective > 0;
        case 'ventilator':
          return !!cap && cap.vent_effective > 0;
        case 'trauma':
          return f.capabilities.trauma_centre;
        case 'blood':
          // "Has a blood bank" is a capability; "has units on the shelf" is the
          // fact that decides whether the journey is worth making, so the filter
          // requires stock rather than a sign on the door.
          return !!cap && cap.blood_units > 0;
        case 'antivenom':
          return !!cap && cap.antivenom_vials > 0;
        case 'public':
          return f.type === 'public';
        case 'private':
          return f.type === 'private';
        default:
          return true;
      }
    });
  }, [scoped, filter]);

  /**
   * The headline figures.
   *
   * Computed over `filtered`, not over `merged`. They used to run over the whole
   * directory, so choosing a district changed the list and the map and left the
   * four numbers above them untouched — the summary said 4,459 ICU beds across
   * Tamil Nadu while the list beneath it showed eleven hospitals in Kanniyakumari.
   * A number that does not move when its own filter moves is worse than no
   * number: it reads as a total for the thing you are looking at, and silently
   * is not.
   *
   * The unfiltered totals are kept as `statewide`, because "is there capacity
   * anywhere, or only here" is a real question and the answer should not require
   * clearing the filter to find out.
   */
  const totals = useMemo(() => {
    const withData = filtered.filter((f) => f.capacity);
    return {
      facilities: filtered.length,
      live: withData.filter((f) => f.capacity!.trust_state === 'live').length,
      beds: withData.reduce((sum, f) => sum + (f.capacity!.beds_effective ?? 0), 0),
      icu: withData.reduce((sum, f) => sum + (f.capacity!.icu_effective ?? 0), 0),
      vent: withData.reduce((sum, f) => sum + (f.capacity!.vent_effective ?? 0), 0),
    };
  }, [filtered]);

  const statewide = useMemo(() => {
    const withData = merged.filter((f) => f.capacity);
    return {
      facilities: merged.length,
      icu: withData.reduce((sum, f) => sum + (f.capacity!.icu_effective ?? 0), 0),
    };
  }, [merged]);

  /**
   * One count per filter chip, over the scoped list.
   *
   * The chips previously carried no count at all except ICU, which is what made
   * the one wrong count so conspicuous: a reader toggling a filter had no way to
   * tell whether selecting it would leave nine hospitals or none.
   */
  const facetCounts = useMemo(() => {
    const has = (fn: (f: (typeof scoped)[number]) => boolean) => scoped.filter(fn).length;
    return {
      icu: has((f) => (f.capacity?.icu_effective ?? 0) > 0),
      ventilator: has((f) => (f.capacity?.vent_effective ?? 0) > 0),
      trauma: has((f) => f.capabilities.trauma_centre),
      blood: has((f) => (f.capacity?.blood_units ?? 0) > 0),
      antivenom: has((f) => (f.capacity?.antivenom_vials ?? 0) > 0),
      public: has((f) => f.type === 'public'),
      private: has((f) => f.type === 'private'),
      all: scoped.length,
    } as Record<FilterKey, number>;
  }, [scoped]);

  const selectedDistrict = districtId ? districts.find((d) => d.id === districtId) : null;

  const mapWidth = isPhone ? width - 24 : isDesktop ? 620 : width - 72;

  return (
    <AppShell
      title={tr('home.title')}
      subtitle={
        // "Coimbatore region" was printed whenever no district was chosen, which
        // is both wrong and misleading once the dataset covers all 38: the
        // default view is the whole state, and labelling it after one city tells
        // a reader in Madurai that the platform does not cover them.
        selectedDistrict
          ? `${selectedDistrict.name} district · ${filtered.length} facilit${filtered.length === 1 ? 'y' : 'ies'}`
          : `Tamil Nadu · all ${districts.length} districts · ${filtered.length} facilities reporting`
      }
      maxWidth={1320}
      actions={
        // The public front door to onboarding. It is here rather than buried in
        // an admin area on purpose: the hospitals that are hardest to reach are
        // exactly the ones that will not be told about a portal by head office.
        <Row gap={space.sm} align="center">
          <Segmented
            size="sm"
            value={lang}
            onChange={(v) => setLang(v as 'en' | 'ta')}
            options={[
              { value: 'en' as const, label: 'EN' },
              { value: 'ta' as const, label: 'த' },
            ]}
          />
          {user ? (
            <Button
              label="Inbox"
              variant="ghost"
              icon="bell"
              onPress={() => router.push('/inbox' as never)}
            />
          ) : null}
          <Button
            label="Add your hospital"
            variant="secondary"
            icon="plus"
            onPress={() => router.push('/onboard' as never)}
          />
        </Row>
      }
      footerNote={tr('home.disclaimer')}
      scroll={false}
    >
      <ScrollView
        contentContainerStyle={{ paddingBottom: space.xxxl, gap: space.lg }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load()} />}
      >
        {!connected ? (
          <Banner
            tone="warm"
            icon="wifiOff"
            title="Live feed disconnected"
            body="Showing the last data received. Figures below may be several minutes old."
          />
        ) : null}

        {error ? (
          <Banner
            tone="critical"
            icon="alert"
            title="Cannot reach the MedMesh API"
            body={`${error}. The backend may still be starting — retry in a moment.`}
            action={
              <View style={{ marginTop: space.sm }}>
                <Button label="Retry" icon="refresh" size="sm" onPress={() => load()} />
              </View>
            }
          />
        ) : null}

        {/* Summary strip ------------------------------------------------- */}
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: space.xl,
            padding: space.lg,
            borderRadius: 9,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.line.base,
            backgroundColor: t.bg.surface,
          }}
        >
          <Stat
            label={tr('common.beds')}
            value={totals.beds}
            sub={tr('home.facilities', { n: totals.facilities })}
            tone={totals.beds > 200 ? 'live' : 'warm'}
          />
          <Stat
            label={tr('common.icu')}
            value={totals.icu}
            tone={totals.icu > 30 ? 'live' : 'stale'}
            sub={tr('common.available')}
          />
          <Stat
            label={tr('common.ventilators')}
            value={totals.vent}
            tone="info"
            sub={tr('common.available')}
          />
          <Stat
            label={tr('home.reportingLive')}
            value={`${totals.live}/${totals.facilities}`}
            tone={totals.live / Math.max(totals.facilities, 1) > 0.7 ? 'live' : 'warm'}
            sub={
              lastEventAt
                ? tr('home.updatedAgo', { age: ageLabel(Math.floor((Date.now() - lastEventAt) / 1000)) })
                : tr('home.updatedNow')
            }
          />
        </View>

        {/*
          What the figures above cover, stated rather than implied. Without this
          the strip is four unlabelled totals whose meaning changes with the
          filter, which is how a reader ends up quoting a district's ICU count as
          the state's.
        */}
        <Row gap="sm" align="center" style={{ flexWrap: 'wrap', marginTop: -space.sm }}>
          <Pill
            compact
            tone={selectedDistrict ? 'info' : 'neutral'}
            label={selectedDistrict ? `Scoped to ${selectedDistrict.name}` : `Scoped to all ${districts.length} districts`}
          />
          <Small muted style={{ fontSize: 11.5 }}>
            {selectedDistrict
              ? `Statewide there are ${statewide.icu.toLocaleString()} ICU beds free across ${statewide.facilities} facilities.`
              : 'Clear the district filter to see a single district on its own.'}
          </Small>
          {query.trim() ? (
            <Small muted style={{ fontSize: 11.5 }}>
              Search text also narrows the figures — {totals.facilities} of {statewide.facilities} facilities match.
            </Small>
          ) : null}
        </Row>

        {/* Search + filters --------------------------------------------- */}
        <Stack gap="md">
          <Row gap="md" align="center" style={{ flexWrap: 'wrap' }}>
            <View style={{ flex: 1, minWidth: 240 }}>
              <VoiceSearchField
                value={query}
                onChangeText={setQuery}
                placeholder={tr('home.search')}
                hint={tr('home.searchHint')}
                voiceLabel={tr('home.voice')}
                listeningLabel={tr('home.voiceListening')}
                unsupportedLabel={tr('home.voiceUnsupported')}
                lang={lang}
              />
            </View>
            {!isPhone ? (
              <Row gap="xs">
                <Button
                  label={showMap ? tr('home.hideMap') : tr('home.showMap')}
                  icon={showMap ? 'layers' : 'pin'}
                  size="md"
                  onPress={() => setShowMap((v) => !v)}
                />
                <Button
                  label="Doctors"
                  icon="users"
                  size="md"
                  onPress={() => router.push('/doctors')}
                />
              </Row>
            ) : null}
          </Row>

          <Segmented
            options={FILTERS.map((f) => ({
              value: f.value,
              label: tr(f.key),
              // Counted over `scoped`, so the badge describes the list the chip
              // will produce rather than the state's whole directory. (#21)
              count: f.value === 'all' ? scoped.length : facetCounts[f.value],
            }))}
            value={filter}
            onChange={setFilter}
            scroll
          />

          {/*
            District chooser.

            This was a single horizontal `Segmented` carrying all 38 districts,
            which is a forty-item scroll on a phone: reaching Kanniyakumari meant
            dragging past thirty-nine targets, and the only affordance for
            finding one was knowing where it sat in the list. The first six
            districts in the population order get a chip; the rest live behind a
            searchable picker that shows how many facilities each has, so the
            choice can be made by name or by size.
          */}
          <Stack gap="sm">
            <Row gap="sm" align="center" justify="space-between">
              <Segmented
                options={[
                  { value: 'all', label: tr('home.districts') },
                  ...districts.slice(0, 5).map((d) => ({ value: String(d.id), label: d.name })),
                ]}
                value={
                  districtId === null || districts.findIndex((d) => d.id === districtId) >= 5
                    ? 'all'
                    : String(districtId)
                }
                onChange={(v) => setDistrictId(v === 'all' ? null : Number(v))}
                size="sm"
                scroll
              />
              <Button
                size="sm"
                icon="search"
                label={
                  !selectedDistrict || districts.findIndex((d) => d.id === districtId) >= 5
                    ? `All ${districts.length} districts`
                    : selectedDistrict.name
                }
                onPress={() => setDistrictPickerOpen(true)}
              />
            </Row>
            {districtPickerOpen ? (
              <DistrictPicker
                districts={districts.map((d) => ({
                  ...d,
                  facilities: merged.filter((f) => f.district_id === d.id).length,
                }))}
                value={districtId}
                onPick={(id) => {
                  setDistrictId(id);
                  setDistrictPickerOpen(false);
                }}
                onClose={() => setDistrictPickerOpen(false)}
              />
            ) : null}
          </Stack>
        </Stack>

        {/* Map ---------------------------------------------------------- */}
        {showMap ? (
          <Stack gap="sm">
            <Row justify="space-between" align="center">
              <Label>{tr('home.map')}</Label>
              <Small muted style={{ fontSize: 11 }}>
                {tr('home.shown', { shown: filtered.length, total: merged.length })}
              </Small>
            </Row>
            <MapSurface
              points={toMapPoints(filtered)}
              width={isDesktop ? Math.min(620, mapWidth) : width - 24}
              height={isPhone ? 230 : 320}
              selectedId={null}
              onSelect={(id) => router.push(`/facility/${id}`)}
            />
          </Stack>
        ) : null}

        {/* List --------------------------------------------------------- */}
        <Card padded={false} style={{ overflow: 'hidden' }}>
          <Row
            justify="space-between"
            align="center"
            style={{
              paddingHorizontal: space.lg,
              paddingVertical: space.md,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: t.line.subtle,
              backgroundColor: t.bg.sunken,
            }}
          >
            <Label>Hospitals by available capacity</Label>
            <Row gap="xs" align="center">
              <Icon name="filter" size={13} color={t.fg.faint} />
              <Small muted style={{ fontSize: 11 }}>
                holds deducted
              </Small>
            </Row>
          </Row>

          {facilities === null ? (
            <Loading label="Loading the capacity directory…" />
          ) : filtered.length === 0 ? (
            <EmptyState
              icon="search"
              title="No facility matches those filters"
              body="Try clearing the search text or switching back to All. Filters like ICU free will hide facilities that are genuinely full."
              action={
                <Button
                  label="Reset filters"
                  onPress={() => {
                    setFilter('all');
                    setQuery('');
                    setDistrictId(null);
                  }}
                />
              }
            />
          ) : (
            filtered.map((facility, index) => (
              <View key={facility.id}>
                {index > 0 ? (
                  <View
                    style={{
                      height: StyleSheet.hairlineWidth,
                      backgroundColor: t.line.subtle,
                      marginHorizontal: space.lg,
                    }}
                  />
                ) : null}
                <FacilityRow facility={facility} onPress={() => router.push(`/facility/${facility.id}`)} />
              </View>
            ))
          )}
        </Card>

        <Row gap="sm" align="center" style={{ paddingTop: space.xs }}>
          <Icon name="info" size={13} color={t.fg.faint} />
          <Small muted style={{ fontSize: 11.5, flex: 1 }}>
            Facilities marked with a shield have completed MedMesh onboarding verification. Unverified facilities are
            listed but flagged.
          </Small>
        </Row>

        {!user ? (
          <Card style={{ gap: space.md }}>
            <Stack gap="xs">
              <Title style={{ fontSize: 17 }}>Working in emergency response?</Title>
              <Small muted>
                Dispatchers, hospital bed-control desks, ambulance crews and district health officials sign in for the
                operational views — incident matching, bed holds, roster control and district analytics.
              </Small>
            </Stack>
            <Row gap="sm" wrap>
              <Button label="Staff sign in" icon="lock" variant="primary" onPress={() => router.push('/sign-in')} />
              <Button label="See the doctor directory" icon="users" onPress={() => router.push('/doctors')} />
            </Row>
          </Card>
        ) : null}
      </ScrollView>
    </AppShell>
  );
}
