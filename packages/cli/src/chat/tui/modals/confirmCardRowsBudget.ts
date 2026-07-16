import { clamp } from '@utils/core';

import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '../ui/theme';
import { wrapAnsiToWidth } from '../render/ansiWrap';
import { confirmCardPulsedTitle } from './ConfirmCardState';

/**
 * Rows budget for the scrollable content region of a ConfirmCard modal
 * (bash command, edit diff, proposal instruction).
 *
 * Chrome around the content comes in two layouts: a spacious one (blank
 * margins around the content) and a compact one used when the terminal is
 * short. The budget first assumes spacious chrome; if that leaves no more
 * than `compactMaxRows` of content, it switches to compact chrome and clamps
 * the result to `[1, compactMaxRows]`. The wrapped title and any
 * modal-specific rows (`extraFixedRows`, e.g. a feedback input or metadata
 * line) count against the budget in both layouts.
 */
export function confirmCardContentRowsBudget({
  availableRows,
  columns,
  title,
  minContentWidth,
  defaultRows,
  compactMaxRows,
  spaciousFixedRows,
  compactFixedRows,
  extraFixedRows = 0,
}: {
  /** Rows granted to the whole modal; undefined means "not constrained". */
  readonly availableRows?: number;
  readonly columns: number;
  readonly title: string;
  readonly minContentWidth: number;
  /** Budget used when `availableRows` is undefined. */
  readonly defaultRows: number;
  /** Content rows shown in the compact layout (and spacious cutoff). */
  readonly compactMaxRows: number;
  /** Chrome rows besides the title in the spacious layout. */
  readonly spaciousFixedRows: number;
  /** Chrome rows besides the title in the compact layout. */
  readonly compactFixedRows: number;
  /** Modal-specific rows present in both layouts. */
  readonly extraFixedRows?: number;
}): number {
  if (availableRows === undefined) return defaultRows;

  const titleWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
    minContentWidth,
  );
  const titleRows = wrapAnsiToWidth(
    confirmCardPulsedTitle(0, title),
    titleWidth,
  ).split('\n').length;
  const fixedRows = titleRows + extraFixedRows;

  const spaciousRows = availableRows - spaciousFixedRows - fixedRows;
  if (spaciousRows > compactMaxRows) {
    return spaciousRows;
  }

  return clamp(availableRows - compactFixedRows - fixedRows, 1, compactMaxRows);
}
