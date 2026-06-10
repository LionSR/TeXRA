import { useEffect, useState } from 'react';
import { useInput } from 'ink';

import { clamp } from '@utils/core';

/**
 * Scroll offset for a bounded modal region (approval diffs, command previews,
 * delegation prompts). Keeps the offset within [0, maxScrollOffset] — also
 * re-clamping when the bound shrinks on resize — and binds ↑/↓ and
 * PgUp/PgDn while there is anything to scroll.
 */
export function useScrollableOffset({
  maxScrollOffset,
  pageRows,
}: {
  readonly maxScrollOffset: number;
  readonly pageRows: number;
}): { scrollOffset: number; scrollable: boolean } {
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollable = maxScrollOffset > 0;

  function scrollBy(delta: number): void {
    setScrollOffset((current) => clamp(current + delta, 0, maxScrollOffset));
  }

  useEffect(() => {
    setScrollOffset((current) => clamp(current, 0, maxScrollOffset));
  }, [maxScrollOffset]);

  useInput(
    (_input, key) => {
      if (key.downArrow) scrollBy(1);
      else if (key.upArrow) scrollBy(-1);
      else if (key.pageDown) scrollBy(pageRows);
      else if (key.pageUp) scrollBy(-pageRows);
    },
    { isActive: scrollable },
  );

  return { scrollOffset, scrollable };
}
