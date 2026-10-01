import { usePathname, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Role, SessionUser } from '../api/types';
import { ageFromSeconds } from '../lib/format';
import { useAuth } from '../state/AuthProvider';
import { useLive } from '../state/LiveProvider';
import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Icon } from './Icon';
import { Body, Label, Num, Row, Small, Stack, Title } from './index';
import { useResponsive } from './useResponsive';

interface NavItem {
  href: string;
  label: string;
  icon: string;
  roles?: Role[];
  matchPrefix?: string;
}

/**
 * Navigation is a function of the session, not a fixed menu.
 *
 * `roles` is the client-side half of the access model: a dispatcher has no
 * business seeing a "My facility" tab, and clutter on a console that people
 * operate under pressure is not a neutral cost. The API enforces the same
 * rules independently — hiding a link is courtesy, not security.
 */
const NAV: NavItem[] = [
  { href: '/', label: 'Directory', icon: 'hospital', matchPrefix: '/facility' },
  { href: '/doctors', label: 'Doctors', icon: 'users' },
  { href: '/console', label: 'Dispatch', icon: 'ambulance', roles: ['dispatcher', 'platform_admin'] },
  { href: '/dashboard', label: 'My facility', icon: 'layers', roles: ['hospital_admin', 'platform_admin'] },
  { href: '/inbox', label: 'Inbox', icon: 'bell', roles: ['dispatcher', 'hospital_admin', 'platform_admin', 'gov_official', 'driver'] },
  { href: '/crew', label: 'Crew', icon: 'route', roles: ['driver', 'platform_admin'] },
  { href: '/analytics', label: 'Analytics', icon: 'activity', roles: ['gov_official', 'platform_admin'] },
  { href: '/admin', label: 'Operations', icon: 'server', roles: ['platform_admin'] },
];

export function AppShell({
  title,
  subtitle,
  actions,
  children,
  maxWidth = 1280,
  scroll = true,
  footerNote,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  maxWidth?: number;
  scroll?: boolean;
  footerNote?: string;
}) {
  const { t, mode, toggle } = useTheme();
  const { user, signOut } = useAuth();
  const { connected, degraded, lastEventAt } = useLive();
  const { isDesktop, gutter, width } = useResponsive();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const pathname = usePathname();

  // The phone bottom bar is fixed, so the scroll content has to leave room for
  // it or the last line of every screen sits permanently behind it. Its height
  // depends on the nav labels and the safe-area inset, so it is measured rather
  // than assumed -- a hard-coded padding silently clips content the first time
  // a label wraps or a device reports a taller home indicator.
  const [barHeight, setBarHeight] = useState(0);

  const items = NAV.filter((item) => !item.roles || (user && item.roles.includes(user.role)));

  const isActive = (item: NavItem) => {
    if (item.href === '/') return pathname === '/' || pathname.startsWith('/facility');
    if (item.href === '/admin') return pathname.startsWith('/admin');
    return pathname === item.href || pathname.startsWith(`${item.href}/`);
  };

  const connectionTone = !connected ? 'stale' : degraded ? 'warm' : 'live';
  const connectionLabel = !connected ? 'Offline' : degraded ? 'Stalled' : 'Live';

  const body = (
    <View style={{ flex: 1, minHeight: 0, alignItems: 'center' }}>
      <View
        style={{
          flex: 1,
          minHeight: 0,
          width: '100%',
          maxWidth,
          paddingHorizontal: gutter,
          paddingTop: space.lg,
          gap: space.lg,
          paddingBottom: isDesktop ? space.xxxl : barHeight + space.lg + insets.bottom,
        }}
      >
        <DemoStrip />
        <PageHeader
          title={title}
          subtitle={subtitle}
          actions={actions}
          connectionTone={connectionTone}
          connectionLabel={connectionLabel}
          lastEventAt={lastEventAt}
          showThemeToggle
          onToggleTheme={toggle}
          themeMode={mode}
        />
        {children}
        {footerNote ? (
          <View style={{ paddingTop: space.sm }}>
            <Small muted style={{ fontSize: 11.5 }}>{footerNote}</Small>
          </View>
        ) : null}
      </View>
    </View>
  );

  if (!isDesktop) {
    return (
      <View style={{ flex: 1, minHeight: 0, backgroundColor: t.bg.app }}>
        {/* minHeight: 0 is load-bearing on web. A flex item defaults to
            min-height: auto, so without it the ScrollView refuses to shrink
            below its content, the document outgrows the viewport, and the whole
            page scrolls -- which carries the bottom nav off the top of the
            screen and leaves the app with no visible navigation. With it, the
            ScrollView owns the overflow and the bar stays pinned. */}
        <View style={{ flex: 1, minHeight: 0 }}>
          {scroll ? (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
              {body}
            </ScrollView>
          ) : (
            /* Every screen supplies its own ScrollView, so the shell only has
               to hand it a bounded box. Wrapping it in a second scroller would
               nest scroll containers and fight over the wheel. */
            <View style={{ flex: 1, minHeight: 0 }}>{body}</View>
          )}
        </View>
        <BottomBar
          items={items}
          isActive={isActive}
          onPress={(href) => router.push(href as any)}
          onMeasure={setBarHeight}
          user={user}
          onSignOut={signOut}
        />
        <View style={{ height: insets.bottom, backgroundColor: t.bg.surface }} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, flexDirection: 'row', backgroundColor: t.bg.app }}>
      <SideRail
        items={items}
        isActive={isActive}
        onPress={(href) => router.push(href as any)}
        user={user}
        onSignOut={signOut}
        connection={{ tone: connectionTone, label: connectionLabel }}
        dataAge={lastEventAt ? Math.max(0, Math.floor((Date.now() - lastEventAt) / 1000)) : null}
      />
      <View style={{ flex: 1, borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: t.line.base }}>
        {scroll ? <ScrollView contentContainerStyle={{ flexGrow: 1 }}>{body}</ScrollView> : body}
      </View>
    </View>
  );
}

