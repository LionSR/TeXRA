/**
 * TeXRA's own setting rows, and the static catalog its settings surfaces
 * read: the harness's rows (`@shared/state/stateSettings`), these, and the
 * rows its plugins declare (`./latexdiffSettings`, `./integrationSettings`).
 * Every host's config carries the catalog ({@link TEXRA_SETTINGS}`.catalog`,
 * `ConfigProvider.catalog`); the settings surfaces read the placed rows
 * beside it, where each row's placement is the row's own or, for a harness
 * row, the one `./settingSurfaces` gives it.
 *
 * Owner by key: the CLI's startup rows (`model`, `chat`, `run`,
 * `outputFormat`), the bibliography
 * (`bib.*`), LaTeX (`latex.*`, the formatter), inline criticism,
 * telemetry and the project's agent (`projectAgent.runId`).
 */

// Third-party imports
import { Schema } from 'effect';
import type { UsageLogEntry } from '@texra-ai/worldline/host';
import {
  decodingDefault,
  GIT_AUTHOR_EMAIL_SETTING,
  GIT_AUTHOR_NAME_SETTING,
  HELPER_MODEL_SETTING,
  RunIdSchema,
  settingsCatalog,
  type RunId,
  type SettingRow,
  type SettingsCatalog,
} from '@texra-ai/worldline/schemas';

// Local imports
import { CliOutputFormatSchema } from '@texra/shared/cliOutputFormat';
import { CURATED_MODELS } from '@texra/model/curatedModels';
import { LATEX_FORMATTER_VALUES } from '@texra/shared/constants/latexConfig';
import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@texra/shared/constants/replacementCategories';
import { LATEXDIFF_SETTINGS } from '@texra/shared/settings/latexdiffSettings';
import {
  CLAUDE_AGENT_SETTINGS,
  CODEX_SETTINGS,
} from '@texra/shared/settings/integrationSettings';
import {
  HARNESS_ROW_SURFACES,
  type SettingsViewRow,
  type TexraSettingRow,
} from '@texra/shared/settings/settingSurfaces';
import type { SettingsViewSnapshot } from '@texra/shared/settingsView/settingsViewMessages';

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

// The terminal client's own `.texra/config.json` rows (`model`, `chat`,
// `run`, `outputFormat`): which model a command starts with, and how it
// prints. Only the CLI runtime reads them; the extension and desktop resolve
// a model from their own surfaces.

/** A model id, validated against the model registry where it is used. */
const CliModelSchema = Schema.optional(
  Schema.Trim.check(Schema.isMinLength(1)),
);

export const CLI_MODEL_SETTING = Object.freeze({
  key: 'model',
  slot: 'config',
  schema: CliModelSchema,
  title: 'Default model',
  description:
    'Default model for `texra` commands when not set by `--model`, `TEXRA_MODEL`, or a command default.',
} as const satisfies SettingRow<string | undefined>);

/** `texra chat`'s override of the top-level `model` row. */
export const CLI_CHAT_SETTING = Object.freeze({
  key: 'chat',
  slot: 'config',
  schema: Schema.optional(Schema.Struct({ model: CliModelSchema })),
  title: 'Chat defaults',
  description:
    'Model `texra chat` starts with, overriding the top-level `texra.model`.',
} as const satisfies SettingRow<{ readonly model?: string } | undefined>);

/** `texra run`'s override of the top-level `model` row. */
export const CLI_RUN_SETTING = Object.freeze({
  key: 'run',
  slot: 'config',
  schema: Schema.optional(Schema.Struct({ model: CliModelSchema })),
  title: 'Run defaults',
  description:
    'Model `texra run` starts with, overriding the top-level `texra.model`.',
} as const satisfies SettingRow<{ readonly model?: string } | undefined>);

export const CLI_OUTPUT_FORMAT_SETTING = Object.freeze({
  key: 'outputFormat',
  slot: 'config',
  schema: CliOutputFormatSchema,
  title: 'Output format',
  description:
    'Default CLI output format: text, json, or ndjson. `--output-format` and `TEXRA_OUTPUT_FORMAT` override it.',
} as const satisfies SettingRow<typeof CliOutputFormatSchema.Type>);

export const BIB_DEFAULT_PATH_SETTING = Object.freeze({
  key: 'bib.defaultPath',
  slot: 'config',
  schema: decodingDefault(Schema.String, ''),
  title: 'Default bibliography file',
  description:
    'Default .bib file path for citation search (supports Zotero auto-export).',
} as const satisfies SettingRow<string>);

