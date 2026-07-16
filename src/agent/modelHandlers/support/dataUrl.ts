// Shared helper for building `data:` URLs used across model handlers to inline
// base64-encoded media/documents in provider requests.

/** Builds a `data:` URL from a MIME type and base64-encoded payload. */
export function toDataUrl(mediaType: string, base64Data: string): string {
  return `data:${mediaType};base64,${base64Data}`;
}