/* ------------------------------------------------------------------ header */

export function PageHeader({
  title,
  subtitle,
  actions,
  connectionTone,
  connectionLabel,
  lastEventAt,
  showThemeToggle,
  onToggleTheme,
  themeMode,
  compact,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  connectionTone: 'live' | 'warm' | 'stale';
  connectionLabel: string;
  lastEventAt: number | null;
  showThemeToggle?: boolean;
  onToggleTheme?: () => void;
  themeMode?: 'light' | 'dark';
  compact?: boolean;
}) {
  const { t } = useTheme();
  const { isPhone } = useResponsive();
  const age = lastEventAt ? Math.floor((Date.now() - lastEventAt) / 1000) : null;

  return (
    <View style={{ gap: space.md }}>
      <Row align="flex-start" justify="space-between" gap="md" style={{ flexWrap: 'wrap' }}>
        <View style={{ flexShrink: 1, minWidth: 180 }}>
          {/* #53: two facts, two dots, two labels. "Live" on its own described
              only the socket — the transport that carries capacity events — and
              said nothing about how old the newest event was. A reader who saw
              a green LIVE next to a nine-hour-old figure had been told the
              opposite of the truth. */}
          <Row gap="md" align="center" wrap>
            <Row gap="xs" align="center">
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: t.status[connectionTone].base,
                }}
              />
              <Label tone={t.status[connectionTone].base}>Connection {connectionLabel}</Label>
            </Row>
            <Row gap="xs" align="center">
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor:
                    age === null ? t.fg.faint : age > 900 ? t.status.stale.base : age > 240 ? t.status.warm.base : t.status.live.base,
                }}
              />
              <Label
                tone={
                  age === null ? t.fg.muted : age > 900 ? t.status.stale.base : age > 240 ? t.status.warm.base : t.status.live.base
                }
              >
                Facility data {age === null ? 'awaiting first event' : age < 5 ? 'current' : `${ageFromSeconds(age)} old`}
              </Label>
            </Row>
          </Row>
          <View style={{ marginTop: 3 }}>
            <Title style={{ fontSize: compact ? 18 : 22, letterSpacing: -0.4 }}>{title}</Title>
            {subtitle ? (
              <Small muted style={{ marginTop: 1 }}>
                {subtitle}
              </Small>
            ) : null}
          </View>
        </View>

        <Row gap="sm" align="center">
          {actions}
          {showThemeToggle ? (
            <Pressable
              onPress={onToggleTheme}
              accessibilityLabel="Toggle colour scheme"
              hitSlop={6}
              style={{
                width: 32,
                height: 32,
                borderRadius: radius.md,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.line.base,
                backgroundColor: t.bg.surface,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={15} color={t.fg.muted} />
            </Pressable>
          ) : null}
        </Row>
      </Row>
      {!isPhone ? null : null}
    </View>
  );
}

