import { usePathname, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Role } from '../api/types';
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
          <Row gap="sm" align="center">
            {lastEventAt !== null ? (
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: t.status[connectionTone].base,
                }}
              />
            ) : null}
            <Label tone={t.status[connectionTone].base}>
              {connectionLabel}
              {age !== null && age > 4 ? ` · ${age}s` : ''}
            </Label>
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

/* --------------------------------------------------------------- side rail */

function SideRail({
  items,
  isActive,
  onPress,
  user,
  onSignOut,
  connection,
}: {
  items: NavItem[];
  isActive: (i: NavItem) => boolean;
  onPress: (href: string) => void;
  user: any;
  onSignOut: () => void;
  connection: { tone: 'live' | 'warm' | 'stale'; label: string };
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
            <Label tone={t.status[connection.tone].base}>Feed {connection.label}</Label>
          </Row>
          <Small muted style={{ fontSize: 11.5 }}>
            Capacity updates stream in from connector-integrated facilities. Manual facilities refresh on staff
            update.
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

function BottomBar({
  items,
  isActive,
  onPress,
  onMeasure,
}: {
  items: NavItem[];
  isActive: (i: NavItem) => boolean;
  onPress: (href: string) => void;
  onMeasure: (height: number) => void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
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
      {items.slice(0, 5).map((item) => {
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
            <Icon name={item.icon} size={19} color={active ? t.accent.base : t.fg.faint} strokeWidth={1.85} />
            <Label tone={active ? t.accent.base : t.fg.faint} style={{ fontSize: 9.5, letterSpacing: 0.4 }}>
              {item.label}
            </Label>
          </Pressable>
        );
      })}
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
