// Append `chunk` to `current` and keep at most `maxChars` UTF-16 code units,
// truncating at the head. Used by the bash background tail, the CLI TUI
// process-output buffer, and the shared stream-meta reducer; consolidated here
// to avoid drift.
//
// `retainChars` is the length to keep once the cap is crossed; it defaults to
// `maxChars` (an exact head-cut at the cap). Passing a smaller `retainChars`
// trims further below the cap so output can keep appending for a while before
// the next reset (the webview's 100k→80k policy).

export function appendTail(
  current: string,
  chunk: string,
  maxChars: number,
  retainChars: number = maxChars,
): string {
  if (!chunk) return current;
  const combined = current + chunk;
  if (combined.length <= maxChars) return combined;
  let cut = Math.max(0, combined.length - retainChars);
  // Don't slice in the middle of a surrogate pair — the low half (DC00..DFFF)
  // alone is a ?-rendering invalid code point.
  const code = combined.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return combined.slice(cut);
}