export const LATEXINDENT_CONFIG_SETTING = Object.freeze({
  key: 'latex.latexindentConfig',
  slot: 'config',
  schema: decodingDefault(Schema.String, ''),
  title: 'latexindent configuration file',
  description: 'Optional config file path passed to latexindent.',
} as const satisfies SettingRow<string>);

export const TEXFMT_CONFIG_SETTING = Object.freeze({
  key: 'latex.texfmtConfig',
  slot: 'config',
  schema: decodingDefault(Schema.String, ''),
  title: 'tex-fmt configuration file',
  description: 'Optional config file path passed to tex-fmt.',
} as const satisfies SettingRow<string>);

export const TIKZ_INPUT_DIRECTORY_SETTING = Object.freeze({
  key: 'latex.tikzInputDirectory',
  slot: 'config',
  schema: decodingDefault(Schema.String, ''),
  title: 'TikZ input directory',
  description:
    'Extra absolute directory added to TEXINPUTS when compiling TikZ figures.',
} as const satisfies SettingRow<string>);

export const INCLUDE_WORKSPACE_IN_TEXINPUTS_SETTING = Object.freeze({
  key: 'latex.includeWorkspaceInTexinputs',
  slot: 'config',
  schema: decodingDefault(Schema.Boolean, true),
  title: 'Project root in TEXINPUTS',
  description:
    'Include the project root in TEXINPUTS when compiling TikZ figures.',
} as const satisfies SettingRow<boolean>);

export const TIKZ_TEMPLATE_SETTING = Object.freeze({
  key: 'latex.tikzTemplate',
  slot: 'config',
  schema: decodingDefault(Schema.String, DEFAULT_TIKZ_TEMPLATE),
  title: 'TikZ template',
  description:
    'Standalone LaTeX template used when extracting and compiling TikZ figures.',
} as const satisfies SettingRow<string>);

export const ENABLED_REPLACEMENTS_SETTING = Object.freeze({
  key: 'latex.enabledReplacements',
  slot: 'config',
  schema: decodingDefault(
    Schema.Array(Schema.Literals(NON_REGEX_REPLACEMENT_CATEGORIES)),
    DEFAULT_ENABLED_REPLACEMENTS,
  ),
  title: 'Cleanup replacements',
  description: 'Enabled groups of direct LaTeX cleanup replacements.',
} as const satisfies SettingRow<
  readonly (typeof NON_REGEX_REPLACEMENT_CATEGORIES)[number][]
>);

export const ENABLED_REGEX_REPLACEMENTS_SETTING = Object.freeze({
  key: 'latex.enabledReplacementsRegex',
  slot: 'config',
  schema: decodingDefault(
    Schema.Array(Schema.Literals(REGEX_REPLACEMENT_CATEGORIES)),
    DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  ),
  title: 'Pattern cleanup replacements',
  description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
} as const satisfies SettingRow<
  readonly (typeof REGEX_REPLACEMENT_CATEGORIES)[number][]
>);

export const CUSTOM_REGEX_REPLACEMENTS_SETTING = Object.freeze({
  key: 'latex.customReplacementsRegex',
  slot: 'config',
  schema: decodingDefault(Schema.Record(Schema.String, Schema.String), {}),
  title: 'Custom pattern replacements',
  description: 'Custom regular-expression replacements.',
} as const satisfies SettingRow<Readonly<Record<string, string>>>);

export const CUSTOM_REPLACEMENTS_SETTING = Object.freeze({
  key: 'latex.customReplacements',
  slot: 'config',
  schema: decodingDefault(Schema.Record(Schema.String, Schema.String), {}),
  title: 'Custom replacements',
  description: 'Custom direct text replacements.',
} as const satisfies SettingRow<Readonly<Record<string, string>>>);

/**
 * What each field of a usage record is, in the words every surface uses, in
 * the order the sentence lists them. It is total over the record the sender
 * queues (`UsageLogEntrySchema`): a field added to the wire does not compile
 * until it is worded here, and a field that leaves the wire leaves the
 * sentence.
 */
const USAGE_RECORD_WORDING = {
  agentName: 'program name',
  model: 'model',
  provider: 'provider API',
  usageRoute: 'billing route',
  inputTokens: 'token counts',
  outputTokens: 'token counts',
  cachedInputTokens: 'token counts',
  reasoningTokens: 'token counts',
  listCost: 'cost at list prices',
  responseTimeMs: 'response time',
  timestamp: 'time of the call',
  streamId: 'task ID',
  extensionVersion: 'version',
  editorType: 'app',
} as const satisfies Record<keyof UsageLogEntry, string>;

