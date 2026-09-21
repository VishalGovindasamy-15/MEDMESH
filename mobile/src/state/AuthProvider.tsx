import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { api, ApiError } from '../api/client';
import type { Role, SessionUser } from '../api/types';

/**
 * Session state.
 *
 * The token lives in AsyncStorage, not SecureStore, and that is a conscious
 * pilot-stage decision with a cost: on a rooted device the token is readable.
 * Production moves this to SecureStore/Keychain and shortens the access-token
 * TTL — noted here rather than silently shipped, because "we will fix auth
 * later" is exactly the kind of note that never gets written down.
 */

const ACCESS_KEY = 'medmesh.token';
const REFRESH_KEY = 'medmesh.refresh';
const USER_KEY = 'medmesh.user';

interface AuthValue {
  user: SessionUser | null;
  token: string | null;
  hydrating: boolean;
  signingIn: boolean;
  error: string | null;
  signIn: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string, fullName: string) => Promise<boolean>;
  signOut: () => Promise<void>;
  clearError: () => void;
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
  const refreshing = useRef(false);

  // -- restore ------------------------------------------------------------
  useEffect(() => {
    (async () => {
      try {
        const [storedToken, storedUser, storedRefresh] = await Promise.all([
          AsyncStorage.getItem(ACCESS_KEY),
          AsyncStorage.getItem(USER_KEY),
          AsyncStorage.getItem(REFRESH_KEY),
        ]);
        if (storedUser) setUser(JSON.parse(storedUser));
        if (storedRefresh) setRefreshToken(storedRefresh);
        if (storedToken) {
          setToken(storedToken);
          // Confirm the token is still good before the first screen trusts it.
          try {
            const me = await api.get<SessionUser>('/auth/me', { token: storedToken, timeoutMs: 6000 });
            setUser(me);
            await AsyncStorage.setItem(USER_KEY, JSON.stringify(me));
          } catch (err) {
            await attemptRefresh(storedRefresh);
          }
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

  const persist = useCallback(async (access: string, refresh: string, nextUser: SessionUser) => {
    setToken(access);
    setRefreshToken(refresh);
    setUser(nextUser);
    await AsyncStorage.multiSet([
      [ACCESS_KEY, access],
      [REFRESH_KEY, refresh],
      [USER_KEY, JSON.stringify(nextUser)],
    ]);
  }, []);

  async function attemptRefresh(storedRefresh: string | null): Promise<boolean> {
    if (!storedRefresh || refreshing.current) return false;
    refreshing.current = true;
    try {
      const res = await api.post<{ access_token: string; refresh_token: string; user: SessionUser }>(
        '/auth/refresh',
        { refresh_token: storedRefresh },
      );
      await persist(res.access_token, res.refresh_token, res.user);
      return true;
    } catch {
      await AsyncStorage.multiRemove([ACCESS_KEY, USER_KEY, REFRESH_KEY]);
      setToken(null);
      setUser(null);
      return false;
    } finally {
      refreshing.current = false;
    }
  }

  const signIn = useCallback<AuthValue['signIn']>(
    async (email, password) => {
      setSigningIn(true);
      setError(null);
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
    async (email, password, fullName) => {
      setSigningIn(true);
      setError(null);
      try {
        const res = await api.post<{ access_token: string; refresh_token: string; user: SessionUser }>(
          '/auth/register',
          { email: email.trim(), password, full_name: fullName.trim() },
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

  const signOut = useCallback(async () => {
    await AsyncStorage.multiRemove([ACCESS_KEY, USER_KEY, REFRESH_KEY]);
    setToken(null);
    setUser(null);
    setError(null);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      user,
      token,
      hydrating,
      signingIn,
      error,
      signIn,
      register,
      signOut,
      clearError: () => setError(null),
      can: (...roles: Role[]) => !!user && roles.includes(user.role),
    }),
    [user, token, hydrating, signingIn, error, signIn, register, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);

/** Landing route for each role once signed in. */
export const homeFor = (role?: Role | null): string => {
  switch (role) {
    case 'dispatcher':
    case 'platform_admin':
      return '/console';
    case 'hospital_admin':
      return '/facility';
    case 'driver':
      return '/crew';
    case 'gov_official':
      return '/analytics';
    default:
      return '/';
  }
};
