// Append `chunk` to `current` and keep at most `maxChars` UTF-16 code units,
// truncating at the head. Used by the bash background tail and the CLI TUI
// process-output buffer; consolidated here to avoid drift.

export function appendTail(
  current: string,
  chunk: string,
  maxChars: number,
): string {
  if (!chunk) return current;
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  let cut = combined.length - maxChars;
  // Don't slice in the middle of a surrogate pair — the low half (DC00..DFFF)
  // alone is a ?-rendering invalid code point.
  const code = combined.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return combined.slice(cut);
}