/**
 * What usage logging sends and what it never does: the one statement the
 * setting, the first-run notice and `texra doctor` show.
 * The install ID is the request's header, not a field of the record.
 */
export const USAGE_LOGGING_SENDS = `TeXRA sends anonymous usage metadata (${[
  ...new Set(Object.values(USAGE_RECORD_WORDING)),
].join(
  ', ',
)}) with a random install ID and no account. It never sends prompts, document content, file paths or error text.`;

/** The usage-telemetry opt-in. */
export const TELEMETRY_ENABLED_SETTING = Object.freeze({
  key: 'telemetry.enabled',
  slot: 'config',
  schema: decodingDefault(Schema.Boolean, true),
  title: 'Share usage telemetry',
  description: `${USAGE_LOGGING_SENDS} Turning this off stops all reporting.`,
  category: 'privacy',
  configTarget: 'global',
  projectMayOptOut: true,
  surfaces: Object.freeze({ settingsView: 'telemetry' }),
} as const satisfies TexraSettingRow<boolean>);

export const LATEX_FORMATTER_SETTING = Object.freeze({
  key: 'latex.formatter',
  schema: decodingDefault(
    Schema.Literals(LATEX_FORMATTER_VALUES),
    'latexindent',
  ),
  title: 'LaTeX formatter',
  description: 'Which formatter to run when formatting LaTeX source.',
  category: 'latex',
  slot: 'workspaceState',
  choices: Object.freeze({
    latexindent: Object.freeze({ description: 'needs Perl' }),
    'tex-fmt': Object.freeze({ description: 'standalone Rust binary' }),
    none: Object.freeze({
      label: 'None',
      description: 'leave formatting unchanged',
    }),
  }),
  surfaces: Object.freeze({ settingsView: 'latex' }),
} as const satisfies TexraSettingRow<(typeof LATEX_FORMATTER_VALUES)[number]>);

/**
 * Editor squiggles and Problems-panel entries exist only in VS Code. The
 * shared LaTeX snapshot reads the row on every host; the desktop LaTeX page
 * hides it.
 */
export const INLINE_CRITICISM_SETTING = Object.freeze({
  key: 'inlineCriticism.enabled',
  schema: decodingDefault(Schema.Boolean, false),
  title: 'Show criticism as editor diagnostics',
  description:
    'Highlight \\criticize annotations in revised LaTeX files as editor diagnostics.',
  category: 'latex',
  slot: 'globalState',
  surfaces: Object.freeze({ settingsView: 'latex' }),
} as const satisfies TexraSettingRow<boolean>);

/** TeXRA's rows no TeXRA UI shows, in catalog order. */
/** The audio tools' SoX binary, when automatic detection should not decide. */
export const SOX_PATH_SETTING = Object.freeze({
  key: 'audio.soxPath',
  slot: 'config',
  schema: decodingDefault(Schema.String, ''),
  title: 'SoX path',
  description: 'Path to the SoX executable. Overrides automatic detection.',
} as const satisfies SettingRow<string>);

/**
 * The project's agent: the run of the conversation a person last started in
 * the project, which every host opens the project on. Set when that
 * conversation's first message starts its run, cleared by Start over (a new
 * conversation) and when the run is gone; never repaired. The app owns it
 * (`packages/texra/src/controllers/session/projectAgent.ts`); the harness
 * does not read it.
 */
export const PROJECT_AGENT_SETTING = Object.freeze({
  key: 'projectAgent.runId',
  slot: 'workspaceState',
  schema: decodingDefault(Schema.NullOr(RunIdSchema), null),
  title: "Project's agent",
  description:
    'The conversation this project opens on, until Start over begins a new one.',
} as const satisfies SettingRow<RunId | null>);

const TEXRA_UNSHOWN_ROWS: readonly SettingRow[] = [
  PROJECT_AGENT_SETTING,
  SOX_PATH_SETTING,
  CLI_MODEL_SETTING,
  CLI_CHAT_SETTING,
  CLI_RUN_SETTING,
  CLI_OUTPUT_FORMAT_SETTING,
  BIB_DEFAULT_PATH_SETTING,
  LATEXINDENT_CONFIG_SETTING,
  TEXFMT_CONFIG_SETTING,
  TIKZ_INPUT_DIRECTORY_SETTING,
  INCLUDE_WORKSPACE_IN_TEXINPUTS_SETTING,
  TIKZ_TEMPLATE_SETTING,
  ENABLED_REPLACEMENTS_SETTING,
  ENABLED_REGEX_REPLACEMENTS_SETTING,
  CUSTOM_REGEX_REPLACEMENTS_SETTING,
  CUSTOM_REPLACEMENTS_SETTING,
];

