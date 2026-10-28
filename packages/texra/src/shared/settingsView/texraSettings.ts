/**
 * TeXRA's own setting rows and keys, and the static catalog its settings
 * surfaces read: the harness's rows (`@shared/state/stateSettings`), these,
 * and the rows its plugins declare (`./documentsSettings`,
 * `./integrationSettings`). Every host's config carries {@link TEXRA_SETTINGS}
 * (`ConfigProvider.catalog`), and the settings surfaces read it.
 *
 * Owner by key: the CLI's startup rows (`agent`, `model`, `chat`, `run`,
 * `outputFormat`), `agentOutputs.autoOpenFinal`, the bibliography
 * (`bib.*`), LaTeX (`latex.*`, `latexdiff.tempFileLocation`, the
 * formatter), inline criticism and telemetry.
 */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import {
  configTreeRows,
  settingsCatalog,
  type SettingsCatalog,
  type StateSettingEntry,
} from '@texra-ai/harness/schemas';
import { CliOutputFormatSchema } from '@texra/shared/cliOutputFormat';
import {
  LATEX_CONFIG_DEFAULTS,
  LATEX_FORMATTER_VALUES,
} from '@texra/shared/constants/latexConfig';
import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@texra/shared/constants/replacementCategories';
import { DOCUMENTS_SETTINGS } from '@texra/shared/settingsView/documentsSettings';
import {
  CLAUDE_AGENT_SETTINGS,
  CODEX_SETTINGS,
} from '@texra/shared/settingsView/integrationSettings';
import type { SurfacedSettingEntry } from '@texra-ai/harness/schemas';

/** TeXRA's state keys: LaTeX's, inline criticism and telemetry. */
export const TexraStateKey = Object.freeze({
  LATEX_FORMATTER: 'texra.latex.formatter',

  // Global
  INLINE_CRITICISM_ENABLED: 'texra.inlineCriticism.enabled',
  /** Random anonymous telemetry install ID (UUIDv4); deleting the key resets it. */
  TELEMETRY_INSTALL_ID: 'texra.telemetry.installId',
  /** Set once the first-run telemetry notice has been shown on this host. */
  TELEMETRY_NOTICE_SHOWN: 'texra.telemetry.noticeShown',
} as const);
export type TexraStateKey = (typeof TexraStateKey)[keyof typeof TexraStateKey];

/** Canonical config key for the usage-telemetry opt-in. */
export const TELEMETRY_ENABLED_KEY = 'texra.telemetry.enabled';

export const LATEXDIFF_TEMP_FILE_LOCATIONS = [
  'sameDirectory',
  'workspaceTemp',
] as const;

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
const CliAgentSchema = Schema.optional(
  Schema.Trim.check(Schema.isMinLength(1)),
);

/** A model id, validated against the model registry where it is used. */
const CliModelSchema = Schema.optional(
  Schema.Trim.check(Schema.isMinLength(1)),
);

/** `texra chat`'s overrides of the top-level `agent`/`model` rows. */
const CliChatDefaultsSchema = Schema.optional(
  Schema.Struct({ agent: CliAgentSchema, model: CliModelSchema }),
);

/** `texra run`'s override of the top-level `model` row; its agent is an argument. */
const CliRunDefaultsSchema = Schema.optional(
  Schema.Struct({ model: CliModelSchema }),
);

/** TeXRA's config-file-backed rows, keyed by their dotted path under `texra.`. */
const TEXRA_CONFIG_ROWS: Record<
  string,
  Omit<StateSettingEntry, 'key' | 'slot'>
