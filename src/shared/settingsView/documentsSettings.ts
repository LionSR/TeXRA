/**
 * The documents plugin's setting rows and keys: the compile check after a
 * revision (`workflow.*`) and the diffs between revisions (`latexdiff.*`),
 * which TeXRA's catalog lists (`./texraSettings`). They live here, in a
 * browser-safe module, because the settings view's webview renders them.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latexConfig';
import {
  surfacedSetting,
  type PluginSettingRow,
} from '@shared/state/stateSettings';

/** The documents plugin's workspace-scoped keys. */
export enum DocumentsStateKey {
  WORKFLOW_AUTO_COMPILE = 'texra.workflow.autoCompileAfterOutput',
  WORKFLOW_AUTO_COMPILE_TIMEOUT_MS = 'texra.workflow.autoCompileTimeoutMs',
  WORKFLOW_AUTO_OPEN_PDF = 'texra.workflow.autoOpenPdf',
  WORKFLOW_REJECT_ON_COMPILE_FAILURE = 'texra.workflow.rejectOnCompileFailure',
  LATEXDIFF_BETWEEN_ROUNDS = 'texra.latexdiff.generateBetweenRoundDiffs',
  LATEXDIFF_TIMEOUT_MS = 'texra.latexdiff.timeoutMs',
  LATEXDIFF_MATH_MARKUP = 'texra.latexdiff.mathMarkup',
  LATEXDIFF_CHANGES_ONLY = 'texra.latexdiff.changesOnly',
}

/** The documents plugin's rows, in catalog order. */
export const DOCUMENTS_SETTINGS: readonly PluginSettingRow[] = [
  {
    label: 'Auto-compile outputs',
    row: surfacedSetting({
      key: DocumentsStateKey.WORKFLOW_AUTO_COMPILE,
      schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
      title: 'Auto-compile outputs',
      description:
        'Compile the LaTeX project automatically after a document task writes its output.',
      category: 'workflow',
      slot: 'workspaceState',
      surfaces: { settingsView: 'latex', cliConfig: true },
    }),
  },
  {
    label: 'Auto-compile timeout',
    row: surfacedSetting({
      key: DocumentsStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
      schema: z
        .int()
        .min(LATEX_CONFIG_RANGES.workflowAutoCompileTimeoutMs.min)
        .prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompileTimeoutMs),
      title: 'Auto-compile timeout',
      description:
        'Maximum time (in milliseconds) to wait for an automatic post-output compile before giving up.',
      category: 'workflow',
      slot: 'workspaceState',
      surfaces: { cliConfig: true },
    }),
  },
  {
    label: 'Open the compiled PDF',
    row: surfacedSetting({
      key: DocumentsStateKey.WORKFLOW_AUTO_OPEN_PDF,
      schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoOpenPdf),
      title: 'Open the compiled PDF',
      description:
        'After auto-compile, open the PDF when it succeeds or the LaTeX log when it fails.',
      category: 'workflow',
      slot: 'workspaceState',
      // Read by the documents plugin, but the emitted `requestOpenFile` has no
      // CLI handler (headless), so the CLI ignores it.
      surfaces: { settingsView: 'latex' },
    }),
  },
  {
    label: 'Repair failed compiles',
    row: surfacedSetting({
      key: DocumentsStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
      schema: z
        .boolean()
        .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
      title: 'Repair failed compiles',
      description:
        'When the automatic compile fails, spend the next revision repairing the output from the compile log.',
      category: 'workflow',
      slot: 'workspaceState',
      surfaces: { settingsView: 'latex', cliConfig: true },
    }),
  },
  // Run by the documents plugin, so every host honors them. The timeout is
  // kept out of the settings view (an insider knob) and edited from CLI
  // `/config`; the rest are deferred from `/config` by product decision.
  {
    label: 'Diff consecutive revisions',
    row: surfacedSetting({
      key: DocumentsStateKey.LATEXDIFF_BETWEEN_ROUNDS,
      schema: z
        .boolean()
        .prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
      title: 'Diff consecutive revisions',
      description:
        'Also diff each revision against the previous one, not only against your original input.',
      category: 'latexdiff',
      slot: 'workspaceState',
      surfaces: { settingsView: 'latex' },
    }),
  },
  {
    label: 'latexdiff timeout',
    row: surfacedSetting({
      key: DocumentsStateKey.LATEXDIFF_TIMEOUT_MS,
      schema: z
        .int()
        .min(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.min)
        .max(LATEX_CONFIG_RANGES.latexdiffTimeoutMs.max)
        .prefault(LATEX_CONFIG_DEFAULTS.latexdiffTimeoutMs),
      title: 'latexdiff timeout',
      description:
        'Maximum time (in milliseconds) to allow a single latexdiff invocation to run.',
      category: 'latexdiff',
      slot: 'workspaceState',
      surfaces: { cliConfig: true },
    }),
  },
  {
    label: 'Math markup in diffs',
    row: surfacedSetting({
      key: DocumentsStateKey.LATEXDIFF_MATH_MARKUP,
      schema: z
        .enum(LATEXDIFF_MATH_MARKUP_VALUES)
        .prefault(LATEX_CONFIG_DEFAULTS.latexdiffMathMarkup),
      title: 'Math markup in diffs',
      description: 'How latexdiff marks up changes inside math environments.',
      category: 'latexdiff',
      slot: 'workspaceState',
      enumDescriptions: [
        'suppress markup',
        'equation-level',
        'within equations',
        'small changes inside equations',
      ],
      surfaces: { settingsView: 'latex' },
    }),
  },
  {
    label: 'Only changed pages in diff PDFs',
    row: surfacedSetting({
      key: DocumentsStateKey.LATEXDIFF_CHANGES_ONLY,
      schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly),
      title: 'Only changed pages in diff PDFs',
      description:
        'Compile diff PDFs with only the pages that contain edits, instead of the full document.',
      category: 'latexdiff',
      slot: 'workspaceState',
      surfaces: { settingsView: 'latex' },
    }),
  },
];
