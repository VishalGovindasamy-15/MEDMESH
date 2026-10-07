import React from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View, Image } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Icon } from '../ui/Icon';
import { Banner, Body, Button, Card, Label, Row, Small, Stack, TextField, Title } from '../ui';
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
 *
 * It gained one more job in the audit: a staff account issued by an
 * administrator starts on a password that administrator chose, so the holder has
 * to replace it before doing anything with the account. The server flags that,
 * and this gate pins the user on the change screen for as long as the flag is
 * set — reading it from the server on every password change rather than
 * clearing it locally, so an administrator clearing it takes effect without
 * waiting for a new sign-in.
 */
export function SessionGate({ children }: { children: React.ReactNode }) {
  const { hydrating, user, mustChangePassword } = useAuth();

  if (hydrating) return <Splash />;
  if (user && mustChangePassword) return <ForcedPasswordChange />;
  return <>{children}</>;
}

/**
 * The first-login password change.
 *
 * Deliberately not dismissible and deliberately not a route: a screen you can
 * navigate away from is a screen that gets navigated away from, and the whole
 * reason the flag exists is that the current password is known to whoever issued
 * it. It is rendered here, by the gate, so that no route guard has to remember
 * to enforce it.
 */
function ForcedPasswordChange() {
  const { t } = useTheme();
  const { changePassword, signingIn, error, user, signOut, clearError } = useAuth();
  const [current, setCurrent] = React.useState('');
  const [next, setNext] = React.useState('');
  const [again, setAgain] = React.useState('');
  const [local, setLocal] = React.useState<string | null>(null);

  const complaint =
    next && next.length < 12
      ? `${12 - next.length} more character${12 - next.length === 1 ? '' : 's'} needed`
      : next && again && next !== again
        ? 'The two passwords do not match'
        : null;

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, backgroundColor: t.bg.app }}>
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.lg }}>
        <View style={{ width: '100%', maxWidth: 460, gap: space.md }}>
          <Row justify="space-between" align="center">
            <Row gap="sm" align="center">
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
              <Body style={{ fontWeight: '600' }}>MedMesh</Body>
            </Row>
            <Button label="Sign out" size="sm" onPress={() => void signOut()} />
          </Row>

          <Card style={{ gap: space.md }}>
            <Stack gap="xxs">
              <Title>Set your own password</Title>
              <Small muted>
                {user?.full_name} is still using the one-time password that was issued with the account, so it is known
                to at least one other person. Choose your own to continue.
              </Small>
            </Stack>

            {local || error ? (
              <Banner tone="critical" icon="alert" title="Not accepted" body={local ?? complaint ?? error ?? ''} />
            ) : null}

            <Stack gap="md">
              <TextField
                label="Current (issued) password"
                value={current}
                onChangeText={(v) => {
                  setCurrent(v);
                  setLocal(null);
                  if (error) clearError();
                }}
                icon="key"
                secureTextEntry
                autoCapitalize="none"
              />
              <TextField
                label="New password"
                value={next}
                onChangeText={(v) => {
                  setNext(v);
                  setLocal(null);
                }}
                icon="lock"
                secureTextEntry
                autoCapitalize="none"
                hint="At least 12 characters. A phrase you can remember beats a short scramble you cannot."
              />
              <TextField
                label="New password again"
                value={again}
                onChangeText={(v) => {
                  setAgain(v);
                  setLocal(null);
                }}
                icon="lock"
                secureTextEntry
                autoCapitalize="none"
              />
            </Stack>

            <Button
              label={signingIn ? 'Saving…' : 'Set password and continue'}
              variant="primary"
              full
              loading={signingIn}
              disabled={!current || !next || !again || !!complaint}
              onPress={async () => {
                if (complaint) return setLocal(complaint);
                const ok = await changePassword(current, next);
                if (!ok) setLocal(null);
              }}
            />

            <Row gap="xs" align="flex-start">
              <Icon name="info" size={13} color={t.fg.faint} />
              <Small muted style={{ fontSize: 11 }}>
                The published pilot passwords are on the server's list of known-bad credentials, so they cannot be
                chosen again — completing this step permanently stops the seeded value from working.
              </Small>
            </Row>
          </Card>
        </View>
      </View>
    </ScrollView>
  );
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
      <Image source={require('../../assets/logo.png')} style={{ width: 100, height: 100 }} resizeMode="contain" />


    </View>
  );
}
