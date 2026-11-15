// Shared clipboard-image extraction for webview paste handlers (main view +
// progress-view follow-up). Browser-only — relies on File/DataTransfer
// and has no Node imports, so it is safe in both webview bundles.

import * as Base64 from 'effect/encoding/Base64';

import { ensureError } from '@texra-ai/harness/schemas';

const IMAGE_MIME_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/tif': 'tiff',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'image/pjpeg': 'jpg',
  'image/x-png': 'png',
  'image/x-jng': 'jng',
  'image/x-mng': 'mng',
  'image/vnd.adobe.photoshop': 'psd',
  'image/x-photoshop': 'psd',
  'image/x-psd': 'psd',
};

export function getExtensionFromMimeType(mimeType: string): string {
  return IMAGE_MIME_TYPES[mimeType] || mimeType.split('/')[1] || 'png';
}

export interface ExtractedClipboardImage {
  readonly fileName: string;
  readonly base64: string;
}

/** Image files present on a paste event, paired with their MIME type. */
export function clipboardImageFiles(
  event: ClipboardEvent,
): Array<{ file: File; type: string }> {
  const items = [...(event.clipboardData?.items ?? [])];
  return items.flatMap((item) => {
    if (!item.type.startsWith('image/')) return [];
    const file = item.getAsFile();
    return file ? [{ file, type: item.type }] : [];
  });
}

/** A pasted file's base64 (no data-URL prefix), or why it could not be read. */
type ClipboardImageRead =
  | { readonly ok: true; readonly base64: string }
  | { readonly ok: false; readonly error: Error };

/** Read a File to base64. A failure carries its cause for the caller to show. */
export async function readFileAsBase64(
  file: File,
): Promise<ClipboardImageRead> {
  try {
    const base64 = Base64.encode(new Uint8Array(await file.arrayBuffer()));
    return base64
      ? { ok: true, base64 }
      : { ok: false, error: new Error('The image held no readable data.') };
  } catch (error) {
    // A clipboard-owned File can become unreadable before it is read. That
    // attachment fails with its cause, while the paste event and other files
    // continue.
    return { ok: false, error: ensureError(error) };
  }
}
