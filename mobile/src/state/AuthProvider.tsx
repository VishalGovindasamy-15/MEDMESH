import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError, bindAuth } from '../api/client';
import type { Role, SessionUser } from '../api/types';

/**
 * Session state.
 *
 * The token lives in AsyncStorage, not SecureStore, and that is a conscious
 * pilot-stage decision with a cost: on a rooted device the token is readable.
 * Production moves this to SecureStore/Keychain and shortens the access-token
 * TTL — noted here rather than silently shipped, because "we will fix auth
 * later" is exactly the kind of note that never gets written down.
 *
 * Two things this provider is responsible for that are easy to get wrong:
 *
 *  - **Renewal.** The access token lasts twelve hours, the refresh token two
 *    weeks, and the refresh token used to be consulted exactly once, at boot.
 *    So a shift that ran past the access-token lifetime ended with every screen
 *    reporting "Not authenticated" and no way back except signing out and
 *    losing whatever was half-entered. Renewal now happens inside the API
 *    client, transparently, on the first 401 of any request; this provider
 *    supplies the two callbacks and decides what a failed renewal means.
 *
 *  - **The one-time password.** A staff account is minted by an administrator,
 *    who therefore knows its first password. `mustChangePassword` is the flag
 *    that makes replacing it mandatory rather than advisory, and the shell
 *    pins the user on the change screen until the server says it is cleared —
 *    the server, not local state, because an administrator clearing the flag
 *    has to take effect without waiting for a fresh sign-in.
 */

const ACCESS_KEY = 'medmesh.token';
const REFRESH_KEY = 'medmesh.refresh';
const USER_KEY = 'medmesh.user';

// One definition, in the API types where the payload it describes lives. This
// used to be declared a second time here, which is the kind of duplication that
// is harmless until somebody adds a field to one of them.
export type { DemoAccount } from '../api/types';

interface AuthValue {
  user: SessionUser | null;
  token: string | null;
  hydrating: boolean;
  signingIn: boolean;
  error: string | null;
  /** True when the server says the holder is still on a one-time password. */
  mustChangePassword: boolean;
  /** Set when a renewal failed and the user was signed out against their will. */
  sessionEnded: boolean;
  signIn: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, fullName: string, phone?: string) => Promise<boolean>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
  clearSessionEnded: () => void;
  /** Convenience predicate — screens ask "can this person dispatch?" a lot. */
  can: (...roles: Role[]) => boolean;
}

