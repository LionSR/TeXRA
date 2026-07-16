// Centralized layout dimensions for the TUI. Import from here instead of
// re-declaring per-file so spacing stays consistent across forms and modals.

/** Maximum terminal columns used by slash-command form frames. */
export const FORM_FRAME_MAX_WIDTH = 80;

/** Combined columns consumed by ConfirmCard's left+right border and paddingX. */
export const CONFIRM_CARD_HORIZONTAL_DECORATION = 4;

/** Floor for modal/transcript content widths so wrapping never collapses to 0. */
export const MIN_MODAL_CONTENT_WIDTH = 20;

export function clampModalWidth(
  width: number,
  min: number = MIN_MODAL_CONTENT_WIDTH,
): number {
  return Math.max(min, width);
}

/** Columns consumed by the edit diff panel's side padding/gutter. */
export const EDIT_DIFF_PADDING = 6;

/** Columns of side padding in the status bar row. */
export const STATUS_BAR_HORIZONTAL_PADDING = 2;