/**
 * A one-line label for synthetic data (#54).
 *
 * The pilot dataset is generated: bed counts come from the simulator's ingest
 * loop, not from a hospital. Nothing in the numbers says so, so a reader who
 * lands on the directory has no way to know the figures are demonstration data
 * — and "4,459 ICU beds free in Tamil Nadu" is exactly the kind of sentence that
 * gets quoted out of context. The flag comes from the unauthenticated status
 * endpoint so it shows before sign-in as well as after, and it is a strip rather
 * than a modal because it has to be visible without ever being in the way.
 */
function DemoStrip() {
  const { t } = useTheme();
  const [demo, setDemo] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/v1/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => !cancelled && body && setDemo(Boolean(body.demo_mode)))
      .catch(() => !cancelled && setDemo(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!demo) return null;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: space.md,
        paddingVertical: 6,
        borderRadius: radius.md,
        backgroundColor: t.status.warm.soft,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.status.warm.base,
      }}
      accessibilityRole="summary"
    >
      <Icon name="alert" size={13} color={t.status.warm.base} />
      <Small style={{ fontSize: 11.5, color: t.status.warm.base, fontWeight: '600' }}>
        Pilot dataset
      </Small>
      <Small muted style={{ fontSize: 11.5, flexShrink: 1 }}>
        Facility figures on this deployment are simulated for demonstration. No record here describes a real
        patient or a real hospital's live capacity.
      </Small>
    </View>
  );
}

/* --------------------------------------------------------------- side rail */

