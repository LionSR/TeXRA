/**
 * The theory plugin's setting rows: the compile check after a revision
 * (`documents.*`) and the diffs between revisions (`latexdiff.*`), which
 * TeXRA's catalog lists (`./texraSettings`). They live here, in a
 * browser-safe module, because the settings view's webview renders them.
 */

// Third-party imports
import { Schema } from 'effect';
import { decodingDefault } from '@texra-ai/worldline/schemas';

// Local imports
import { LATEXDIFF_MATH_MARKUP_VALUES } from '@texra/shared/constants/latexConfig';
import type { TexraSettingRow } from '@texra/shared/settings/settingSurfaces';

export const DOCUMENTS_COMPILE_AFTER_OUTPUT_SETTING = Object.freeze({
  key: 'documents.compileAfterOutput',
  schema: decodingDefault(Schema.Boolean, true),
  title: 'Auto-compile outputs',
  description:
    'Compile the LaTeX project automatically after a document task writes its output.',
  category: 'documents',
  slot: 'workspaceState',
  surfaces: Object.freeze({ settingsView: 'latex', cliConfig: true }),
} as const satisfies TexraSettingRow<boolean>);

export const DOCUMENTS_COMPILE_TIMEOUT_SETTING = Object.freeze({
  key: 'documents.compileTimeoutMs',
  schema: decodingDefault(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(10_000)),
    120_000,
  ),
  title: 'Auto-compile timeout',
  description:
    'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
  category: 'documents',
  slot: 'workspaceState',
  surfaces: Object.freeze({ cliConfig: true }),
} as const satisfies TexraSettingRow<number>);

export const DOCUMENTS_OPEN_PDF_SETTING = Object.freeze({
  key: 'documents.openPdf',
  schema: decodingDefault(Schema.Boolean, true),
  title: 'Open the compiled PDF',
  description:
    'After auto-compile, open the PDF when it succeeds or the LaTeX log when it fails.',
  category: 'documents',
  slot: 'workspaceState',
  // Read by the theory plugin, but the emitted `openFile` notice has no
  // CLI handler (headless), so the CLI ignores it.
  surfaces: Object.freeze({ settingsView: 'latex' }),
} as const satisfies TexraSettingRow<boolean>);

export const DOCUMENTS_REJECT_ON_COMPILE_FAILURE_SETTING = Object.freeze({
  key: 'documents.rejectOnCompileFailure',
  schema: decodingDefault(Schema.Boolean, true),
  title: 'Repair failed compiles',
  description:
    'When the automatic compile fails, spend the next revision repairing the output from the compile log.',
  category: 'documents',
  slot: 'workspaceState',
  surfaces: Object.freeze({ settingsView: 'latex', cliConfig: true }),
} as const satisfies TexraSettingRow<boolean>);

// Run by the theory plugin, so every host honors them. The timeout is
// kept out of the settings view (an insider knob) and edited from CLI
// `/config`; the rest are deferred from `/config` by product decision.

export const LATEXDIFF_BETWEEN_ROUNDS_SETTING = Object.freeze({
  key: 'latexdiff.generateBetweenRoundDiffs',
  schema: decodingDefault(Schema.Boolean, false),
  title: 'Diff consecutive revisions',
  description:
    'Also diff each revision against the previous one, not only against your original input.',
  category: 'latexdiff',
  slot: 'workspaceState',
  surfaces: Object.freeze({ settingsView: 'latex' }),
} as const satisfies TexraSettingRow<boolean>);

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
  schema: decodingDefault(
    Schema.Literals(LATEXDIFF_MATH_MARKUP_VALUES),
    'coarse',
  ),
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
} as const satisfies TexraSettingRow<
  (typeof LATEXDIFF_MATH_MARKUP_VALUES)[number]
>);

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

/** The theory plugin's rows, in catalog order. */
export const DOCUMENTS_SETTINGS: readonly TexraSettingRow[] = Object.freeze([
  DOCUMENTS_COMPILE_AFTER_OUTPUT_SETTING,
  DOCUMENTS_COMPILE_TIMEOUT_SETTING,
  DOCUMENTS_OPEN_PDF_SETTING,
  DOCUMENTS_REJECT_ON_COMPILE_FAILURE_SETTING,
  LATEXDIFF_BETWEEN_ROUNDS_SETTING,
  LATEXDIFF_TIMEOUT_SETTING,
  LATEXDIFF_MATH_MARKUP_SETTING,
  LATEXDIFF_CHANGES_ONLY_SETTING,
]);
