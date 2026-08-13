// Third-party imports
import { z } from 'zod';

import {
  DEFAULT_ENABLED_REGEX_REPLACEMENTS,
  DEFAULT_ENABLED_REPLACEMENTS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
} from '@shared/constants/replacementCategories';

import {
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentSkillsSettingsSchema,
} from './agentSkills';

/**
 * Core (host-neutral) TeXRA settings.
 *
 * These settings apply to any host that integrates the TeXRA core — VS Code
 * extension, Electron desktop, or CLI. All three hosts read them from the
 * TeXRA-owned JSON configuration; host-specific schemas may add controls that
 * do not represent runtime configuration.
 *
 * Per the project's split policy: a setting belongs in Core if any host could
 * plausibly implement it, even if only one host implements it today. Truly
 * host-specific settings (those that name-reference a host or are
 * UI affordances unique to one host's toolkit) live in the per-host
 * extension schema, when one exists.
 */

export const LATEXDIFF_TEMP_FILE_LOCATIONS = [
  'sameDirectory',
  'workspaceTemp',
] as const;

export const TOOL_EDIT_APPROVAL_CONFIG_KEY =
  'texra.toolUse.requireEditApproval';

export type LatexdiffTempFileLocation =
  (typeof LATEXDIFF_TEMP_FILE_LOCATIONS)[number];

/**
 * Bounds, default, and copy for `model.retry.maxAttempts`. The value is the
 * number of automatic retries after the initial model request. Shared by
 * {@link ModelRetryMaxAttemptsSchema} and the settings-view reliability row so
 * the schema and the UI cannot disagree about the range.
 */
export const MODEL_RETRY_MAX_ATTEMPTS_SETTING = {
  defaultValue: 2,
  min: 0,
  max: 5,
  description:
    'Additional automatic retries after the initial model request (0–5). Long-running background requests retain at least two recovery retries.',
} as const;

export const DEFAULT_CORE_SETTINGS = {
  agentOutputs: {
    autoOpenFinal: true,
  },
  inlineCriticism: {
    enabled: false,
  },
  goal: {
    enabled: true,
  },
  model: {
    useOpenAIResponsesAPI: true,
    useGoogleInteractionsServerState: true,
    useBackgroundResponses: true,
    openaiParallelToolCalls: true,
    compactionThresholdPercent: 75,
    gpt5ReasoningSummary: false,
    retry: {
      maxAttempts: MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    },
  },
  chatgptCodex: {
    preferSubscription: false,
  },
  xaiGrok: {
    preferSubscription: false,
  },
  maxImageDimension: 2000,
  bib: {
    defaultPath: '',
    zoteroPort: 23119,
  },
  latex: {
    latexindentConfig: '',
    texfmtConfig: '',
    tikzInputDirectory: '',
    tikzTemplate:
      '\\documentclass[tikz,border=10pt]{standalone}\n' +
      '\\usepackage{tikz}\n' +
      '\\usepackage{pgfplots}\n' +
      '\\usetikzlibrary{positioning}\n' +
      '\\usetikzlibrary{patterns}\n' +
      '\\usetikzlibrary{arrows.meta, shapes.geometric, matrix, calc, decorations.pathreplacing}\n' +
      '\\usetikzlibrary{shapes, arrows}\n\n' +
      '\\begin{document}\n' +
      '{{ tikzpicture }}\n' +
      '\\end{document}',
    includeWorkspaceInTexinputs: true,
    wrapCritiqueInAlign: true,
    enabledReplacements: DEFAULT_ENABLED_REPLACEMENTS,
    enabledReplacementsRegex: DEFAULT_ENABLED_REGEX_REPLACEMENTS,
    customReplacementsRegex: {},
    customReplacements: {},
  },
  latexdiff: {
    tempFileLocation: 'sameDirectory' as LatexdiffTempFileLocation,
  },
  git: {
    numberOfCommitsToShow: 20,
  },
  agentReview: {
    runOnCommit: false,
  },
  audio: {
    soxPath: '',
  },
  logger: {
    debugMode: false,
  },
  telemetry: {
    enabled: true,
  },
  debug: {
    saveModelIO: false,
  },
  skills: {
    enabled: AGENT_SKILLS_ENABLED_DEFAULT,
  },
  toolUse: {
    requireEditApproval: true,
    requireBashApproval: true,
  },
};

