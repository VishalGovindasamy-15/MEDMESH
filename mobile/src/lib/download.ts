/**
 * Delivering a file to whoever asked for it.
 *
 * Three things have to be true of an export from this platform, and the naive
 * implementations miss at least one of them every time:
 *
 *   1. It is authenticated. Every export endpoint is role-gated, so the request
 *      must carry the bearer token. `window.open('/api/v1/analytics/...')` looks
 *      like it works -- the tab opens -- and then shows the operator a raw
 *      `{"detail":"Not authenticated"}` body, which reads as a broken feature
 *      rather than a missing header.
 *   2. The server's filename is honoured. The export endpoint sets
 *      `Content-Disposition` with the district, the window and the generation
 *      date in it, because a control room accumulates these and
 *      `capacity (7).csv` tells nobody anything six months later.
 *   3. It works off the web too. A crew tablet offline after a transfer needs to
 *      hand a CSV to a receiving ward, so the native path shares the bytes out
 *      rather than assuming a browser download.
 *
 * The bytes are fetched through `api.getRaw()` rather than handed to the
 * browser's own download machinery, which is what makes (1) and (2) possible.
 */

import { Platform } from 'react-native';

import { api } from '../api/client';

/** `attachment; filename="district-capacity-2026-09-30.csv"` -> the name. */
export function filenameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;

  // RFC 5987 form first: some proxies mangle the plain parameter, and the
  // extended form is the one that survives non-ASCII filenames.
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      /* fall through to the plain parameter */
    }
  }

  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}

export interface DownloadResult {
  filename: string;
  bytes: number;
}

/**
 * Fetch a CSV and hand it to the platform's own save/share sheet.
 *
 * Deliberately no silent catch: the caller shows the error. An export that
 * failed quietly is worse than one that failed loudly, because the operator
 * walks away believing the file is on their disk.
 */
export async function downloadCsv(
  path: string,
  fallbackName = 'medmesh-export.csv',
): Promise<DownloadResult> {
  const { body, contentDisposition } = await api.getRaw(path);
  const filename = filenameFromDisposition(contentDisposition, fallbackName);

  if (Platform.OS === 'web') {
    // BOM first. Every export here is opened in Excel at some point, and Excel
    // on Windows reads a bare UTF-8 CSV as the local code page -- which turns
    // "Tamil Nadu" into mojibake for the one user who matters most, the
    // official who is about to put this in a briefing.
    const blob = new Blob(['\uFEFF', body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    // Revoked on the next tick: revoking synchronously races the browser's own
    // read of the blob in Firefox and yields an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return { filename, bytes: body.length };
  }

  // Native. Both modules are required lazily and guarded, so a build without
  // them still bundles and simply reports that it cannot save -- which is the
  // honest outcome, and better than a button that silently does nothing.
  //
  // The specifiers are written out in full rather than passed to a helper:
  // Metro resolves requires statically, and `require(name)` is a bundling
  // error, not a runtime one, so the helper version fails the build outright.
  const FileSystem = tryRequire(() => require('expo-file-system'));
  const Sharing = tryRequire(() => require('expo-sharing'));
  if (!FileSystem || !Sharing) {
    throw new Error(
      'Saving files needs expo-file-system and expo-sharing in this build. The export is available from the desktop console.',
    );
  }

  const target = `${FileSystem.cacheDirectory ?? FileSystem.documentDirectory}${filename}`;
  await FileSystem.writeAsStringAsync(target, body, {
    encoding: FileSystem.EncodingType?.UTF8 ?? 'utf8',
  });

  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(target, {
      mimeType: 'text/csv',
      dialogTitle: filename,
      UTI: 'public.comma-separated-values-text',
    });
  }
  return { filename, bytes: body.length };
}

function tryRequire<T>(load: () => T): T | null {
  try {
    return load();
  } catch {
    return null;
  }
}
