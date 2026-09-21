import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { translate, type Lang } from '../lib/i18n';
import { congestionStatus, freshnessStatus, themes, trustStatus, urgencyStatus, type ThemeMode, type Tokens } from './tokens';

export { congestionStatus, freshnessStatus, trustStatus, urgencyStatus };

interface ThemeValue {
  t: Tokens;
  mode: ThemeMode;
  toggle: () => void;
  /** Interface language. Lives here because every translated string is rendered
   *  alongside a themed one and two providers would be one too many. */
  lang: Lang;
  setLang: (lang: Lang) => void;
  /** Translate a key for the active language. */
  tr: (key: string, vars?: Record<string, string | number>) => string;
}

const ThemeContext = createContext<ThemeValue>({
  t: themes.light,
  mode: 'light',
  toggle: () => {},
  lang: 'en',
  setLang: () => {},
  tr: (key) => translate('en', key),
});

const STORAGE_KEY = 'medmesh.theme';
const LANG_KEY = 'medmesh.lang';

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>('light');
  const [lang, setLangState] = useState<Lang>('en');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(STORAGE_KEY), AsyncStorage.getItem(LANG_KEY)])
      .then(([savedMode, savedLang]) => {
        if (savedMode === 'dark' || savedMode === 'light') setMode(savedMode);
        if (savedLang === 'ta' || savedLang === 'en') setLangState(savedLang);
      })
      .finally(() => setHydrated(true));
  }, []);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    AsyncStorage.setItem(LANG_KEY, next).catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    setMode((current) => {
      const next: ThemeMode = current === 'light' ? 'dark' : 'light';
      AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      return next;
    });
  }, []);

  const tr = useCallback(
    (key: string, vars?: Record<string, string | number>) => translate(lang, key, vars),
    [lang],
  );

  const value = useMemo<ThemeValue>(
    () => ({ t: themes[mode], mode, toggle, lang, setLang, tr }),
    [mode, toggle, hydrated, lang, setLang, tr],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
