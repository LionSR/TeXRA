// Shared clipboard-image extraction for webview paste handlers (main view +
// progress-view follow-up). Browser-only — relies on FileReader/DataTransfer
// and has no Node imports, so it is safe in both webview bundles.

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
  readonly mediaType: string;
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
      // Browsers may synchronously reject a clipboard-owned File that became
      // unreadable before FileReader started. This matches reader.onerror: only
      // that attachment is omitted, while the paste event and other files continue.
      resolve(null);
    }
  });
}