/** TeXRA's rows a TeXRA UI shows, its plugins' last, in catalog order. */
const TEXRA_PLACED_ROWS: readonly TexraSettingRow[] = [
  TELEMETRY_ENABLED_SETTING,
  LATEX_FORMATTER_SETTING,
  INLINE_CRITICISM_SETTING,
  ...LATEXDIFF_SETTINGS,
  ...[...CODEX_SETTINGS, ...CLAUDE_AGENT_SETTINGS].map(({ row }) => row),
];

/**
 * TeXRA's helper model while the person has chosen none (polishing, agent
 * creation, merge, session descriptions). DeepSeek V4.1 Flash is the cheapest
 * capable option (~$0.15/$0.60 per MTok) and keeps these one-shot,
 * non-streaming helper calls fast.
 */
const DEFAULT_HELPER_MODEL = 'deepseek/deepseek-flash@none';

/** The catalog every host's config carries: the harness's rows and TeXRA's. */
const catalog: SettingsCatalog = settingsCatalog({
  namespace: 'texra',
  rows: [...TEXRA_UNSHOWN_ROWS, ...TEXRA_PLACED_ROWS],
  defaults: {
    [HELPER_MODEL_SETTING.key]: DEFAULT_HELPER_MODEL,
    [GIT_AUTHOR_NAME_SETTING.key]: 'texra-ai',
    [GIT_AUTHOR_EMAIL_SETTING.key]: 'texra-ai@users.noreply.github.com',
  },
  curatedModels: CURATED_MODELS,
});

/** Each harness row's placement, by key. */
const HARNESS_PLACEMENTS = new Map(Object.entries(HARNESS_ROW_SURFACES));

/**
 * The rows some TeXRA UI renders, in catalog order: each harness row with a
 * placement, as the catalog holds it (an app default applied), joined with
 * that placement, then TeXRA's placed rows.
 */
const placedRows: readonly TexraSettingRow[] = [
  ...catalog.rows.flatMap((row): TexraSettingRow[] => {
    const placement = HARNESS_PLACEMENTS.get(row.key);
    return placement ? [{ ...row, ...placement }] : [];
  }),
  ...TEXRA_PLACED_ROWS,
];
const placedByKey = new Map(placedRows.map((row) => [row.key, row]));

function isSettingsViewRow(row: TexraSettingRow): row is SettingsViewRow {
  return row.surfaces.settingsView !== undefined;
}

/**
 * The catalog TeXRA's hosts hand the harness, and the lookups TeXRA's settings
 * UIs read: every list is a filter over the placed rows, never hand-maintained.
 */
export const TEXRA_SETTINGS = Object.freeze({
  catalog,
  /** Look up a row the settings view's unified write path owns. */
  settingsViewByKey: (key: string): SettingsViewRow | undefined => {
    const row = placedByKey.get(key);
    return row !== undefined && isSettingsViewRow(row) ? row : undefined;
  },
  /**
   * The rows one settings-view snapshot carries, in catalog order: the
   * outbound payload's schema, the backend's read loop and the webview's
   * apply step each iterate this list, so placing a row on a snapshot puts it
   * on the wire.
   */
  snapshotEntries: (
    snapshot: SettingsViewSnapshot,
  ): readonly SettingsViewRow[] =>
    placedRows.filter(
      (row): row is SettingsViewRow => row.surfaces.settingsView === snapshot,
    ),
  /** The `/config` panel's rows: `surfaces.cliConfig` is the one predicate. */
  cliRows: Object.freeze(
    placedRows.filter((row) => row.surfaces.cliConfig === true),
  ),
  /** Look up a row the CLI `/config` panel lists, and so may write. */
  cliByKey: (key: string): TexraSettingRow | undefined => {
    const row = placedByKey.get(key);
    return row?.surfaces.cliConfig === true ? row : undefined;
  },
  /**
   * The Models tab's controls for one provider, in catalog order, each with
   * its row, whose title and description a control without its own shows.
   */
  modelsTab: (provider: string) =>
    placedRows.flatMap((entry) => {
      const control = entry.surfaces.model;
      return control?.provider === provider ? [{ entry, control }] : [];
    }),
});
