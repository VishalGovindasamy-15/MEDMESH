import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AuthProvider } from '../src/state/AuthProvider';
import { LiveProvider } from '../src/state/LiveProvider';
import { SessionGate } from '../src/state/SessionGate';
import { ThemeProvider, useTheme } from '../src/theme/ThemeProvider';

/**
 * On web the browser is the outermost container, and its default behaviour --
 * grow the document, scroll the window -- is wrong for an app shell: the phone
 * bottom bar scrolls off the top of the screen and the navigation disappears.
 * Pinning the html/body/#root box to the viewport makes the inner ScrollViews
 * the only scrollers, which is what the native layout already assumes. React
 * Native ignores this entirely.
 */
const ROOT_CSS_ID = 'medmesh-shell-css';

function usePinnedRootOnWeb() {
  React.useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    if (document.getElementById(ROOT_CSS_ID)) return;
    const style = document.createElement('style');
    style.id = ROOT_CSS_ID;
    style.textContent = 'html,body,#root{height:100%;overflow:hidden;}';
    document.head.appendChild(style);
  }, []);
}

/**
 * Root layout.
 *
 * Provider order is load-bearing: the theme is outermost because every component
 * below reads tokens while rendering; then auth; then `SessionGate`, which holds
 * the tree until the stored session has been resolved; then the live feed, which
 * authenticates its WebSocket with that session.
 */
export default function RootLayout() {
  usePinnedRootOnWeb();
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <AuthProvider>
          <SessionGate>
            <LiveProvider>
              <Chrome />
            </LiveProvider>
          </SessionGate>
        </AuthProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}

function Chrome() {
  const { t } = useTheme();
  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: t.bg.app }}>
      <StatusBar style={t.mode === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.bg.app },
          animation: 'fade',
        }}
      />
    </View>
  );
}
