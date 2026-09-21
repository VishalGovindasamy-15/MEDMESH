import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { wsUrl } from '../api/client';
import type { Capacity, TrustVerdict } from '../api/types';
import { useAuth } from './AuthProvider';

/**
 * Live capacity feed.
 *
 * Behaviour that matters operationally:
 *  - Reconnects with capped exponential backoff, and stops trying while the app
 *    is backgrounded (a phone in a pocket should not hold a socket open).
 *  - Tracks `lastEventAt` so every surface can show the age of what it is
 *    displaying. A dashboard that cannot say how old its own data is has no
 *    business presenting numbers as current.
 *  - Exposes `connected` and `degraded` separately: "the socket dropped" and
 *    "the socket dropped and we have not heard anything for 45 s" are different
 *    problems to an operator.
 */

export interface LiveFacility {
  hospital: {
    id: number;
    name: string;
    short_name: string;
    type: string;
    district_id: number;
    lat: number;
    lng: number;
    verification: string;
    integration: string;
  };
  capacity: Capacity;
  ed_congestion: string;
  trust?: TrustVerdict;
}

export interface LiveEvent {
  seq: number;
  event: string;
  at: string;
  data: any;
}

interface LiveValue {
  connected: boolean;
  degraded: boolean;
  lastEventAt: number | null;
  facilities: Record<number, LiveFacility>;
  /** Most recent capacity delta for a facility, for row-level flash feedback. */
  touched: Record<number, number>;
  reconnect: () => void;
  subscribe: (kind: string, handler: (e: LiveEvent) => void) => () => void;
}

const LiveContext = createContext<LiveValue>({} as LiveValue);

const MAX_BACKOFF_MS = 15_000;

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [connected, setConnected] = useState(false);
  const [lastEventAt, setLastEventAt] = useState<number | null>(null);
  const [facilities, setFacilities] = useState<Record<number, LiveFacility>>({});
  const [touched, setTouched] = useState<Record<number, number>>({});
  const [tick, setTick] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const attempts = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlers = useRef<Map<string, Set<(e: LiveEvent) => void>>>(new Map());
  const [, forceRender] = useState(0);

  const emit = useCallback((envelope: LiveEvent) => {
    setLastEventAt(Date.now());
    handlers.current.get(envelope.event)?.forEach((fn) => {
      try {
        fn(envelope);
      } catch {
        // A broken subscriber must not take the socket down.
      }
    });
    handlers.current.get('*')?.forEach((fn) => fn(envelope));
  }, []);

  const connect = useCallback(() => {
    if (Platform.OS === 'web' && typeof window === 'undefined') return;
    const current = socketRef.current;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;

    let socket: WebSocket;
    try {
      socket = new WebSocket(wsUrl('/ws/feed', token));
    } catch {
      scheduleReconnect();
      return;
    }
    socketRef.current = socket;

    socket.onopen = () => {
      attempts.current = 0;
      setConnected(true);
    };

    socket.onmessage = (raw) => {
      let envelope: LiveEvent;
      try {
        envelope = JSON.parse(String(raw.data));
      } catch {
        return;
      }

      if (envelope.event === 'snapshot') {
        const next: Record<number, LiveFacility> = {};
        for (const row of envelope.data?.hospitals ?? []) next[row.hospital.id] = row;
        setFacilities(next);
        setLastEventAt(Date.now());
        return;
      }

      if (envelope.event === 'ping') {
        setLastEventAt(Date.now());
        return;
      }

      if (envelope.event === 'capacity.updated') {
        const hid = envelope.data.hospital_id as number;
        setFacilities((prev) => {
          const existing = prev[hid];
          if (!existing) return prev;
          return { ...prev, [hid]: { ...existing, capacity: envelope.data.capacity } };
        });
        setTouched((prev) => ({ ...prev, [hid]: Date.now() }));
      }

      emit(envelope);
    };

    socket.onerror = () => {
      setConnected(false);
    };

    socket.onclose = () => {
      setConnected(false);
      socketRef.current = null;
      scheduleReconnect();
    };

    function scheduleReconnect() {
      if (timerRef.current) return;
      const delay = Math.min(MAX_BACKOFF_MS, 900 * 2 ** attempts.current);
      attempts.current += 1;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        connect();
      }, delay);
    }
  }, [emit, token]);

  const reconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    attempts.current = 0;
    setTick((v) => v + 1);
  }, []);

  useEffect(() => {
    connect();
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [connect, tick]);

  // Pause the socket while backgrounded; resume (and reconnect) on foreground.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') connect();
      else {
        socketRef.current?.close();
        socketRef.current = null;
        setConnected(false);
      }
    });
    return () => sub.remove();
  }, [connect]);

  // Drives the "age of data" clock even when nothing is arriving.
  useEffect(() => {
    const id = setInterval(() => forceRender((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const subscribe = useCallback((kind: string, handler: (e: LiveEvent) => void) => {
    const set = handlers.current.get(kind) ?? new Set();
    set.add(handler);
    handlers.current.set(kind, set);
    return () => {
      set.delete(handler);
    };
  }, []);

  const staleSeconds = lastEventAt ? Math.floor((Date.now() - lastEventAt) / 1000) : null;
  const degraded = connected && staleSeconds !== null && staleSeconds > 45;

  const value = useMemo<LiveValue>(
    () => ({
      connected,
      degraded,
      lastEventAt,
      facilities,
      touched,
      reconnect,
      subscribe,
    }),
    [connected, degraded, lastEventAt, facilities, touched, reconnect, subscribe],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);

/** Human phrasing for "how old is this number". Used in every freshness label. */
export function ageLabel(seconds?: number | null): string {
  if (seconds == null) return 'unknown';
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}