const stringRecord = (
  defaultValue: Record<string, string>,
  description: string,
) =>
  z.record(z.string(), z.string()).describe(description).prefault(defaultValue);

const boolField = (defaultValue: boolean, description: string) =>
  z.boolean().describe(description).prefault(defaultValue);

const stringField = (defaultValue: string, description: string) =>
  z.string().describe(description).prefault(defaultValue);

const numberField = (
  defaultValue: number,
  description: string,
  range?: { min?: number; max?: number },
) => {
  let schema = z.number();
  if (range?.min !== undefined) schema = schema.min(range.min);
  if (range?.max !== undefined) schema = schema.max(range.max);
  return schema.describe(description).prefault(defaultValue);
};

export const ModelRetryMaxAttemptsSchema = z
  .int()
  .min(MODEL_RETRY_MAX_ATTEMPTS_SETTING.min)
  .max(MODEL_RETRY_MAX_ATTEMPTS_SETTING.max)
  .describe(MODEL_RETRY_MAX_ATTEMPTS_SETTING.description)
  .prefault(MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue);

/**
 * Field shape for {@link CoreSettingsSchema}.
 *
 * Exported as a plain object so host-specific schemas can compose with it via
 * `z.strictObject({ ...CoreSettingsShape, ...HostExtensionShape })`. The
 * standalone schema below applies the outer `.prefault()` for the whole-tree
 * default.
 */