const AuthContext = createContext<AuthValue>({} as AuthValue);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);

  // Refs mirror the state so the API client's callbacks can read the *current*
  // values. A closure over the state variable would capture whatever it was
  // when the bridge was registered, which is nothing on first render.
  const tokenRef = useRef<string | null>(null);
  const refreshRef = useRef<string | null>(null);
  const refreshing = useRef<Promise<string | null> | null>(null);

  const persist = useCallback(async (access: string, refresh: string, nextUser: SessionUser) => {
    tokenRef.current = access;
    refreshRef.current = refresh;
    setToken(access);
    setRefreshToken(refresh);
    setUser(nextUser);
    await AsyncStorage.multiSet([
      [ACCESS_KEY, access],
      [REFRESH_KEY, refresh],
      [USER_KEY, JSON.stringify(nextUser)],
    ]);
  }, []);

  const clearSession = useCallback(async () => {
    tokenRef.current = null;
    refreshRef.current = null;
    setToken(null);
    setRefreshToken(null);
    setUser(null);
    await AsyncStorage.multiRemove([ACCESS_KEY, USER_KEY, REFRESH_KEY]);
  }, []);

  /**
   * Exchange the refresh token for a new pair.
   *
   * Concurrent callers share one in-flight renewal. A dashboard fires four or
   * five requests at once, so an expired access token produces four or five
   * simultaneous 401s; without this they would each burn the refresh token, and
   * because the server rotates it on every use, all but one would be left
   * holding a token that had already been replaced.
   */
  const attemptRefresh = useCallback(async (): Promise<string | null> => {
    if (refreshing.current) return refreshing.current;

    const stored = refreshRef.current;
    if (!stored) return null;

    const run = (async () => {
      try {
        const res = await api.post<{ access_token: string; refresh_token: string; user: SessionUser }>(
          '/auth/refresh',
          { refresh_token: stored },
          { skipRefresh: true, timeoutMs: 8000 },
        );
        await persist(res.access_token, res.refresh_token, res.user);
        setSessionEnded(false);
        return res.access_token;
      } catch {
        await clearSession();
        setSessionEnded(true);
        return null;
      } finally {
        refreshing.current = null;
      }
    })();

    refreshing.current = run;
    return run;
  }, [persist, clearSession]);

  // -- register the bridge -------------------------------------------------
  useEffect(() => {
    bindAuth({
      token: () => tokenRef.current,
      refresh: () => attemptRefresh(),
      onExpired: () => {
        clearSession();
        setSessionEnded(true);
      },
    });
    return () => bindAuth(null);
  }, [attemptRefresh, clearSession]);

  // -- restore -------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedUser, storedRefresh] = await Promise.all([
          AsyncStorage.getItem(ACCESS_KEY),
          AsyncStorage.getItem(USER_KEY),
          AsyncStorage.getItem(REFRESH_KEY),
        ]);
        tokenRef.current = storedToken;
        refreshRef.current = storedRefresh;
        if (storedUser) setUser(JSON.parse(storedUser));
        if (storedRefresh) setRefreshToken(storedRefresh);
        if (storedToken) {
          setToken(storedToken);
          // Confirm the token is still good before the first screen trusts it.
          // The call goes through the client, so if it is merely *stale* the
          // bridge renews it and this succeeds; the explicit refresh below is
          // only reached when there was no token to try at all.
          try {
            const me = await api.get<SessionUser>('/auth/me', { timeoutMs: 6000 });
            setUser(me);
            await AsyncStorage.setItem(USER_KEY, JSON.stringify(me));
          } catch {
            await attemptRefresh();
          }
        } else if (storedRefresh) {
          await attemptRefresh();
        }
      } catch {
        // Corrupt storage — start clean rather than crashing on boot.
        await AsyncStorage.multiRemove([ACCESS_KEY, USER_KEY, REFRESH_KEY]);
      } finally {
        setHydrating(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signIn = useCallback<AuthValue['signIn']>(
    async (email, password) => {
      setSigningIn(true);
      setError(null);
      setSessionEnded(false);
      try {
        const res = await api.post<{ access_token: string; refresh_token: string; user: SessionUser }>(
          '/auth/login',
          { email: email.trim(), password },
        );
        await persist(res.access_token, res.refresh_token, res.user);
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Sign-in failed');
        return false;
      } finally {
        setSigningIn(false);
      }
    },
    [persist],
  );

  const register = useCallback<AuthValue['register']>(
    async (email, password, fullName, phone) => {
      setSigningIn(true);
      setError(null);
      try {
        const res = await api.post<{ access_token: string; refresh_token: string; user: SessionUser }>(
          '/auth/register',
          { email: email.trim(), password, full_name: fullName.trim(), phone: phone?.trim() || null },
        );
        await persist(res.access_token, res.refresh_token, res.user);
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not create the account');
        return false;
      } finally {
        setSigningIn(false);
      }
    },
    [persist],
  );

  const changePassword = useCallback<AuthValue['changePassword']>(
    async (currentPassword, newPassword) => {
      setSigningIn(true);
      setError(null);
      try {
        await api.post('/auth/password/change', {
          current_password: currentPassword,
          new_password: newPassword,
        });
        // Re-read the session rather than assuming: the server owns the flag,
        // and a client that clears it locally would hide a change that did not
        // actually take effect.
        const me = await api.get<SessionUser>('/auth/me');
        setUser(me);
        await AsyncStorage.setItem(USER_KEY, JSON.stringify(me));
        return true;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Could not change the password');
        return false;
      } finally {
        setSigningIn(false);
      }
    },
    [],
  );

  const signOut = useCallback(async () => {
    // Told to the server so the audit trail has an end as well as a beginning.
    // Failure is ignored: a sign-out that will not complete because the network
    // is down must still sign the user out locally.
    try {
      await api.post('/auth/logout', {});
    } catch {
      /* offline sign-out is still a sign-out */
    }
    await clearSession();
    setError(null);
    setSessionEnded(false);
  }, [clearSession]);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      token,
      hydrating,
      signingIn,
      error,
      mustChangePassword: !!user?.must_change_password,
      sessionEnded,
      signIn,
      register,
      changePassword,
      signOut,
      clearError: () => setError(null),
      clearSessionEnded: () => setSessionEnded(false),
      can: (...roles: Role[]) => !!user && roles.includes(user.role),
    }),
    [user, token, hydrating, signingIn, error, sessionEnded, signIn, register, changePassword, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/**
 * Landing route for each role once signed in.
 *
 * `hospital_admin` resolves to `/dashboard`, not `/facility`. `/facility` is the
 * *public* facility page — a citizen-facing view of one hospital's published
 * capacity — so hospital staff were being sent to the page their own patients
 * read, with no controls on it, while `/dashboard` (their counters, inbound
 * ambulances and roster) was reachable only by typing the address. The redirect
 * was wrong, not the routing table.
 */
export const homeFor = (role?: Role | null): string => {
  switch (role) {
    case 'hospital_admin':
      return '/dashboard';
    case 'dispatcher':
      return '/console';
    case 'platform_admin':
      return '/admin';
    case 'driver':
      return '/crew';
    case 'gov_official':
      return '/analytics';
    default:
      return '/';
  }
};
