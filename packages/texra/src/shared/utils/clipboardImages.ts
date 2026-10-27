// Shared clipboard-image extraction for webview paste handlers (main view +
// progress-view follow-up). Browser-only — relies on FileReader/DataTransfer
// and has no Node imports, so it is safe in both webview bundles.

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
export function readFileAsBase64(file: File): Promise<ClipboardImageRead> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      const base64 =
        typeof result === 'string' ? result.split(',')[1] : undefined;
      resolve(
        base64
          ? { ok: true, base64 }
          : { ok: false, error: new Error('The image held no readable data.') },
      );
    };
    reader.onerror = () =>
      resolve({
        ok: false,
        error: reader.error ?? new Error('The image could not be read.'),
      });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      // Browsers may synchronously reject a clipboard-owned File that became
      // unreadable before FileReader started. This matches reader.onerror:
      // that attachment fails with its cause, while the paste event and other
      // files continue.
      resolve({ ok: false, error: ensureError(error) });
    }
  });
}