export const CoreSettingsShape = {
  agentOutputs: z
    .strictObject({
      autoOpenFinal: boolField(
        DEFAULT_CORE_SETTINGS.agentOutputs.autoOpenFinal,
        "When a workflow run completes, automatically preview the final revised file in a new editor tab. Disable for batch runs when you don't want a tab to steal focus.",
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.agentOutputs),
  inlineCriticism: z
    .strictObject({
      enabled: boolField(
        DEFAULT_CORE_SETTINGS.inlineCriticism.enabled,
        'Experimental: parse \\criticize{message}{severity}{confidence} annotations from agent-revised LaTeX files and surface them as VS Code diagnostics (squiggles + Problems panel). Severity 5→Error, 4→Warning, 3→Info, 1–2→Hint. Tool-use agents may also push diagnostics directly via the diagnostics tool\'s "add" command.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.inlineCriticism),
  goal: z
    .strictObject({
      enabled: boolField(
        DEFAULT_CORE_SETTINGS.goal.enabled,
        'Enable Goal, a per-stream autonomous-continuation mode for tool-use agents. When on, an active Goal lets the agent keep working across turns toward a stated objective until it calls plan(command="complete"). On by default; set to false to require manual continuation.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.goal),
  model: z
    .strictObject({
      useOpenAIResponsesAPI: boolField(
        DEFAULT_CORE_SETTINGS.model.useOpenAIResponsesAPI,
        "Use OpenAI's newer Responses API for additional features like built-in tool use. Disable to fall back to the classic Chat Completions API.",
      ),
      useGoogleInteractionsServerState: boolField(
        DEFAULT_CORE_SETTINGS.model.useGoogleInteractionsServerState,
        "Store Google Interactions conversation state on Google's servers via previous_interaction_id chaining, sending only the new turn each round. Google then retains the conversation for a limited period to enable chaining. Enabled by default. Disable to keep conversations off Google's servers — stateless mode resends the full transcript each round (store:false).",
      ),
      useBackgroundResponses: boolField(
        DEFAULT_CORE_SETTINGS.model.useBackgroundResponses,
        'Keep long-running OpenAI requests alive in the background (polling) instead of timing out after 10 minutes. Applies automatically to GPT models running workflow agents; ignored otherwise. Disable to fall back to synchronous streaming requests.',
      ),
      openaiParallelToolCalls: boolField(
        DEFAULT_CORE_SETTINGS.model.openaiParallelToolCalls,
        'Let OpenAI models use multiple tools at the same time for faster results. Enabled by default; disable for models that require sequential tool execution.',
      ),
      compactionThresholdPercent: numberField(
        DEFAULT_CORE_SETTINGS.model.compactionThresholdPercent,
        "When the conversation reaches this percentage of the model's context limit, TeXRA automatically summarizes earlier messages to free up space. Lower values trigger summarization sooner. Set to 0 to disable.",
        { min: 0, max: 100 },
      ),
      gpt5ReasoningSummary: boolField(
        DEFAULT_CORE_SETTINGS.model.gpt5ReasoningSummary,
        "Show the model's reasoning steps alongside its output when using GPT-5 models. Requires an OpenAI account with access to reasoning features.",
      ),
      retry: z
        .strictObject({
          maxAttempts: ModelRetryMaxAttemptsSchema,
        })
        .prefault(DEFAULT_CORE_SETTINGS.model.retry),
    })
    .prefault(DEFAULT_CORE_SETTINGS.model),
  chatgptCodex: z
    .strictObject({
      preferSubscription: boolField(
        DEFAULT_CORE_SETTINGS.chatgptCodex.preferSubscription,
        'Prefer your signed-in ChatGPT subscription for Codex-eligible OpenAI models instead of API-key routing. Experimental. Subscription routing currently uses a 272,000-token Codex context cap, not the full 1,000,000-token API context.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.chatgptCodex),
  xaiGrok: z
    .strictObject({
      preferSubscription: boolField(
        DEFAULT_CORE_SETTINGS.xaiGrok.preferSubscription,
        'Prefer your signed-in Grok (xAI SuperGrok) account for xAI models instead of API-key routing. Experimental. Uses the public Grok CLI OAuth client; xAI may change or revoke that registration without notice.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.xaiGrok),
  maxImageDimension: numberField(
    DEFAULT_CORE_SETTINGS.maxImageDimension,
    'Maximum dimension (width or height) in pixels for images before resizing. Images larger than this will be resized to fit within this dimension while maintaining aspect ratio.',
    { min: 100, max: 10000 },
  ),
  bib: z
    .strictObject({
      defaultPath: stringField(
        DEFAULT_CORE_SETTINGS.bib.defaultPath,
        'Default path to bibliography file (.bib). This is used by bibliography tools when no explicit path is provided. Supports Zotero auto-exported .bib files.',
      ),
      zoteroPort: numberField(
        DEFAULT_CORE_SETTINGS.bib.zoteroPort,
        'Port number for Zotero integration (default: 23119). Used by both the Connector API and Better BibTeX JSON-RPC.',
        { min: 1, max: 65535 },
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.bib),
  latex: z
    .strictObject({
      latexindentConfig: stringField(
        DEFAULT_CORE_SETTINGS.latex.latexindentConfig,
        'Path to latexindent configuration file',
      ),
      texfmtConfig: stringField(
        DEFAULT_CORE_SETTINGS.latex.texfmtConfig,
        'Path to tex-fmt configuration file',
      ),
      tikzInputDirectory: stringField(
        DEFAULT_CORE_SETTINGS.latex.tikzInputDirectory,
        'Directory where to look for extra input files when compiling extracted TikZ figures. Absolute path is required. Sets TEXINPUTS environment variable for TikZ compilation.',
      ),
      tikzTemplate: stringField(
        DEFAULT_CORE_SETTINGS.latex.tikzTemplate,
        'Template used for generating standalone documents when extracting and compiling TikZ figures',
      ),
      includeWorkspaceInTexinputs: boolField(
        DEFAULT_CORE_SETTINGS.latex.includeWorkspaceInTexinputs,
        'Include the workspace root directory in TEXINPUTS when compiling TikZ figures',
      ),
      wrapCritiqueInAlign: boolField(
        DEFAULT_CORE_SETTINGS.latex.wrapCritiqueInAlign,
        'When enabled, bare \\critique and \\comment commands inside align blocks are wrapped with \\intertext.',
      ),
      enabledReplacements: z
        .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
        .describe('List of enabled non-regex LaTeX replacement categories')
        .prefault(DEFAULT_CORE_SETTINGS.latex.enabledReplacements),
      enabledReplacementsRegex: z
        .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
        .describe('List of enabled regex LaTeX replacement categories')
        .prefault(DEFAULT_CORE_SETTINGS.latex.enabledReplacementsRegex),
      customReplacementsRegex: stringRecord(
        DEFAULT_CORE_SETTINGS.latex.customReplacementsRegex,
        "Custom regex replacements in the format: { 'pattern': 'replacement' }. Use capture groups with $1, $2, etc. Example: { '\\\\section\\{([^}]+)\\}': '\\section{$1}' }",
      ),
      customReplacements: stringRecord(
        DEFAULT_CORE_SETTINGS.latex.customReplacements,
        "Custom LaTeX replacements in the format: { 'from': 'to' }. Example: { '\\alpha': '\\al' }",
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.latex),
  latexdiff: z
    .strictObject({
      tempFileLocation: z
        .enum(LATEXDIFF_TEMP_FILE_LOCATIONS)
        .describe(
          'Where to create temporary files for LaTeX preview and diff operations during tool edit approval.',
        )
        .meta({
          enumDescriptions: [
            'Create temp files in the same directory as the original file. Best for resolving \\input{} and relative paths.',
            'Create temp files in .texra-temp directory at workspace root. Keeps source directories clean but may break relative paths.',
          ],
        })
        .prefault(DEFAULT_CORE_SETTINGS.latexdiff.tempFileLocation),
    })
    .prefault(DEFAULT_CORE_SETTINGS.latexdiff),
  git: z
    .strictObject({
      numberOfCommitsToShow: numberField(
        DEFAULT_CORE_SETTINGS.git.numberOfCommitsToShow,
        'Number of recent commits to show in the commit selection dropdown',
        { min: 1, max: 100 },
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.git),
  agentReview: z
    .strictObject({
      runOnCommit: boolField(
        DEFAULT_CORE_SETTINGS.agentReview.runOnCommit,
        'Automatically review your changes for issues after each commit.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.agentReview),
  audio: z
    .strictObject({
      soxPath: stringField(
        DEFAULT_CORE_SETTINGS.audio.soxPath,
        'Path to the SoX executable. Overrides automatic detection.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.audio),
  logger: z
    .strictObject({
      debugMode: boolField(
        DEFAULT_CORE_SETTINGS.logger.debugMode,
        'Whether to show verbose debug messages in the logger view',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.logger),
  telemetry: z
    .strictObject({
      enabled: boolField(
        DEFAULT_CORE_SETTINGS.telemetry.enabled,
        'Send a usage record for each model round to TeXRA: model and provider, agent name and category, token counts, cost, response time, how the round was paid for, stream id, and the TeXRA version and host. Never prompt text, document content, or file names. Records are sent only while signed in. Turning this off stops reporting for rounds billed to your own API keys; rounds covered by included access or a subscription are still recorded, because they meter your hosted usage against your plan. Setting TEXRA_NO_TELEMETRY=1 or DO_NOT_TRACK=1 in the environment turns it off regardless of this setting.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.telemetry),
  debug: z
    .strictObject({
      saveModelIO: boolField(
        DEFAULT_CORE_SETTINGS.debug.saveModelIO,
        'Save what TeXRA sends to and receives from the model: the request messages and raw responses as JSON, plus the final input prompt as XML.',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.debug),
  skills: AgentSkillsSettingsSchema.prefault(DEFAULT_CORE_SETTINGS.skills),
  toolUse: z
    .strictObject({
      requireEditApproval: boolField(
        DEFAULT_CORE_SETTINGS.toolUse.requireEditApproval,
        'Require user approval in a diff view before tool-driven edits modify workspace files',
      ),
      requireBashApproval: boolField(
        DEFAULT_CORE_SETTINGS.toolUse.requireBashApproval,
        'Require user approval before tool-use agents execute bash commands',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.toolUse),
};

const CoreSettingsSchema = z
  .strictObject(CoreSettingsShape)
  .prefault(DEFAULT_CORE_SETTINGS);

export type CoreSettings = z.infer<typeof CoreSettingsSchema>;

/** True for an index-signature record, false for a fixed-key settings group. */
type IsRecord<T> = string extends keyof T ? true : false;

/**
 * Dotted leaf paths of the settings tree, enumerated at the type level.
 *
 * Drives the compile-time guards below so {@link CORE_SETTING_PATHS} stays in
 * lockstep with {@link CoreSettingsShape}: a record/array/primitive field is a
 * leaf, a nested settings group is recursed into.
 *
 * `NonNullable` is applied before the `extends object` test so that an optional
 * group added without a default (`Group | undefined`) still recurses into its
 * leaves instead of silently collapsing to a single key. The guard therefore
 * stays sound whether a nested group is declared with `.prefault()` (every group
 * today) or `.optional()`.
 */
type LeafPaths<T> = {
  [K in keyof T & string]: NonNullable<T[K]> extends readonly unknown[]
    ? K
    : NonNullable<T[K]> extends object
      ? IsRecord<NonNullable<T[K]>> extends true
        ? K
        : `${K}.${LeafPaths<NonNullable<T[K]>>}`
      : K;
}[keyof T & string];

/** Errors at build time unless `T` is exactly `never`. */
type AssertNever<T extends never> = T;

/**
 * Dotted leaf paths for every Core setting.
 *
 * Used by per-host "known TeXRA key" sets to derive `texra.*` prefixed key
 * lists for typo detection without hand-maintaining the list in each host.
 *
 * Kept in sync with the schema by the two compile-time guards just below: the
 * `satisfies` clause rejects a typo'd or renamed path, and
 * `_AssertCorePathsExhaustive` fails the build if a setting is added to the
 * schema without a matching entry here.
 */
export const CORE_SETTING_PATHS = [
  'agentOutputs.autoOpenFinal',
  'inlineCriticism.enabled',
  'goal.enabled',
  'model.useOpenAIResponsesAPI',
  'model.useGoogleInteractionsServerState',
  'model.useBackgroundResponses',
  'model.openaiParallelToolCalls',
  'model.compactionThresholdPercent',
  'model.gpt5ReasoningSummary',
  'model.retry.maxAttempts',
  'chatgptCodex.preferSubscription',
  'xaiGrok.preferSubscription',
  'maxImageDimension',
  'bib.defaultPath',
  'bib.zoteroPort',
  'latex.latexindentConfig',
  'latex.texfmtConfig',
  'latex.tikzInputDirectory',
  'latex.tikzTemplate',
  'latex.includeWorkspaceInTexinputs',
  'latex.wrapCritiqueInAlign',
  'latex.enabledReplacements',
  'latex.enabledReplacementsRegex',
  'latex.customReplacementsRegex',
  'latex.customReplacements',
  'latexdiff.tempFileLocation',
  'git.numberOfCommitsToShow',
  'agentReview.runOnCommit',
  'audio.soxPath',
  'logger.debugMode',
  'telemetry.enabled',
  'debug.saveModelIO',
  'skills.enabled',
  'toolUse.requireEditApproval',
  'toolUse.requireBashApproval',
] as const satisfies readonly LeafPaths<CoreSettings>[];

export type CoreSettingPath = (typeof CORE_SETTING_PATHS)[number];

const CORE_SETTING_PATH_SET = new Set<string>(CORE_SETTING_PATHS);

/** Return a fresh copy of a Core setting's schema-owned default value. */
export function getCoreSettingDefault(key: string): unknown {
  const settingPath = key.startsWith('texra.') ? key.slice(6) : key;
  if (!CORE_SETTING_PATH_SET.has(settingPath)) return undefined;

  let value: unknown = DEFAULT_CORE_SETTINGS;
  for (const segment of settingPath.split('.')) {
    if (value === null || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value !== null && typeof value === 'object'
    ? structuredClone(value)
    : value;
}

// Build fails if any schema leaf path is missing from CORE_SETTING_PATHS above.
type _AssertCorePathsExhaustive = AssertNever<
  Exclude<LeafPaths<CoreSettings>, CoreSettingPath>
>;

/**
 * Core settings a non-VS-Code host (CLI, desktop) actually reads, keyed by
 * setting path alone.
 *
 * The split matters because `.texra/config.json` is shared by all three hosts,
 * but a setting only the extension reads is still inert in the CLI. The CLI's
 * unknown-key warning must report such a key rather than accept it silently.
 *
 * This mirrors the `cliConsumer` discipline {@link STATE_SETTINGS} enforces in
 * `stateSettings.ts`. State-backed settings additionally carry
 * `cliRuntimeReachability` because they are surfaced as editable rows in the
 * CLI `/config` panel; the entries here make the weaker claim that the key is
 * not a no-op. The reading files are not listed here: that file-path knowledge
 * belongs to the host split guardrail (test-kernel), which checks each reader
 * file exists and sits on the side of the split it is filed under.
 */
export const CLI_CORE_SETTING_PATHS = [
  'agentOutputs.autoOpenFinal',
  'goal.enabled',
  'model.useOpenAIResponsesAPI',
  'model.useGoogleInteractionsServerState',
  'model.useBackgroundResponses',
  'model.gpt5ReasoningSummary',
  'model.openaiParallelToolCalls',
  'model.compactionThresholdPercent',
  'model.retry.maxAttempts',
  'chatgptCodex.preferSubscription',
  'xaiGrok.preferSubscription',
  'maxImageDimension',
  'bib.defaultPath',
  'bib.zoteroPort',
  'latex.latexindentConfig',
  'latex.texfmtConfig',
  'latex.tikzInputDirectory',
  'latex.includeWorkspaceInTexinputs',
  'latex.tikzTemplate',
  'latex.wrapCritiqueInAlign',
  'latex.enabledReplacements',
  'latex.enabledReplacementsRegex',
  'latex.customReplacementsRegex',
  'latex.customReplacements',
  'latexdiff.tempFileLocation',
  // Only the extension's git commands read the commit count, but the setup
  // assistant's `update_config` tool writes it from any host, so a CLI-written
  // value must not then be reported as unknown.
  'git.numberOfCommitsToShow',
  'audio.soxPath',
  'logger.debugMode',
  'telemetry.enabled',
  'debug.saveModelIO',
  'skills.enabled',
  'toolUse.requireEditApproval',
  'toolUse.requireBashApproval',
] as const satisfies readonly CoreSettingPath[];

/**
 * Core settings only the VS Code extension reads. Setting one of these in
 * `.texra/config.json` does nothing, so the CLI reports it as unknown.
 * Keyed by setting path alone; the reading files are tracked by the host split
 * guardrail (test-kernel), not here.
 */
export const EXTENSION_ONLY_CORE_SETTING_PATHS = [
  // The criticism sink that honors this flag is a VS Code diagnostics surface;
  // the desktop reports inline criticism as unsupported.
  'inlineCriticism.enabled',
  'agentReview.runOnCommit',
] as const satisfies readonly CoreSettingPath[];

// Build fails when a Core setting is added without filing it on one side of the
// host split, so a new extension-only key cannot silently rejoin the CLI's
// known-key set.
type _AssertEveryCorePathClassified = AssertNever<
  Exclude<
    CoreSettingPath,
    | (typeof CLI_CORE_SETTING_PATHS)[number]
    | (typeof EXTENSION_ONLY_CORE_SETTING_PATHS)[number]
  >
>;
