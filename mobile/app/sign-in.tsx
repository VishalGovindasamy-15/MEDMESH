import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, Image } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api } from '../src/api/client';
import type { DemoAccountsPayload } from '../src/api/types';
import { useAuth, homeFor } from '../src/state/AuthProvider';
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
  Small,
  Stack,
  TextField,
  Title,
} from '../src/ui';
import { Icon } from '../src/ui/Icon';
import { useResponsive } from '../src/ui/useResponsive';

/**
 * Sign-in.
 *
 * Two things changed here after the workflow audit, and both matter more than
 * they look.
 *
 * First, the pilot accounts are no longer string literals in this file. They
 * were, which meant every build of the app — pilot, staging, production —
 * carried a working platform-administrator password inside its JavaScript
 * bundle, where anyone with the URL could read it. They now come from
 * `GET /auth/demo-accounts`, which answers with an empty list unless the server
 * has `MEDMESH_DEMO_MODE` on. The pilot turns it on; a deployment that forgets
 * to configure it shows an empty panel instead of an administrator's password,
 * which is the direction a default should fail in.
 *
 * Second, this screen only did two of the four things a sign-in screen has to
 * do: sign in, and nothing else. There was no way to create an account (the API
 * had supported it since the first release), no way to change a password, and no
 * way to recover one — so a user who forgot their password had no path through
 * the product at all. All three are here now.
 */

type Mode = 'sign-in' | 'sign-up' | 'forgot' | 'reset';

const ROLE_ICONS: Record<string, string> = {
  dispatcher: 'ambulance',
  hospital_admin: 'layers',
  driver: 'route',
  gov_official: 'activity',
  platform_admin: 'shield',
  citizen: 'search',
};

/** Mirror of the server's policy, so the hint appears before the 422 does. */
const MIN_PASSWORD_LENGTH = 12;

function passwordComplaint(raw: string): string | null {
  if (!raw) return null;
  if (raw.length < MIN_PASSWORD_LENGTH) {
    return `${MIN_PASSWORD_LENGTH - raw.length} more character${MIN_PASSWORD_LENGTH - raw.length === 1 ? '' : 's'} needed`;
  }
  if (new Set(raw).size < 5) return 'Use at least five distinct characters';
  return null;
}

