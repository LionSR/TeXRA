/**
 * TeXRA's own setting rows and keys, and the static catalog its settings
 * surfaces read: the harness's rows (`@shared/state/stateSettings`), these,
 * and the rows its plugins declare (`./integrationSettings`). The hosts pass
 * {@link TEXRA_SETTING_ROWS} to `installProcessRuntime`, which adds the rows
 * on their plugin values; the webview and the CLI, which render the catalog
 * before or without a runtime, read {@link TEXRA_SETTINGS}.
 *
 * Owner by key: the CLI's startup rows (`agent`, `model`, `chat`, `run`,
 * `outputFormat`), `agentOutputs.autoOpenFinal`, the bibliography
 * (`bib.*`), LaTeX (`latex.*`, `latexdiff.*`, the formatter), the documents
 * plugin's compile rows (`workflow.*`), inline criticism and telemetry.
 */

// Third-party imports
import { z } from 'zod';

// Local imports
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_CONFIG_RANGES,
  LATEX_FORMATTER_VALUES,
  LATEXDIFF_MATH_MARKUP_VALUES,
} from '@shared/constants/latexConfig';
import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@shared/constants/replacementCategories';
import {
  CliOutputFormatSchema,
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  TELEMETRY_ENABLED_DEFAULT,
} from '@shared/schemas';
import {
  CLAUDE_AGENT_SETTINGS,
  CODEX_SETTINGS,
} from '@shared/settingsView/integrationSettings';
import {
  configTreeRows,
  settingsCatalog,
  surfacedSetting,
  type SettingsCatalog,
  type StateSettingEntry,
} from '@shared/state/stateSettings';

/** TeXRA's state keys: the documents plugin's and LaTeX's, inline criticism and telemetry. */
export enum TexraStateKey {
  // Workspace-scoped: compile and diff after a document round
  WORKFLOW_AUTO_COMPILE = 'texra.workflow.autoCompileAfterOutput',
  WORKFLOW_AUTO_COMPILE_TIMEOUT_MS = 'texra.workflow.autoCompileTimeoutMs',
  WORKFLOW_AUTO_OPEN_PDF = 'texra.workflow.autoOpenPdf',
  WORKFLOW_REJECT_ON_COMPILE_FAILURE = 'texra.workflow.rejectOnCompileFailure',
  LATEXDIFF_BETWEEN_ROUNDS = 'texra.latexdiff.generateBetweenRoundDiffs',
  LATEXDIFF_TIMEOUT_MS = 'texra.latexdiff.timeoutMs',
  LATEXDIFF_MATH_MARKUP = 'texra.latexdiff.mathMarkup',
  LATEXDIFF_CHANGES_ONLY = 'texra.latexdiff.changesOnly',
  LATEX_FORMATTER = 'texra.latex.formatter',

  // Global
  INLINE_CRITICISM_ENABLED = 'texra.inlineCriticism.enabled',
  /** Random anonymous telemetry install ID (UUIDv4); deleting the key resets it. */
  TELEMETRY_INSTALL_ID = 'texra.telemetry.installId',
  /** Set once the first-run telemetry notice has been shown on this host. */
  TELEMETRY_NOTICE_SHOWN = 'texra.telemetry.noticeShown',
}

/** Standalone preamble used when extracting a TikZ figure for compilation. */
const DEFAULT_TIKZ_TEMPLATE =
  '\\documentclass[tikz,border=10pt]{standalone}\n' +
  '\\usepackage{tikz}\n' +
  '\\usepackage{pgfplots}\n' +
  '\\usetikzlibrary{positioning}\n' +
  '\\usetikzlibrary{patterns}\n' +
  '\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n' +
  '\\usetikzlibrary{shapes, arrows}\n\n' +
  '\\begin{document}\n' +
  '{{ tikzpicture }}\n' +
  '\\end{document}';

// The terminal client's own `.texra/config.json` rows (`agent`, `model`,
// `chat`, `run`, `outputFormat`): which agent and model a command starts with,
// and how it prints. Only the CLI runtime reads them; the extension and desktop
// resolve an agent and a model from their own surfaces.

/** An agent key or name, as typed into `.texra/config.json`. */
const CliAgentSchema = z.string().trim().min(1).optional();

/** A model id, validated against the model registry where it is used. */
const CliModelSchema = z.string().trim().min(1).optional();

/** Per-command overrides of the top-level `agent`/`model` rows. */
const CliCommandDefaultsSchema = z
  .object({ agent: CliAgentSchema, model: CliModelSchema })
  .optional();

