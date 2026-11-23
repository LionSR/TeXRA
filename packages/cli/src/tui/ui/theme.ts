// Centralized layout dimensions for the TUI. Import from here instead of
// re-declaring per-file so spacing stays consistent across forms and modals.

import { BORDERED_PANEL_CHROME_COLUMNS } from '@cli/tui/ui/BorderedPanel';

/** Floor for modal/transcript content widths so wrapping never collapses to 0. */
export const MIN_MODAL_CONTENT_WIDTH = 20;

export function clampModalWidth(
  width: number,
  min: number = MIN_MODAL_CONTENT_WIDTH,
): number {
  return Math.max(min, width);
}

/** Content width inside a bordered ConfirmCard at `columns`. */
export function confirmCardContentWidth(columns: number): number {
  return clampModalWidth(columns - BORDERED_PANEL_CHROME_COLUMNS);
}
