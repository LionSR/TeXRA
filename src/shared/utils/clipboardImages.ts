// Shared clipboard-image extraction for webview paste handlers (main view +
// progress-view follow-up). Browser-only — relies on FileReader/DataTransfer
// and has no Node imports, so it is safe in both webview bundles.

import { nanoid } from 'nanoid';

import { PASTED_PREFIX } from '@shared/files/pastedImageConstants';

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
};

export function getExtensionFromMimeType(mimeType: string): string {
  return IMAGE_MIME_TYPES[mimeType] || mimeType.split('/')[1] || 'png';
}

export function generatePastedImageName(extension: string): string {
  return `${PASTED_PREFIX}${Date.now()}_${nanoid(6)}.${extension}`;
}

export interface ExtractedClipboardImage {
  readonly fileName: string;
  readonly base64: string;
  readonly mediaType: string;
}

/** Image files present on a paste event, paired with their MIME type. */
export function clipboardImageFiles(
  event: ClipboardEvent,
): Array<{ file: File; type: string }> {
  const list = event.clipboardData?.items;
  const images: Array<{ file: File; type: string }> = [];
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const item = list?.[i];
    if (!item || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) images.push({ file, type: item.type });
  }
  return images;
}

/** Read a File to base64 (no data-URL prefix), or null on failure. */
export function readFileAsBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(
        typeof result === 'string' ? (result.split(',')[1] ?? null) : null,
      );
    };
    reader.onerror = () => resolve(null);
    try {
      reader.readAsDataURL(file);
    } catch {
      resolve(null);
    }
  });
}