> = {
  agent: {
    schema: CliAgentSchema,
    description:
      'Agent `texra chat` starts with when neither `--agent` nor `texra.chat.agent` names one.',
  },
  model: {
    schema: CliModelSchema,
    description:
      'Model every `texra` command starts with when neither `--model`, `TEXRA_MODEL`, nor a per-command default names one. A model this machine cannot run falls back to an available one with a notice.',
  },
  chat: {
    schema: CliChatDefaultsSchema,
    description:
      'Agent and model `texra chat` starts with, overriding the top-level defaults.',
  },
  run: {
    schema: CliRunDefaultsSchema,
    description:
      'Model `texra run` starts with, overriding the top-level `texra.model`.',
  },
  outputFormat: {
    schema: CliOutputFormatSchema,
    description:
      'How `texra` prints results: human text, one JSON object, or NDJSON records. `--output-format` and `TEXRA_OUTPUT_FORMAT` override it.',
  },
  'agentOutputs.autoOpenFinal': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    description:
      "When a document task completes, automatically preview the final revised file in a new editor tab. Disable for batch runs when you don't want a tab to steal focus.",
  },
  'bib.defaultPath': {
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    description:
      'Default path to bibliography file (.bib). This is used by bibliography tools when no explicit path is provided. Supports Zotero auto-exported .bib files.',
  },
  'bib.zoteroPort': {
    schema: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
      .check(Schema.isLessThanOrEqualTo(65535))
      .pipe(Schema.withDecodingDefault(Effect.succeed(23119))),
    description:
      'Port number for Zotero integration (default: 23119). Used by both the Connector API and Better BibTeX JSON-RPC.',
  },
  'latex.latexindentConfig': {
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    description: 'Path to latexindent configuration file',
  },
  'latex.texfmtConfig': {
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    description: 'Path to tex-fmt configuration file',
  },
  'latex.tikzInputDirectory': {
    schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
    description:
      'Directory where to look for extra input files when compiling extracted TikZ figures. Absolute path is required. Sets TEXINPUTS environment variable for TikZ compilation.',
  },
  'latex.includeWorkspaceInTexinputs': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    description:
      'Include the workspace root directory in TEXINPUTS when compiling TikZ figures',
  },
  'latex.tikzTemplate': {
    schema: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIKZ_TEMPLATE)),
    ),
    description:
      'Template used for generating standalone documents when extracting and compiling TikZ figures',
  },
  'latex.wrapCritiqueInAlign': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    description:
      'Wrap bare criticism and comment commands inside align environments with intertext.',
  },
  'latex.enabledReplacements': {
    schema: Schema.Array(
      Schema.Literals(NON_REGEX_REPLACEMENT_CATEGORIES),
    ).pipe(
      Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENABLED_REPLACEMENTS)),
    ),
    description: 'Enabled groups of direct LaTeX cleanup replacements.',
  },
  'latex.enabledReplacementsRegex': {
    schema: Schema.Array(Schema.Literals(REGEX_REPLACEMENT_CATEGORIES)).pipe(
      Schema.withDecodingDefault(
        Effect.succeed(DEFAULT_ENABLED_REGEX_REPLACEMENTS),
      ),
    ),
    description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
  },
  'latex.customReplacementsRegex': {
    schema: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
    description: 'Custom regular-expression replacements.',
  },
  'latex.customReplacements': {
    schema: Schema.Record(Schema.String, Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed({})),
    ),
    description: 'Custom direct text replacements.',
  },
  'latexdiff.tempFileLocation': {
    schema: Schema.Literals(LATEXDIFF_TEMP_FILE_LOCATIONS).pipe(
      Schema.withDecodingDefault(Effect.succeed('sameDirectory')),
    ),
    description:
      'Where to create temporary files for LaTeX preview and diff operations during tool edit approval.',
  },
  'telemetry.enabled': {
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
    ),
    title: 'Share usage telemetry',
    description:
      'Send anonymous model, agent, token, timing, and host metadata with a random install ID (no account). TeXRA never sends prompt text, document content, or file names. Turning this off stops all reporting.',
    category: 'privacy',
    configTarget: 'global',
    projectMayOptOut: true,
    surfaces: { settingsView: 'telemetry' },
  },
};

/** TeXRA's rows, its plugins' last, in catalog order. */
const TEXRA_SETTING_ROWS: readonly StateSettingEntry[] = [
  ...configTreeRows(TEXRA_CONFIG_ROWS),
  // --- LaTeX formatter -------------------------------------------------------
  {
    key: TexraStateKey.LATEX_FORMATTER,
    schema: Schema.Literals(LATEX_FORMATTER_VALUES).pipe(
      Schema.withDecodingDefault(
        Effect.succeed(LATEX_CONFIG_DEFAULTS.latexFormatter),
      ),
    ),
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
  } satisfies SurfacedSettingEntry,

  // --- Inline criticism -------------------------------------------------------
  // Editor squiggles and Problems-panel entries exist only in VS Code. The
  // shared LaTeX snapshot reads the row on every host; the desktop LaTeX page
  // hides it.
  {
    key: TexraStateKey.INLINE_CRITICISM_ENABLED,
    schema: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
    ),
    title: 'Show criticism as editor diagnostics',
    description:
      'Show \\criticize{message}{severity}{confidence} annotations from agent-revised LaTeX files as squiggles and Problems-panel entries.',
    category: 'latex',
    slot: 'globalState',
    surfaces: { settingsView: 'latex' },
  } satisfies SurfacedSettingEntry,

  // --- Plugins' rows ----------------------------------------------------------
  ...DOCUMENTS_SETTINGS,
  ...[...CODEX_SETTINGS, ...CLAUDE_AGENT_SETTINGS].map(({ row }) => row),
];

/** The whole catalog TeXRA's settings surfaces render: the harness's rows and TeXRA's. */
export const TEXRA_SETTINGS: SettingsCatalog =
  settingsCatalog(TEXRA_SETTING_ROWS);
