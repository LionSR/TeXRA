// Third-party imports
import { Record as Rec } from 'effect';

// Local imports - shared formatting
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '@cli/tui/ui/colors';
import {
  CROSS,
  SKIP_CIRCLE,
  STATUS_DOT,
  TICK,
  WARNING,
} from '@cli/tui/ui/glyphs';
import type { RunTone } from '@ui/copy/runStatus';

/** How the terminal paints a tone: copy decides a status's tone (`RunTone`),
 *  and every TUI row that shows a status takes its marker and colour here. */
export const TONE_PAINT: Readonly<
  Record<RunTone, { readonly marker: string; readonly color: string }>
> = Object.freeze(
  Rec.map(
    {
      running: { marker: STATUS_DOT, color: COLOR_HINT },
      success: { marker: TICK, color: COLOR_SUCCESS },
      danger: { marker: CROSS, color: COLOR_ERROR },
      warning: { marker: WARNING, color: COLOR_WARNING },
      neutral: { marker: SKIP_CIRCLE, color: COLOR_BORDER },
    },
    (paint) => Object.freeze(paint),
  ),
);
