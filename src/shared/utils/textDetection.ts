/**
 * Heuristic check for whether a byte array looks like valid UTF-8 text.
 *
 * Shared between the webview frontend (ExternalInquiryPanel) and the
 * extension-host backend (externalInquiryStorage) so the detection
 * logic stays in sync. Uses only `TextDecoder`, which is available in
 * both browser and Node ≥ 10 environments.
 */
export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return true;

  let suspiciousControlBytes = 0;
  for (const byte of bytes) {
    if (byte === 0) return false;
    const isControl =
      byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13;
    if (isControl) suspiciousControlBytes += 1;
  }

  const text = new TextDecoder('utf-8').decode(bytes);
  if (text.includes('\uFFFD')) return false;

  return suspiciousControlBytes / bytes.length < 0.05;
}