function SideRail({
  items,
  isActive,
  onPress,
  user,
  onSignOut,
  connection,
  dataAge,
}: {
  items: NavItem[];
  isActive: (i: NavItem) => boolean;
  onPress: (href: string) => void;
  user: any;
  onSignOut: () => void;
  connection: { tone: 'live' | 'warm' | 'stale'; label: string };
  /** Seconds since the newest capacity figure the socket carried. */
  dataAge: number | null;
}) {
  const { t } = useTheme();

  return (
    <View
      style={{
        width: 232,
        backgroundColor: t.bg.surface,
        paddingVertical: space.lg,
        paddingHorizontal: space.md,
        justifyContent: 'space-between',
      }}
    >
      <Stack gap="xl">
        <Row gap="sm" align="center" style={{ paddingHorizontal: 6 }}>
          <BrandGlyph />
          <View>
            <Body style={{ fontWeight: '600', letterSpacing: -0.2 }}>MedMesh</Body>
            <Label style={{ marginTop: -2 }}>Capacity exchange</Label>
          </View>
        </Row>

        <Stack gap="xxs">
          {items.map((item) => {
            const active = isActive(item);
            return (
              <Pressable
                key={item.href}
                onPress={() => onPress(item.href)}
                accessibilityRole="link"
                accessibilityState={{ selected: active }}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 10,
                  paddingVertical: 9,
                  paddingHorizontal: 9,
                  borderRadius: radius.md,
                  backgroundColor: active ? t.accent.soft : pressed ? t.bg.sunken : 'transparent',
                })}
              >
                <Icon name={item.icon} size={16} color={active ? t.accent.base : t.fg.muted} strokeWidth={1.85} />
                <Body style={{ fontWeight: active ? '600' : '500', color: active ? t.accent.base : t.fg.base }}>
                  {item.label}
                </Body>
              </Pressable>
            );
          })}
        </Stack>

        <View
          style={{
            padding: space.md,
            borderRadius: radius.md,
            backgroundColor: t.bg.sunken,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.line.subtle,
            gap: 6,
          }}
        >
          <Row gap="xs" align="center">
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.status[connection.tone].base }} />
            <Label tone={t.status[connection.tone].base}>Connection {connection.label}</Label>
          </Row>
          {/* #53: "feed live" used to describe only the socket. A green dot next
              to a directory whose newest figure is from this morning is a lie
              told in good faith: the transport is fine and the data is not. The
              two facts get two lines, so a reader can tell them apart without
              opening a facility. */}
          <Row gap="xs" align="center" style={{ marginTop: 2 }}>
            <View
              style={{
                width: 6,
                height: 6,
                borderRadius: 3,
                backgroundColor:
                  dataAge === null
                    ? t.fg.faint
                    : dataAge > 900
                      ? t.status.stale.base
                      : dataAge > 240
                        ? t.status.warm.base
                        : t.status.live.base,
              }}
            />
            <Label
              tone={
                dataAge === null
                  ? t.fg.muted
                  : dataAge > 900
                    ? t.status.stale.base
                    : dataAge > 240
                      ? t.status.warm.base
                      : t.status.live.base
              }
            >
              Facility data {dataAge === null ? 'awaiting first event' : dataAge < 5 ? 'current' : `${ageFromSeconds(dataAge)} old`}
            </Label>
          </Row>
          <Small muted style={{ fontSize: 11.5 }}>
            Connection is the socket; facility data is the age of the newest capacity figure it carried. They can
            disagree, and when they do the second line is the one to believe.
          </Small>
        </View>
      </Stack>

      <Stack gap="xs">
        {user ? (
          <Pressable
            onPress={() => onPress('/account')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              padding: 8,
              borderRadius: radius.md,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <View
              style={{
                width: 28,
                height: 28,
                borderRadius: 14,
                backgroundColor: t.accent.soft,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Num size={11} color={t.accent.base}>
                {String(user.full_name ?? '')
                  .split(' ')
                  .slice(0, 2)
                  .map((p: string) => p[0])
                  .join('')}
              </Num>
            </View>
            <View style={{ flex: 1 }}>
              <Small style={{ fontWeight: '600', fontSize: 12.5 }} numberOfLines={1}>
                {user.full_name}
              </Small>
              <Label style={{ marginTop: -1 }}>{String(user.role).replace(/_/g, ' ')}</Label>
            </View>
          </Pressable>
        ) : null}
        <Row gap="xxs">
          <Pressable
            onPress={user ? onSignOut : () => onPress('/sign-in')}
            style={({ pressed }) => ({
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              paddingVertical: 8,
              paddingHorizontal: 9,
              borderRadius: radius.md,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name={user ? 'logout' : 'lock'} size={15} color={t.fg.muted} />
            <Small muted style={{ fontWeight: '500' }}>
              {user ? 'Sign out' : 'Staff sign in'}
            </Small>
          </Pressable>
        </Row>
      </Stack>
    </View>
  );
}

/* -------------------------------------------------------------- bottom bar */

/**
 * The phone's primary navigation, capped at five destinations plus More.
 *
 * The cap is real -- six icons at 390px are unreadable and untappable -- but it
 * used to be applied by simply discarding the remainder: `items.slice(0, 5)`.
 * A platform administrator has eight surfaces, so Operations and Analytics were
 * dropped from the bar entirely and the Account page was never in it, which left
 * three screens with no way in on a phone at all. Nobody noticed because the
 * desktop rail shows everything and the phone was only ever checked as a ward.
 *
 * The fix is not eight tiny buttons. The first four destinations stay on the bar,
 * everything else collects behind More, and the sheet is bounded so it can grow
 * with the product without the bar growing with it. The bar also picks up an
 * unread badge, because the count is the reason to open the sheet.
 */
function BottomBar({
  items,
  isActive,
  onPress,
  onMeasure,
  user,
  onSignOut,
}: {
  items: NavItem[];
  isActive: (i: NavItem) => boolean;
  onPress: (href: string) => void;
  onMeasure: (height: number) => void;
  user: SessionUser | null;
  onSignOut: () => void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { unread } = useLive();
  const [moreOpen, setMoreOpen] = useState(false);

  // Four on the bar when there is a fifth slot for More; five when there is not
  // enough behind it to justify a sheet.
  const barCount = items.length > 5 ? 4 : items.length;
  const primary = items.slice(0, barCount);
  const overflow = items.slice(barCount);

  const go = (href: string) => {
    setMoreOpen(false);
    onPress(href);
  };

  return (
    <View
      onLayout={(e) => onMeasure(e.nativeEvent.layout.height)}
      style={{
        flexDirection: 'row',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: t.line.base,
        backgroundColor: t.bg.surface,
        paddingBottom: Platform.OS === 'ios' ? 0 : 2,
      }}
    >
      {moreOpen && overflow.length ? (
        <MoreSheet
          items={overflow}
          isActive={isActive}
          onPress={go}
          onClose={() => setMoreOpen(false)}
          user={user}
          onSignOut={onSignOut}
        />
      ) : null}

      {primary.map((item) => {
        const active = isActive(item);
        return (
          <Pressable
            key={item.href}
            onPress={() => onPress(item.href)}
            accessibilityRole="link"
            accessibilityState={{ selected: active }}
            style={({ pressed }) => ({
              flex: 1,
              alignItems: 'center',
              gap: 3,
              paddingVertical: 9,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <View>
              <Icon name={item.icon} size={19} color={active ? t.accent.base : t.fg.faint} strokeWidth={1.85} />
              {item.href === '/inbox' && unread > 0 ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -3,
                    right: -7,
                    minWidth: 15,
                    height: 15,
                    paddingHorizontal: 3,
                    borderRadius: 8,
                    backgroundColor: t.status.critical.base,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Num size={9} weight="700" color="#fff">
                    {unread > 9 ? '9+' : unread}
                  </Num>
                </View>
              ) : null}
            </View>
            <Label tone={active ? t.accent.base : t.fg.faint} style={{ fontSize: 9.5, letterSpacing: 0.4 }}>
              {item.label}
            </Label>
          </Pressable>
        );
      })}

      {overflow.length ? (
        <Pressable
          onPress={() => setMoreOpen(true)}
          accessibilityRole="button"
          accessibilityState={{ expanded: moreOpen }}
          style={({ pressed }) => ({
            flex: 1,
            alignItems: 'center',
            gap: 3,
            paddingVertical: 9,
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <Icon
            name="more"
            size={19}
            color={overflow.some(isActive) ? t.accent.base : t.fg.faint}
            strokeWidth={1.85}
          />
          <Label tone={overflow.some(isActive) ? t.accent.base : t.fg.faint} style={{ fontSize: 9.5, letterSpacing: 0.4 }}>
            More
          </Label>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * Everything the bar could not hold, plus the two things that belong to the
 * session rather than to a route: who is signed in, and the way out.
 *
 * Account had no entry point on a phone at all -- it was reachable on desktop by
 * clicking the profile block at the foot of the rail, and by nothing on a
 * handset, so a ward nurse could not change their own password from the device
 * they actually use.
 */
function MoreSheet({
  items,
  isActive,
  onPress,
  onClose,
  user,
  onSignOut,
}: {
  items: NavItem[];
  isActive: (i: NavItem) => boolean;
  onPress: (href: string) => void;
  onClose: () => void;
  user: SessionUser | null;
  onSignOut: () => void;
}) {
  const { t } = useTheme();
  return (
    <View
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: '100%',
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: t.line.base,
        backgroundColor: t.bg.surface,
        paddingVertical: space.xs,
      }}
    >
      {items.map((item) => {
        const active = isActive(item);
        return (
          <Pressable
            key={item.href}
            onPress={() => onPress(item.href)}
            accessibilityRole="link"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: space.md,
              paddingHorizontal: space.lg,
              paddingVertical: 13,
              backgroundColor: active ? t.accent.soft : 'transparent',
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Icon name={item.icon} size={18} color={active ? t.accent.base : t.fg.muted} />
            <Body style={{ flex: 1, fontSize: 14, fontWeight: active ? '600' : '500' }}>{item.label}</Body>
            <Icon name="chevronRight" size={15} color={t.fg.faint} />
          </Pressable>
        );
      })}

      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line.subtle, marginVertical: space.xs }} />

      <Pressable
        onPress={() => onPress('/account')}
        accessibilityRole="link"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingVertical: 13,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name="user" size={18} color={t.fg.muted} />
        <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
          <Body style={{ fontSize: 14, fontWeight: '500' }}>Account</Body>
          {user ? (
            <Small muted style={{ fontSize: 11.5 }} numberOfLines={1}>
              {user.full_name} · {user.role.replace(/_/g, ' ')}
            </Small>
          ) : null}
        </Stack>
        <Icon name="chevronRight" size={15} color={t.fg.faint} />
      </Pressable>

      <Pressable
        onPress={onSignOut}
        accessibilityRole="button"
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingHorizontal: space.lg,
          paddingVertical: 13,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Icon name="logout" size={18} color={t.fg.muted} />
        <Body style={{ fontSize: 14, fontWeight: '500' }}>Sign out</Body>
      </Pressable>

      <Pressable
        onPress={onClose}
        accessibilityRole="button"
        style={({ pressed }) => ({
          alignItems: 'center',
          paddingVertical: 12,
          marginTop: 2,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: t.line.subtle,
          opacity: pressed ? 0.7 : 1,
        })}
      >
        <Small muted style={{ fontSize: 12 }}>
          Close
        </Small>
      </Pressable>
    </View>
  );
}

function BrandGlyph() {
  const { t } = useTheme();
  return (
    <View
      style={{
        width: 30,
        height: 30,
        borderRadius: radius.md,
        backgroundColor: t.accent.base,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name="pulse" size={17} color={t.accent.on} strokeWidth={2.2} />
    </View>
  );
}