/** TeXRA's config-file-backed rows, keyed by their dotted path under `texra.`. */
const TEXRA_CONFIG_ROWS: Record<
  string,
  Omit<StateSettingEntry, 'key' | 'slot'>
> = {
  agent: {
    schema: CliAgentSchema,
    title: 'Default agent',
    description:
      'Agent `texra chat` and `texra run` start with when neither `--agent` nor a per-command default names one.',
  },
  model: {
    schema: CliModelSchema,
    title: 'Default model',
    description:
      'Model every `texra` command starts with when neither `--model`, `TEXRA_MODEL`, nor a per-command default names one. A model this machine cannot run falls back to an available one with a notice.',
  },
  chat: {
    schema: CliCommandDefaultsSchema,
    title: 'Chat defaults',
    description:
      'Agent and model `texra chat` starts with, overriding the top-level defaults.',
  },
  run: {
    schema: CliCommandDefaultsSchema,
    title: 'Run defaults',
    description:
      'Agent and model `texra run` starts with, overriding the top-level defaults.',
  },
  outputFormat: {
    schema: CliOutputFormatSchema,
    title: 'Output format',
    description:
      'How `texra` prints results: human text, one JSON object, or NDJSON records. `--output-format` and `TEXRA_OUTPUT_FORMAT` override it.',
  },
  'agentOutputs.autoOpenFinal': {
    schema: z.boolean().prefault(true),
    description:
      "When a workflow run completes, automatically preview the final revised file in a new editor tab. Disable for batch runs when you don't want a tab to steal focus.",
  },
  'bib.defaultPath': {
    schema: z.string().prefault(''),
    description:
      'Default path to bibliography file (.bib). This is used by bibliography tools when no explicit path is provided. Supports Zotero auto-exported .bib files.',
  },
  'bib.zoteroPort': {
    schema: z.int().min(1).max(65535).prefault(23119),
    description:
      'Port number for Zotero integration (default: 23119). Used by both the Connector API and Better BibTeX JSON-RPC.',
  },
  'latex.latexindentConfig': {
    schema: z.string().prefault(''),
    description: 'Path to latexindent configuration file',
  },
  'latex.texfmtConfig': {
    schema: z.string().prefault(''),
    description: 'Path to tex-fmt configuration file',
  },
  'latex.tikzInputDirectory': {
    schema: z.string().prefault(''),
    description:
      'Directory where to look for extra input files when compiling extracted TikZ figures. Absolute path is required. Sets TEXINPUTS environment variable for TikZ compilation.',
  },
  'latex.includeWorkspaceInTexinputs': {
    schema: z.boolean().prefault(true),
    description:
      'Include the workspace root directory in TEXINPUTS when compiling TikZ figures',
  },
  'latex.tikzTemplate': {
    schema: z.string().prefault(DEFAULT_TIKZ_TEMPLATE),
    description:
      'Template used for generating standalone documents when extracting and compiling TikZ figures',
  },
  'latex.wrapCritiqueInAlign': {
    schema: z.boolean().prefault(true),
    title: 'Wrap criticism in align environments',
    description:
      'Wrap bare criticism and comment commands inside align environments with intertext.',
    category: 'latex',
  },
  'latex.enabledReplacements': {
    schema: z
      .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
      .prefault(DEFAULT_ENABLED_REPLACEMENTS),
    title: 'Literal replacement groups',
    description: 'Enabled groups of direct LaTeX cleanup replacements.',
    category: 'latex',
  },
  'latex.enabledReplacementsRegex': {
    schema: z
      .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
      .prefault(DEFAULT_ENABLED_REGEX_REPLACEMENTS),
    title: 'Pattern replacement groups',
    description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
    category: 'latex',
  },
  'latex.customReplacementsRegex': {
    schema: z.record(z.string(), z.string()).prefault({}),
    title: 'Custom pattern replacements',
    description: 'Custom regular-expression replacements.',
    category: 'latex',
  },
  'latex.customReplacements': {
    schema: z.record(z.string(), z.string()).prefault({}),
    title: 'Custom literal replacements',
    description: 'Custom direct text replacements.',
    category: 'latex',
  },
  'latexdiff.tempFileLocation': {
    schema: z.enum(LATEXDIFF_TEMP_FILE_LOCATIONS).prefault('sameDirectory'),
    description:
      'Where to create temporary files for LaTeX preview and diff operations during tool edit approval.',
    enumDescriptions: [
      'Create temp files in the same directory as the original file. Best for resolving \\input{} and relative paths.',
      'Create temp files in .texra-temp directory at workspace root. Keeps source directories clean but may break relative paths.',
    ],
  },
  'telemetry.enabled': {
    schema: z.boolean().prefault(TELEMETRY_ENABLED_DEFAULT),
    title: 'Share usage telemetry',
    description:
      'Send anonymous model, agent, token, timing, and host metadata with a random install ID (no account). TeXRA never sends prompt text, document content, or file names. Turning this off stops all reporting.',
    category: 'privacy',
    configTarget: 'global',
    projectMayOptOut: true,
    surfaces: { settingsView: 'telemetry' },
  },
};

