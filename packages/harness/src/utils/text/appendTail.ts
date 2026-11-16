// Append `chunk` to `current` and keep at most `maxChars` UTF-16 code units,
// truncating at the head. Like appendHead, the cap is enforced on `current`
// itself, so an oversized starting value is trimmed even when `chunk` is
// empty.

export function appendTail(
  current: string,
  chunk: string,
  maxChars: number,
): string {
  const safeMaxChars = Math.max(0, maxChars);
  const combined = current + chunk;
  if (combined.length <= safeMaxChars) return combined;
  let cut = combined.length - safeMaxChars;
  // Don't slice in the middle of a surrogate pair — the low half (DC00..DFFF)
  // alone is a ?-rendering invalid code point.
  const code = combined.charCodeAt(cut);
  if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
  return combined.slice(cut);
}

// Append `chunk` to `current` and keep at most `maxChars` UTF-16 code units,
// truncating at the tail (the opposite of appendTail). Once the cap is
// reached the head is frozen — later chunks are dropped — so this captures
// the *first* N characters ever seen, not a sliding window. A cut that would
// split a surrogate pair stops one short of the cap, which a later call
// cannot tell from a head that has not reached it: a caller appending chunk
// by chunk stops once its head is shorter than what it has seen
// (`headTail` below does).

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

/** A {@link headTail} window as read: the stream's first characters, the
 *  last ones after them, and how many fell between the two. With nothing
 *  elided, `head + tail` is the whole stream. */
export interface HeadTailText {
  readonly head: string;
  readonly tail: string;
  readonly elided: number;
}

/**
 * A stream's first `head` and last `tail` characters, kept as it arrives so
 * a long output needs no buffer of its whole text. The head fills first and
 * then freezes; every later character passes through the rolling tail, and
 * what the tail lets go is counted as elided. `skip(n)` records `n`
 * characters that arrived but are not known (a gap a capped log already
 * left): they end the head and drop the tail before them.
 */
export function headTail(budget: {
  readonly head: number;
  readonly tail: number;
}) {
  let head = '';
  let headOpen = true;
  let tail = '';
  let elided = 0;
  return {
    append(chunk: string): void {
      let rest = chunk;
      if (headOpen) {
        const grown = appendHead(head, rest, budget.head);
        rest = rest.slice(grown.length - head.length);
        head = grown;
        // A cut can stop the head one short of its budget (before a split
        // surrogate pair); the head ends where its first cut fell.
        if (rest) headOpen = false;
      }
      if (!rest) return;
      const kept = appendTail(tail, rest, budget.tail);
      elided += tail.length + rest.length - kept.length;
      tail = kept;
    },
    skip(chars: number): void {
      headOpen = false;
      elided += tail.length + chars;
      tail = '';
    },
    read: (): HeadTailText => ({ head, tail, elided }),
  };
}
