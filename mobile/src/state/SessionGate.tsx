import React from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Label, Small } from '../ui';
import { useAuth } from './AuthProvider';

/**
 * Session gate.
 *
 * Nothing below this component mounts until the stored session has been read and
 * verified. That is not cosmetic — without it every authenticated screen fires
 * its first data request while `token` is still null, gets a 401, and renders an
 * error state on a perfectly valid session. Gating here fixes the whole class of
 * bug in one place instead of asking every screen to remember to wait, which is
 * exactly the kind of instruction that gets forgotten on screen number nine.
 *
 * The gate is also where the WebSocket provider lives, so the socket connects
 * once, already authenticated, rather than connecting anonymously and
 * reconnecting when the session resolves.
 */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const { hydrating } = useAuth();
  if (hydrating) return <Splash />;
  return <>{children}</>;
}

function Splash() {
  const { t } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: t.bg.app,
        gap: space.md,
      }}
    >
      <View
        style={{
          width: 44,
          height: 44,
          borderRadius: radius.lg,
          backgroundColor: t.accent.base,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Icon name="pulse" size={24} color={t.accent.on} strokeWidth={2.2} />
      </View>
      <View style={{ alignItems: 'center', gap: 3 }}>
        <Label style={{ letterSpacing: 1.4 }}>MEDMESH</Label>
        <Small muted style={{ fontSize: 11.5 }}>
          Restoring session…
        </Small>
      </View>
      <ActivityIndicator color={t.fg.faint} />
    </View>
  );
}