export default function SignInScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { signIn, register, signingIn, error, user, clearError } = useAuth();
  const { isDesktop } = useResponsive();
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [confirm, setConfirm] = useState('');
  const [resetToken, setResetToken] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<DemoAccountsPayload | null>(null);
  
  const [showSettings, setShowSettings] = useState(false);
  const [customUrl, setCustomUrl] = useState(require('../src/api/client').BASE_URL);

  useEffect(() => {
    if (user) router.replace(homeFor(user.role) as any);
  }, [user, router]);

  // The credential panel is fetched, not compiled in. Fire and forget: if the
  // endpoint is unreachable the sign-in form still works, which is the point of
  // the form.
  useEffect(() => {
    let cancelled = false;
    api
      .get<DemoAccountsPayload>('/auth/demo-accounts', { timeoutMs: 6000 })
      .then((payload) => {
        if (!cancelled) setDemo(payload);
      })
      .catch(() => {
        if (!cancelled) setDemo({ demo_mode: false, environment: 'unknown', accounts: [], note: '' });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submitted = localError ?? error;

  function reset(next: Mode) {
    setMode(next);
    setLocalError(null);
    setNotice(null);
    clearError();
  }

  const submit = async (e?: string, p?: string) => {
    setLocalError(null);
    const ok = await signIn(e ?? email, p ?? password);
    if (ok) router.replace('/');
  };

  const createAccount = async () => {
    setLocalError(null);
    if (fullName.trim().length < 3) return setLocalError('Enter your name as you would like it recorded');
    if (!email.includes('@')) return setLocalError('Enter a valid email address');
    const weak = passwordComplaint(password);
    if (weak) return setLocalError(weak);
    if (password !== confirm) return setLocalError('The two passwords do not match');
    const ok = await register(email, password, fullName, phone);
    if (ok) router.replace('/');
  };

  const requestReset = async () => {
    setLocalError(null);
    setNotice(null);
    setBusy(true);
    try {
      const res = await api.post<{ message: string; dev_token?: string }>('/auth/password/forgot', {
        email: email.trim(),
      });
      setNotice(res.message);
      // The pilot has no mail transport, so the API can hand the token straight
      // back. When a real transport is configured this field is absent and the
      // screen simply waits for the user to paste the link they were sent.
      if (res.dev_token) {
        setResetToken(res.dev_token);
        setMode('reset');
      }
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'Could not start the reset');
    } finally {
      setBusy(false);
    }
  };

  const applyReset = async () => {
    setLocalError(null);
    const weak = passwordComplaint(password);
    if (weak) return setLocalError(weak);
    if (password !== confirm) return setLocalError('The two passwords do not match');
    setBusy(true);
    try {
      await api.post('/auth/password/reset', { token: resetToken.trim(), new_password: password });
      setNotice('Password set. Sign in with it now.');
      setPassword('');
      setConfirm('');
      setMode('sign-in');
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : 'That reset link did not work');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, backgroundColor: t.bg.app, paddingTop: insets.top }}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          padding: isDesktop ? space.xxxl : space.lg,
        }}
      >
        <View style={{ width: '100%', maxWidth: 880, gap: space.lg }}>
          <Row justify="space-between" align="center">
            <Pressable
              onPress={() => router.push('/')}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}
            >
              <Image source={require('../assets/logo.png')} style={{ width: 30, height: 30 }} resizeMode="contain" />
              <Body style={{ fontWeight: '600' }}>MedMesh</Body>
            </Pressable>
            <Row gap="sm">
              <Button label="API Settings" icon="settings" size="sm" variant="secondary" onPress={() => setShowSettings(!showSettings)} />
              <Button label="Public directory" icon="hospital" size="sm" onPress={() => router.push('/')} />
            </Row>
          </Row>

          {showSettings && (
            <Card style={{ gap: space.md, backgroundColor: t.bg.sunken }}>
              <Heading>API Settings</Heading>
              <TextField
                value={customUrl}
                onChangeText={setCustomUrl}
                label="Frontend Base URL"
              />
              <Row gap="sm">
                <Button label="Save" variant="primary" onPress={() => {
                  require('../src/api/client').setBaseUrl(customUrl);
                  setShowSettings(false);
                }} />
                <Button label="Reset to default" variant="secondary" onPress={() => {
                  require('../src/api/client').setBaseUrl(null);
                  setCustomUrl(require('../src/api/client').BASE_URL);
                }} />
              </Row>
            </Card>
          )}

          <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
            {/* Credentials ------------------------------------------------- */}
            <Card style={{ flex: 1, minWidth: 300, gap: space.md }}>
              <Stack gap="xxs">
                <Title>
                  {mode === 'sign-up'
                    ? 'Create a citizen account'
                    : mode === 'forgot'
                      ? 'Reset your password'
                      : mode === 'reset'
                        ? 'Choose a new password'
                        : 'Sign in'}
                </Title>
                <Small muted>
                  {mode === 'sign-up'
                    ? 'An account keeps your recent searches and lets you report capacity that looks wrong. Browsing needs no account.'
                    : mode === 'forgot' || mode === 'reset'
                      ? 'We will send a link to the address on the account. The link is valid for 30 minutes and can be used once.'
                      : 'For emergency dispatch, hospital bed control, ambulance crews and district health officials.'}
                </Small>
              </Stack>

              {submitted ? <Banner tone="critical" icon="alert" title="Not accepted" body={submitted} /> : null}
              {notice ? <Banner tone="live" icon="check" title="Done" body={notice} /> : null}

              {mode === 'sign-up' ? (
                <Stack gap="md">
                  <TextField
                    label="Full name"
                    value={fullName}
                    onChangeText={(v) => {
                      setFullName(v);
                      if (submitted) {
                        setLocalError(null);
                        clearError();
                      }
                    }}
                    placeholder="Your name"
                    icon="user"
                  />
                  <TextField
                    label="Email"
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.in"
                    icon="mail"
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <TextField
                    label="Mobile (optional)"
                    value={phone}
                    onChangeText={setPhone}
                    placeholder="+91 98••• •••••"
                    icon="phone"
                    keyboardType="phone-pad"
                  />
                  <TextField
                    label="Password"
                    value={password}
                    onChangeText={setPassword}
                    placeholder="••••••••••"
                    icon="lock"
                    secureTextEntry
                    autoCapitalize="none"
                    hint={`At least ${MIN_PASSWORD_LENGTH} characters. Length matters more than symbols — a phrase is fine.`}
                  />
                  <TextField
                    label="Confirm password"
                    value={confirm}
                    onChangeText={setConfirm}
                    placeholder="••••••••••"
                    icon="lock"
                    secureTextEntry
                    autoCapitalize="none"
                  />
                  <Button label="Create account" variant="primary" full loading={signingIn} onPress={createAccount} />
                  <Row gap="xs" align="center" justify="center">
                    <Small muted>Already have one?</Small>
                    <Pressable onPress={() => reset('sign-in')}>
                      <Small style={{ color: t.accent.base, fontWeight: '600' }}>Sign in</Small>
                    </Pressable>
                  </Row>
                </Stack>
              ) : mode === 'forgot' ? (
                <Stack gap="md">
                  <TextField
                    label="Work or personal email"
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.in"
                    icon="mail"
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <Button label="Send reset link" variant="primary" full loading={busy} onPress={requestReset} />
                  <Row gap="xs" align="center" justify="center">
                    <Small muted>Remembered it?</Small>
                    <Pressable onPress={() => reset('sign-in')}>
                      <Small style={{ color: t.accent.base, fontWeight: '600' }}>Back to sign in</Small>
                    </Pressable>
                  </Row>
                </Stack>
              ) : mode === 'reset' ? (
                <Stack gap="md">
                  <TextField
                    label="Reset token"
                    value={resetToken}
                    onChangeText={setResetToken}
                    placeholder="token from the link"
                    icon="key"
                    autoCapitalize="none"
                    hint="Pre-filled in this pilot build because no mail transport is configured."
                  />
                  <TextField
                    label="New password"
                    value={password}
                    onChangeText={setPassword}
                    placeholder="••••••••••"
                    icon="lock"
                    secureTextEntry
                    autoCapitalize="none"
                  />
                  <TextField
                    label="Confirm new password"
                    value={confirm}
                    onChangeText={setConfirm}
                    placeholder="••••••••••"
                    icon="lock"
                    secureTextEntry
                    autoCapitalize="none"
                  />
                  <Button label="Set password" variant="primary" full loading={busy} onPress={applyReset} />
                  <Row gap="xs" align="center" justify="center">
                    <Pressable onPress={() => reset('sign-in')}>
                      <Small style={{ color: t.accent.base, fontWeight: '600' }}>Back to sign in</Small>
                    </Pressable>
                  </Row>
                </Stack>
              ) : (
                <Stack gap="md">
                  <TextField
                    label="Work email"
                    value={email}
                    onChangeText={(v) => {
                      setEmail(v);
                      if (submitted) {
                        setLocalError(null);
                        clearError();
                      }
                    }}
                    placeholder="name@hospital.gov.in"
                    icon="user"
                    autoCapitalize="none"
                    keyboardType="email-address"
                  />
                  <TextField
                    label="Password"
                    value={password}
                    onChangeText={(v) => {
                      setPassword(v);
                      if (submitted) {
                        setLocalError(null);
                        clearError();
                      }
                    }}
                    placeholder="••••••••••"
                    icon="lock"
                    secureTextEntry
                    autoCapitalize="none"
                  />

                  <Button
                    label={signingIn ? 'Signing in…' : 'Sign in'}
                    variant="primary"
                    full
                    loading={signingIn}
                    onPress={() => submit()}
                  />

                  <Row justify="space-between" align="center">
                    <Pressable onPress={() => reset('forgot')}>
                      <Small style={{ color: t.accent.base, fontWeight: '600' }}>Forgot password?</Small>
                    </Pressable>
                    <Pressable onPress={() => reset('sign-up')}>
                      <Small style={{ color: t.accent.base, fontWeight: '600' }}>Create a citizen account</Small>
                    </Pressable>
                  </Row>

                  <Divider />

                  <Stack gap="xs">
                    <Label>Operational access is provisioned</Label>
                    <Small muted style={{ fontSize: 12 }}>
                      Dispatcher, hospital, crew and government accounts are created by a MedMesh administrator, so that
                      a hospital account can only ever touch its own facility's data. Citizens may self-register — the
                      public directory needs no account at all.
                    </Small>
                  </Stack>

                  <Row gap="xs" align="flex-start">
                    <Icon name="info" size={13} color={t.fg.faint} />
                    <Small muted style={{ fontSize: 11 }}>
                      Repeated failures are not rate limited in this pilot build. Staff accounts are marked for a
                      forced password change on first sign-in.
                    </Small>
                  </Row>
                </Stack>
              )}
            </Card>

            {/* Demo accounts ---------------------------------------------- */}
            <Card style={{ flex: 1, minWidth: 300, gap: space.md }}>
              <Stack gap="xxs">
                <Heading>Pilot accounts</Heading>
                <Small muted>
                  {demo?.demo_mode
                    ? 'One tap signs you in. These exist so a district officer can evaluate the operational surfaces without a provisioning round trip.'
                    : 'This deployment does not publish pilot credentials.'}
                </Small>
              </Stack>

              {demo?.demo_mode && demo.accounts.length ? (
                <Stack gap={0}>
                  {demo.accounts.map((acct, i) => (
                    <Pressable
                      key={acct.email}
                      onPress={() => submit(acct.email, acct.password)}
                      accessibilityRole="button"
                      style={({ pressed }) => ({
                        flexDirection: 'row',
                        alignItems: 'center',
                        gap: space.md,
                        paddingVertical: space.md,
                        borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                        borderTopColor: t.line.subtle,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <View
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: radius.md,
                          backgroundColor: t.accent.soft,
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <Icon name={ROLE_ICONS[acct.role] ?? 'user'} size={16} color={t.accent.base} />
                      </View>
                      <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                        <Body style={{ fontWeight: '600', fontSize: 13.5 }}>{acct.label}</Body>
                        <Small muted style={{ fontSize: 11.5 }} numberOfLines={2}>
                          {acct.description}
                        </Small>
                      </Stack>
                      <Icon name="chevronRight" size={16} color={t.fg.faint} />
                    </Pressable>
                  ))}
                </Stack>
              ) : (
                <Stack gap="sm">
                  <KeyValue label="Credentials">
                    <Small muted style={{ fontSize: 12 }}>
                      Not published by this server. Operational accounts are issued by a platform administrator.
                    </Small>
                  </KeyValue>
                  {demo && !demo.demo_mode ? (
                    <Row gap="xs" align="flex-start">
                      <Icon name="lock" size={13} color={t.fg.faint} />
                      <Small muted style={{ fontSize: 11 }}>
                        Set <Num size={11}>MEDMESH_DEMO_MODE=true</Num> to publish the seeded pilot sign-ins on a
                        development instance. Never enable it against real facility data.
                      </Small>
                    </Row>
                  ) : null}
                </Stack>
              )}

              <Banner
                tone="neutral"
                icon="shield"
                title="Every action is attributable"
                body="Capacity updates, dispatch decisions and verification changes are written to an append-only audit log with the actor's identity."
              />
            </Card>
          </Row>


        </View>
      </View>
    </ScrollView>
  );
}
