import { useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

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
 * The demo-account list is not a scaffold to be removed — for a pilot that has
 * not been deployed to real staff yet, it is the fastest way for a district
 * officer to see what their dashboard actually does. One tap fills the form and
 * signs in; nothing is hidden behind a README.
 */
const DEMO_ACCOUNTS = [
  {
    role: 'Dispatcher',
    email: 'dispatch@medmesh.in',
    password: 'Dispatch@108',
    description: '108 console · incident intake, matching, bed holds',
    icon: 'ambulance',
  },
  {
    role: 'Hospital bed control',
    email: 'admin@srmc.medmesh.in',
    password: 'Hospital@2026',
    description: 'Sri Ranga Medical College Hospital · capacity & roster',
    icon: 'layers',
  },
  {
    role: 'Ambulance crew',
    email: 'crew@medmesh.in',
    password: 'Crew@108',
    description: 'Crew app · assignment, route, handover',
    icon: 'route',
  },
  {
    role: 'District health officer',
    email: 'gov@medmesh.in',
    password: 'District@2026',
    description: 'Coimbatore district analytics & surge control',
    icon: 'activity',
  },
  {
    role: 'Platform administrator',
    email: 'admin@medmesh.in',
    password: 'MedMesh@2026',
    description: 'Onboarding, verification, audit trail, SLA',
    icon: 'shield',
  },
];

export default function SignInScreen() {
  const { t } = useTheme();
  const router = useRouter();
  const { signIn, signingIn, error, user, clearError } = useAuth();
  const { isDesktop } = useResponsive();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (user) router.replace(homeFor(user.role) as any);
  }, [user, router]);

  const submit = async (e?: string, p?: string) => {
    const ok = await signIn(e ?? email, p ?? password);
    if (ok) router.replace('/');
  };

  return (
    <ScrollView contentContainerStyle={{ flexGrow: 1, backgroundColor: t.bg.app }}>
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
            </Pressable>
            <Button label="Public directory" icon="hospital" size="sm" onPress={() => router.push('/')} />
          </Row>

          <Row gap="lg" align="flex-start" style={{ flexWrap: 'wrap' }}>
            {/* Credentials ------------------------------------------------- */}
            <Card style={{ flex: 1, minWidth: 300, gap: space.md }}>
              <Stack gap="xxs">
                <Title>Staff sign in</Title>
                <Small muted>
                  For emergency dispatch, hospital bed control, ambulance crews and district health officials.
                </Small>
              </Stack>

              {error ? <Banner tone="critical" icon="alert" title="Sign-in failed" body={error} /> : null}

              <Stack gap="md">
                <TextField
                  label="Work email"
                  value={email}
                  onChangeText={(v) => {
                    setEmail(v);
                    if (error) clearError();
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
                    if (error) clearError();
                  }}
                  placeholder="••••••••••"
                  icon="lock"
                  secureTextEntry
                  autoCapitalize="none"
                />
              </Stack>

              <Button
                label={signingIn ? 'Signing in…' : 'Sign in'}
                variant="primary"
                full
                loading={signingIn}
                onPress={() => submit()}
              />

              <Divider />

              <Stack gap="xs">
                <Label>Access is provisioned, not self-service</Label>
                <Small muted style={{ fontSize: 12 }}>
                  Operational roles are created by a MedMesh administrator so that a hospital account can only ever
                  touch its own facility's data. Citizens do not need an account at all.
                </Small>
              </Stack>

              <Row gap="xs" align="flex-start">
                <Icon name="info" size={13} color={t.fg.faint} />
                <Small muted style={{ fontSize: 11 }}>
                  Accounts are locked after repeated failures by the API gateway in production. This pilot build has no
                  rate limiting.
                </Small>
              </Row>
            </Card>

            {/* Demo accounts ---------------------------------------------- */}
            <Card style={{ flex: 1, minWidth: 300, gap: space.md }}>
              <Stack gap="xxs">
                <Heading>Pilot accounts</Heading>
                <Small muted>
                  One tap signs you in. These exist so a district officer can evaluate the operational surfaces without
                  a provisioning round trip.
                </Small>
              </Stack>

              <Stack gap={0}>
                {DEMO_ACCOUNTS.map((acct, i) => (
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
                      <Icon name={acct.icon} size={16} color={t.accent.base} />
                    </View>
                    <Stack gap="xxs" style={{ flex: 1, minWidth: 0 }}>
                      <Body style={{ fontWeight: '600', fontSize: 13.5 }}>{acct.role}</Body>
                      <Small muted style={{ fontSize: 11.5 }} numberOfLines={2}>
                        {acct.description}
                      </Small>
                    </Stack>
                    <Icon name="chevronRight" size={16} color={t.fg.faint} />
                  </Pressable>
                ))}
              </Stack>

              <Banner
                tone="neutral"
                icon="shield"
                title="Every action is attributable"
                body="Capacity updates, dispatch decisions and verification changes are written to an append-only audit log with the actor's identity."
              />
            </Card>
          </Row>

          <Row gap="sm" align="center" justify="center" style={{ paddingTop: space.sm }}>
            <Pill label="pilot build" tone="warm" compact />
            <Num size={11} color={t.fg.faint} weight="500">
              v1.0.0
            </Num>
            <Small muted style={{ fontSize: 11 }}>
              Synthetic data — no real facility figures
            </Small>
          </Row>
        </View>
      </View>
    </ScrollView>
  );
}
