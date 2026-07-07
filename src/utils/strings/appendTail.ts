// Append `chunk` to `current` and keep at most `maxChars` UTF-16 code units,
// truncating at the head. Used by the bash background tail, the CLI TUI
// process-output buffer, and the shared stream-meta reducer; consolidated here
// to avoid drift.
//
// `retainChars` is the length to keep once the cap is crossed; it defaults to
// `maxChars` (an exact head-cut at the cap). Passing a smaller `retainChars`
// trims further below the cap so output can keep appending for a while before
// the next reset (the webview's 100k→80k policy). It is clamped to the cap so
// callers cannot accidentally retain more than `maxChars`.

import { clamp } from '@utils/core';

export function appendTail(
  current: string,
  chunk: string,
  maxChars: number,
  retainChars: number = maxChars,
): string {
  const safeMaxChars = Math.max(0, maxChars);
  const safeRetainChars = clamp(retainChars, 0, safeMaxChars);
  if (!chunk) return current;
  const combined = current + chunk;
  if (combined.length <= safeMaxChars) return combined;
  let cut = combined.length - safeRetainChars;
  // Don't slice in the middle of a surrogate pair — the low half (DC00..DFFF)
  // alone is a ?-rendering invalid code point.
  const code = combined.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return combined.slice(cut);
}

// Append `chunk` to `current` and keep at most `maxChars` UTF-16 code units,
// truncating at the tail (the opposite of appendTail). Once the cap is
// reached the head is frozen — later chunks are dropped — so this captures
// the *first* N characters ever seen, not a sliding window. Pairs with
// appendTail for the bash background tool: a long run's first fatal error
// (captured here) survives alongside the most recent output (captured by
// appendTail) even after the combined stream far exceeds either budget.

export function appendHead(
  current: string,
  chunk: string,
  maxChars: number,
): string {
  const safeMaxChars = Math.max(0, maxChars);
  // Once `current` is already at (or past) the cap, freeze it — don't grow
  // further with `chunk` — but still enforce the cap on `current` itself so
  // the "at most maxChars" invariant holds even for a caller that hands in an
  // oversized starting value.
  const combined =
    current.length >= safeMaxChars || !chunk ? current : current + chunk;
  if (combined.length <= safeMaxChars) return combined;
  let cut = safeMaxChars;
  // Don't slice in the middle of a surrogate pair — the low half (DC00..DFFF)
  // alone is a ?-rendering invalid code point. Clamp to 0 so a leading low
  // surrogate at maxChars=0 cannot push the cut negative (slice(0, -1) would
  // return the wrong content instead of an empty string).
  const code = combined.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut = Math.max(0, cut - 1);
  return combined.slice(0, cut);
}
