// Shared helpers for building and parsing `data:` URLs used across model
// handlers to inline base64-encoded media/documents in provider requests.

/** Builds a `data:` URL from a MIME type and base64-encoded payload. */
export function toDataUrl(mediaType: string, base64Data: string): string {
  return `data:${mediaType};base64,${base64Data}`;
}

/**
 * Parses a `data:<mediaType>;base64,<data>` URL into its parts. Returns
 * `undefined` if the string doesn't match the expected base64 data URL shape.
 */
export function parseDataUrl(
  dataUrl: string,
): { mediaType: string; base64Data: string } | undefined {
  const match = /^data:([^;]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) return undefined;
  return { mediaType: match[1], base64Data: match[2] };
}
