/**
 * TeXRA's own setting rows, and the static catalog its settings surfaces
 * read: the harness's rows (`@shared/state/stateSettings`), these, and the
 * rows its plugins declare (`./documentsSettings`, `./integrationSettings`).
 * Every host's config carries the catalog ({@link TEXRA_SETTINGS}`.catalog`,
 * `ConfigProvider.catalog`); the settings surfaces read the placed rows
 * beside it, where each row's placement is the row's own or, for a harness
 * row, the one `./settingSurfaces` gives it.
 *
 * Owner by key: the CLI's startup rows (`agent`, `model`, `chat`, `run`,
 * `outputFormat`), `agentOutputs.autoOpenFinal`, the bibliography
 * (`bib.*`), LaTeX (`latex.*`, the formatter), inline criticism and
 * telemetry.
 */

// Third-party imports
import { Effect, Schema } from 'effect';

// Local imports
import {
  HELPER_MODEL_SETTING,
  settingsCatalog,
  type SettingRow,
  type SettingsCatalog,
} from '@texra-ai/harness/schemas';
import { CliOutputFormatSchema } from '@texra/shared/cliOutputFormat';
import { LATEX_FORMATTER_VALUES } from '@texra/shared/constants/latexConfig';
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
import {
  HARNESS_ROW_SURFACES,
  type SettingsViewRow,
  type TexraSettingRow,
} from '@texra/shared/settingsView/settingSurfaces';
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

export const CLI_AGENT_SETTING = {
  key: 'agent',
  slot: 'config',
  schema: CliAgentSchema,
  title: 'Default agent',
  description:
    'Agent `texra chat` starts with when neither `--agent` nor `texra.chat.agent` names one.',
} as const satisfies SettingRow<string | undefined>;

export const CLI_MODEL_SETTING = {
  key: 'model',
  slot: 'config',
  schema: CliModelSchema,
  title: 'Default model',
  description:
    'Model every `texra` command starts with when neither `--model`, `TEXRA_MODEL`, nor a per-command default names one. A model this machine cannot run falls back to an available one with a notice.',
} as const satisfies SettingRow<string | undefined>;

/** `texra chat`'s overrides of the top-level `agent`/`model` rows. */
export const CLI_CHAT_SETTING = {
  key: 'chat',
  slot: 'config',
  schema: Schema.optional(
    Schema.Struct({ agent: CliAgentSchema, model: CliModelSchema }),
  ),
  title: 'Chat defaults',
  description:
    'Agent and model `texra chat` starts with, overriding the top-level defaults.',
} as const satisfies SettingRow<
  { readonly agent?: string; readonly model?: string } | undefined
>;

/** `texra run`'s override of the top-level `model` row; its agent is an argument. */
export const CLI_RUN_SETTING = {
  key: 'run',
  slot: 'config',
  schema: Schema.optional(Schema.Struct({ model: CliModelSchema })),
  title: 'Run defaults',
  description:
    'Model `texra run` starts with, overriding the top-level `texra.model`.',
} as const satisfies SettingRow<{ readonly model?: string } | undefined>;

export const CLI_OUTPUT_FORMAT_SETTING = {
  key: 'outputFormat',
  slot: 'config',
  schema: CliOutputFormatSchema,
  title: 'Output format',
  description:
    'How `texra` prints results: human text, one JSON object, or NDJSON records. `--output-format` and `TEXRA_OUTPUT_FORMAT` override it.',
} as const satisfies SettingRow<typeof CliOutputFormatSchema.Type>;

export const AUTO_OPEN_FINAL_SETTING = {
  key: 'agentOutputs.autoOpenFinal',
  slot: 'config',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Open the final revision',
  description:
    "When a document task completes, automatically preview the final revised file in a new editor tab. Disable for batch runs when you don't want a tab to steal focus.",
} as const satisfies SettingRow<boolean>;

export const BIB_DEFAULT_PATH_SETTING = {
  key: 'bib.defaultPath',
  slot: 'config',
  schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  title: 'Default bibliography file',
  description:
    'Default path to bibliography file (.bib). This is used by bibliography tools when no explicit path is provided. Supports Zotero auto-exported .bib files.',
} as const satisfies SettingRow<string>;

/** The port of Zotero's local endpoints: the Connector API and Better
 *  BibTeX's JSON-RPC. */
export const ZOTERO_PORT_SETTING = {
  key: 'bib.zoteroPort',
  slot: 'config',
  schema: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 65_535 }),
  ).pipe(Schema.withDecodingDefault(Effect.succeed(23119))),
  title: 'Zotero port',
  description:
    'Port number for Zotero integration (default: 23119). Used by both the Connector API and Better BibTeX JSON-RPC.',
} as const satisfies SettingRow<number>;

export const LATEXINDENT_CONFIG_SETTING = {
  key: 'latex.latexindentConfig',
  slot: 'config',
  schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  title: 'latexindent configuration file',
  description: 'Path to latexindent configuration file',
} as const satisfies SettingRow<string>;

export const TEXFMT_CONFIG_SETTING = {
  key: 'latex.texfmtConfig',
  slot: 'config',
  schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  title: 'tex-fmt configuration file',
  description: 'Path to tex-fmt configuration file',
} as const satisfies SettingRow<string>;

export const TIKZ_INPUT_DIRECTORY_SETTING = {
  key: 'latex.tikzInputDirectory',
  slot: 'config',
  schema: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(''))),
  title: 'TikZ input directory',
  description:
    'Directory where to look for extra input files when compiling extracted TikZ figures. Absolute path is required. Sets TEXINPUTS environment variable for TikZ compilation.',
} as const satisfies SettingRow<string>;