/** TeXRA's own rows (its plugins' are on their `Plugin` values), in catalog order. */
export const TEXRA_SETTING_ROWS: readonly StateSettingEntry[] = [
  ...configTreeRows(TEXRA_CONFIG_ROWS),
  // --- Workflow auto-compile -------------------------------------------------
  surfacedSetting({
    key: TexraStateKey.WORKFLOW_AUTO_COMPILE,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.workflowAutoCompile),
    title: 'Auto-compile outputs',
    description:
      'Compile the LaTeX project automatically after an agent writes its output.',
    category: 'workflow',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),
  surfacedSetting({
    key: TexraStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
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
  surfacedSetting({
    key: TexraStateKey.WORKFLOW_AUTO_OPEN_PDF,
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
  surfacedSetting({
    key: TexraStateKey.WORKFLOW_REJECT_ON_COMPILE_FAILURE,
    schema: z
      .boolean()
      .prefault(LATEX_CONFIG_DEFAULTS.workflowRejectOnCompileFailure),
    title: 'Repair failed compiles',
    description:
      'When the automatic compile fails, spend the next planned round repairing the output from the compile log.',
    category: 'workflow',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex', cliConfig: true },
  }),

  // --- LaTeXdiff -------------------------------------------------------------
  // Run by the documents plugin, so every host honors them. The timeout is
  // kept out of the settings view (an insider knob) and edited from CLI
  // `/config`; the rest are deferred from `/config` by product decision.
  surfacedSetting({
    key: TexraStateKey.LATEXDIFF_BETWEEN_ROUNDS,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffBetweenRounds),
    title: 'Diff consecutive rounds',
    description:
      'Also diff each agent round against the previous one, not only against your original input.',
    category: 'latexdiff',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex' },
  }),
  surfacedSetting({
    key: TexraStateKey.LATEXDIFF_TIMEOUT_MS,
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
  surfacedSetting({
    key: TexraStateKey.LATEXDIFF_MATH_MARKUP,
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
  surfacedSetting({
    key: TexraStateKey.LATEXDIFF_CHANGES_ONLY,
    schema: z.boolean().prefault(LATEX_CONFIG_DEFAULTS.latexdiffChangesOnly),
    title: 'Only changed pages in diff PDFs',
    description:
      'Compile diff PDFs with only the pages that contain edits, instead of the full document.',
    category: 'latexdiff',
    slot: 'workspaceState',
    surfaces: { settingsView: 'latex' },
  }),

  // --- LaTeX formatter -------------------------------------------------------
  surfacedSetting({
    key: TexraStateKey.LATEX_FORMATTER,
    schema: z
      .enum(LATEX_FORMATTER_VALUES)
      .prefault(LATEX_CONFIG_DEFAULTS.latexFormatter),
    title: 'LaTeX formatter',
    description: 'Which formatter to run when formatting LaTeX source.',
    category: 'latex',
    slot: 'workspaceState',
    enumLabels: ['latexindent', 'tex-fmt', 'None'],
    enumDescriptions: [
      'needs Perl',
      'standalone Rust binary',
      'leave formatting unchanged',
    ],
    surfaces: { settingsView: 'latex' },
  }),

  // --- Inline criticism -------------------------------------------------------
  // Editor squiggles and Problems-panel entries exist only in VS Code. The
  // shared LaTeX snapshot reads the row on every host; the desktop LaTeX page
  // hides it.
  surfacedSetting({
    key: TexraStateKey.INLINE_CRITICISM_ENABLED,
    schema: z.boolean().prefault(false),
    title: 'Show criticism as editor diagnostics',
    description:
      'Show \\criticize{message}{severity}{confidence} annotations from agent-revised LaTeX files as squiggles and Problems-panel entries.',
    category: 'latex',
    slot: 'globalState',
    surfaces: { settingsView: 'latex' },
  }),
];

/** The whole catalog TeXRA's settings surfaces render: the harness's rows, TeXRA's and its plugins'. */
export const TEXRA_SETTINGS: SettingsCatalog = settingsCatalog(
  TEXRA_SETTING_ROWS,
  [{ settings: CODEX_SETTINGS }, { settings: CLAUDE_AGENT_SETTINGS }],
);
