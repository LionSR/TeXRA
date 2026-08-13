// Shared row-budget math for `/`-form select lists. Every list form windows
// its `Select` to the foreground rows the live region grants it, reserving a
// fixed number of chrome rows (border, title, description, key hints). The only
// per-form difference is that chrome-row count, so the policy lives here once.

import { isCompactRows } from '@cli/tui/ui/theme';

export interface SelectWindowSize {
  readonly maxVisibleItems: number | undefined;
  readonly showOverflow: boolean;
}

export const COMPACT_FORM_MAX_ROWS = 9;

export function isCompactFormRows(availableRows: number | undefined): boolean {
  return isCompactRows(availableRows, COMPACT_FORM_MAX_ROWS);
}

/**
 * Decide how many list rows a form's `Select` may show and whether to spend
 * rows on overflow markers.
 *
 * - When `availableRows` is unknown, the caller has no row budget: show
 *   everything (`maxVisibleItems: undefined`) and no overflow marker.
 * - Otherwise reserve `chromeRows` for the frame and key hints, then fit the
 *   list into what remains. On very short terminals (fewer than 3 list rows)
 *   keep the active choice visible instead of spending the whole budget on
 *   overflow markers.
 */
export function computeSelectWindowSize({
  availableRows,
  itemCount,
  chromeRows,
}: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
  readonly chromeRows: number;
}): SelectWindowSize {
  if (availableRows == null) {
    return { maxVisibleItems: undefined, showOverflow: false };
  }

  const selectRows = Math.max(1, availableRows - chromeRows);
  if (itemCount <= selectRows) {
    return { maxVisibleItems: itemCount, showOverflow: false };
  }
  if (selectRows < 3) {
    return { maxVisibleItems: selectRows, showOverflow: false };
  }
  return { maxVisibleItems: Math.max(1, selectRows - 2), showOverflow: true };
}
