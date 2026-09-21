import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import { useTheme } from '../theme/ThemeProvider';
import { radius, space } from '../theme/tokens';
import { Button, Row, Small, StatusDot, TextField } from '../ui';

/**
 * Search field with voice input (§7, accessibility).
 *
 * The report's accessibility gap is specifically about low-literacy callers and
 * citizens under stress: someone who cannot comfortably type "Coimbatore North
 * Taluk Hospital" can almost certainly say it. So this is a first-class control
 * on the public directory, not a settings toggle.
 *
 * Three decisions worth stating:
 *
 *  - **`webkitSpeechRecognition` is Chrome-family only.** Firefox and Safari do
 *    not ship it. Rather than hide the button and pretend the feature does not
 *    exist, it stays visible and explains itself when pressed — a citizen who
 *    was told the app supports voice should not be left hunting for it.
 *  - **Never auto-submits.** A misheard place name that silently replaces the
 *    query is worse than no voice input, because the person then acts on results
 *    for the wrong hospital. The transcript lands in the field and the user
 *    decides.
 *  - **Locale follows the interface language**, so a Tamil speaker gets Tamil
 *    recognition rather than English recognition of Tamil place names, which
 *    reliably produces nonsense.
 */

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onend: (() => void) | null;
}

function getRecognitionConstructor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function VoiceSearchField({
  value,
  onChangeText,
  placeholder,
  hint,
  voiceLabel,
  listeningLabel,
  unsupportedLabel,
  lang = 'en',
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  hint?: string;
  voiceLabel: string;
  listeningLabel: string;
  unsupportedLabel: string;
  lang?: 'en' | 'ta';
}) {
  const { t } = useTheme();
  const [listening, setListening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const supported = React.useMemo(() => getRecognitionConstructor() !== null, []);

  // Stop the microphone on unmount. A screen that navigates away while the
  // recogniser is live leaves the browser's mic indicator on — which looks like
  // the app is still listening, because it is.
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
      recognitionRef.current = null;
    };
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Ctor = getRecognitionConstructor();
    if (!Ctor) {
      setNotice(unsupportedLabel);
      return;
    }
    setNotice(null);

    const recognition = new Ctor();
    recognition.lang = lang === 'ta' ? 'ta-IN' : 'en-IN';
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        transcript += event.results[i][0].transcript;
      }
      onChangeText(transcript.trim());
    };
    recognition.onerror = (event: any) => {
      setListening(false);
      if (event?.error === 'not-allowed' || event?.error === 'service-not-allowed') {
        setNotice('Microphone access was refused — type your search instead.');
      } else if (event?.error === 'no-speech') {
        setNotice('Nothing was heard — try again closer to the phone.');
      }
    };
    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [lang, onChangeText, unsupportedLabel]);

  return (
    <View style={{ width: '100%', gap: space.sm }}>
      <Row gap={space.sm} align="flex-end">
        <View style={{ flex: 1, minWidth: 0 }}>
          <TextField
            value={value}
            onChangeText={onChangeText}
            placeholder={placeholder}
            icon="search"
            hint={hint}
          />
        </View>
        <Button
          label={listening ? listeningLabel : voiceLabel}
          icon={listening ? 'x' : 'mic'}
          variant={listening ? 'danger' : 'secondary'}
          onPress={listening ? stop : start}
          accessibilityHint={
            supported ? 'Dictates a facility or area name into the search field' : unsupportedLabel
          }
        />
      </Row>

      {listening ? (
        <Row
          gap={space.sm}
          align="center"
          style={{
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderRadius: radius.md,
            backgroundColor: t.status.critical.soft,
            borderWidth: 1,
            borderColor: `${t.status.critical.base}44`,
          }}
        >
          <StatusDot tone="critical" size={8} />
          <Small style={{ color: t.status.critical.base }}>{listeningLabel}</Small>
        </Row>
      ) : null}

      {notice ? <Small muted>{notice}</Small> : null}
    </View>
  );
}
