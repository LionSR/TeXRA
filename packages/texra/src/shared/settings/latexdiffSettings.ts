/**
 * The setting rows of the latexdiff preview a `.tex` edit's approval shows
 * (`latexdiff.*`), which TeXRA's catalog lists (`./texraSettings`). They
 * live here, in a browser-safe module, because the settings view's webview
 * renders them.
 */

// Third-party imports
import { Schema } from 'effect';
import { decodingDefault } from '@texra-ai/worldline/schemas';

// Local imports
import type { TexraSettingRow } from '@texra/shared/settings/settingSurfaces';

/** latexdiff's `--math-markup` modes. */
const MathMarkupSchema = Schema.Literals(['off', 'whole', 'coarse', 'fine']);

export const LATEXDIFF_TIMEOUT_SETTING = Object.freeze({
  key: 'latexdiff.timeoutMs',
  schema: decodingDefault(
    Schema.Int.check(Schema.isBetween({ minimum: 1000, maximum: 80_000 })),
    10_000,
  ),
  title: 'latexdiff timeout',
  description:
    'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
  category: 'latexdiff',
  slot: 'workspaceState',
  surfaces: Object.freeze({ cliConfig: true }),
} as const satisfies TexraSettingRow<number>);

export const LATEXDIFF_MATH_MARKUP_SETTING = Object.freeze({
  key: 'latexdiff.mathMarkup',
  schema: decodingDefault(MathMarkupSchema, 'coarse'),
  title: 'Math markup in diffs',
  description: 'How latexdiff marks up changes inside math environments.',
  category: 'latexdiff',
  slot: 'workspaceState',
  choices: Object.freeze({
    off: Object.freeze({ description: 'suppress markup' }),
    whole: Object.freeze({ description: 'equation-level' }),
    coarse: Object.freeze({ description: 'within equations' }),
    fine: Object.freeze({ description: 'small changes inside equations' }),
  }),
  surfaces: Object.freeze({ settingsView: 'latex' }),
} as const satisfies TexraSettingRow<typeof MathMarkupSchema.Type>);

export const LATEXDIFF_CHANGES_ONLY_SETTING = Object.freeze({
  key: 'latexdiff.changesOnly',
  schema: decodingDefault(Schema.Boolean, true),
  title: 'Only changed pages in diff PDFs',
  description:
    'Compile diff PDFs with only the pages that contain edits, instead of the full document.',
  category: 'latexdiff',
  slot: 'workspaceState',
  surfaces: Object.freeze({ settingsView: 'latex' }),
} as const satisfies TexraSettingRow<boolean>);

/** The latexdiff rows, in catalog order. */
export const LATEXDIFF_SETTINGS: readonly TexraSettingRow[] = Object.freeze([
  LATEXDIFF_TIMEOUT_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
  LATEXDIFF_CHANGES_ONLY_SETTING,
]);