export const INCLUDE_WORKSPACE_IN_TEXINPUTS_SETTING = {
  key: 'latex.includeWorkspaceInTexinputs',
  slot: 'config',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Workspace in TEXINPUTS',
  description:
    'Include the workspace root directory in TEXINPUTS when compiling TikZ figures',
} as const satisfies SettingRow<boolean>;

export const TIKZ_TEMPLATE_SETTING = {
  key: 'latex.tikzTemplate',
  slot: 'config',
  schema: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIKZ_TEMPLATE)),
  ),
  title: 'TikZ template',
  description:
    'Template used for generating standalone documents when extracting and compiling TikZ figures',
} as const satisfies SettingRow<string>;

export const ENABLED_REPLACEMENTS_SETTING = {
  key: 'latex.enabledReplacements',
  slot: 'config',
  schema: Schema.Array(Schema.Literals(NON_REGEX_REPLACEMENT_CATEGORIES)).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_ENABLED_REPLACEMENTS)),
  ),
  title: 'Cleanup replacements',
  description: 'Enabled groups of direct LaTeX cleanup replacements.',
} as const satisfies SettingRow<
  readonly (typeof NON_REGEX_REPLACEMENT_CATEGORIES)[number][]
>;

export const ENABLED_REGEX_REPLACEMENTS_SETTING = {
  key: 'latex.enabledReplacementsRegex',
  slot: 'config',
  schema: Schema.Array(Schema.Literals(REGEX_REPLACEMENT_CATEGORIES)).pipe(
    Schema.withDecodingDefault(
      Effect.succeed(DEFAULT_ENABLED_REGEX_REPLACEMENTS),
    ),
  ),
  title: 'Pattern cleanup replacements',
  description: 'Enabled groups of pattern-based LaTeX cleanup replacements.',
} as const satisfies SettingRow<
  readonly (typeof REGEX_REPLACEMENT_CATEGORIES)[number][]
>;

export const CUSTOM_REGEX_REPLACEMENTS_SETTING = {
  key: 'latex.customReplacementsRegex',
  slot: 'config',
  schema: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  title: 'Custom pattern replacements',
  description: 'Custom regular-expression replacements.',
} as const satisfies SettingRow<Readonly<Record<string, string>>>;

export const CUSTOM_REPLACEMENTS_SETTING = {
  key: 'latex.customReplacements',
  slot: 'config',
  schema: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  title: 'Custom replacements',
  description: 'Custom direct text replacements.',
} as const satisfies SettingRow<Readonly<Record<string, string>>>;

/** The usage-telemetry opt-in. */
export const TELEMETRY_ENABLED_SETTING = {
  key: 'telemetry.enabled',
  slot: 'config',
  schema: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  title: 'Share usage telemetry',
  description:
    'Send anonymous model, agent, token, timing, and host metadata with a random install ID (no account). TeXRA never sends prompt text, document content, or file names. Turning this off stops all reporting.',
  category: 'privacy',
  configTarget: 'global',
  projectMayOptOut: true,
  surfaces: { settingsView: 'telemetry' },
} as const satisfies TexraSettingRow<boolean>;

export const LATEX_FORMATTER_SETTING = {
  key: 'latex.formatter',
  schema: Schema.Literals(LATEX_FORMATTER_VALUES).pipe(
    Schema.withDecodingDefault(Effect.succeed('latexindent')),
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
} as const satisfies TexraSettingRow<(typeof LATEX_FORMATTER_VALUES)[number]>;

/**
 * Editor squiggles and Problems-panel entries exist only in VS Code. The
 * shared LaTeX snapshot reads the row on every host; the desktop LaTeX page
 * hides it.
 */
export const INLINE_CRITICISM_SETTING = {
  key: 'inlineCriticism.enabled',
  schema: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
  ),
  title: 'Show criticism as editor diagnostics',
  description:
    'Show \\criticize{message}{severity}{confidence} annotations from agent-revised LaTeX files as squiggles and Problems-panel entries.',
  category: 'latex',
  slot: 'globalState',
  surfaces: { settingsView: 'latex' },
} as const satisfies TexraSettingRow<boolean>;

/** TeXRA's rows no TeXRA UI shows, in catalog order. */
const TEXRA_UNSHOWN_ROWS: readonly SettingRow[] = [
  CLI_AGENT_SETTING,
  CLI_MODEL_SETTING,
  CLI_CHAT_SETTING,
  CLI_RUN_SETTING,
  CLI_OUTPUT_FORMAT_SETTING,
  AUTO_OPEN_FINAL_SETTING,
  BIB_DEFAULT_PATH_SETTING,
  ZOTERO_PORT_SETTING,
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
  ...DOCUMENTS_SETTINGS,
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
  defaults: { [HELPER_MODEL_SETTING.key]: DEFAULT_HELPER_MODEL },
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
export const TEXRA_SETTINGS = {
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
  cliRows: placedRows.filter((row) => row.surfaces.cliConfig === true),
  /** Look up a row the CLI `/config` panel lists, and so may write. */
  cliByKey: (key: string): TexraSettingRow | undefined => {
    const row = placedByKey.get(key);
    return row?.surfaces.cliConfig === true ? row : undefined;
  },
  /**
   * The Models tab's controls for one provider, in catalog order, each with
   * its copy resolved (a control without its own label or description shows
   * the row's title and description).
   */
  modelsTab: (provider: string) =>
    placedRows.flatMap((entry) =>
      (entry.surfaces.models ?? [])
        .filter((control) => control.provider === provider)
        .map(({ provider: _provider, label, description, ...rest }) => ({
          entry,
          surface: {
            ...rest,
            label: label ?? entry.title,
            description: description ?? entry.description,
          },
        })),
    ),
};
