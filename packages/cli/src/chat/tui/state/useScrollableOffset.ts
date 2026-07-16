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
  active = true,
  maxScrollOffset,
  pageRows,
  resetKey,
}: {
  /** Release the key bindings while another surface owns ↑/↓ (e.g. a
   *  feedback text input); the offset itself is retained. */
  readonly active?: boolean;
  readonly maxScrollOffset: number;
  readonly pageRows: number;
  /** Snap back to the top whenever this changes (e.g. new content). */
  readonly resetKey?: unknown;
}): { scrollOffset: number; scrollable: boolean } {
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollable = maxScrollOffset > 0;

  function scrollBy(delta: number): void {
    setScrollOffset((current) => clamp(current + delta, 0, maxScrollOffset));
  }

  useEffect(() => {
    setScrollOffset((current) => clamp(current, 0, maxScrollOffset));
  }, [maxScrollOffset]);

  useEffect(() => {
    setScrollOffset(0);
  }, [resetKey]);

  useInput(
    (_input, key) => {
      if (key.downArrow) scrollBy(1);
      else if (key.upArrow) scrollBy(-1);
      else if (key.pageDown) scrollBy(pageRows);
      else if (key.pageUp) scrollBy(-pageRows);
    },
    { isActive: scrollable && active },
  );

  return { scrollOffset, scrollable };
}
