// Third-party imports
import { z } from 'zod';

import {
  AGENT_SKILLS_ENABLED_DEFAULT,
  AgentSkillsSettingsSchema,
} from './agentSkills';

/**
 * Core (host-neutral) TeXRA settings.
 *
 * These settings apply to any host that integrates the TeXRA core — VS Code
 * extension, Electron desktop, or CLI. The VS Code host layers its own
 * extension-only settings on top via `vscodeSettings.ts`; the CLI exposes only
 * the shared enums + a flat-key list from `cliSettings.ts` rather than a
 * layered schema; the Electron desktop host has no extension settings today.
 *
 * Per the project's split policy: a setting belongs in Core if any host could
 * plausibly implement it, even if only one host implements it today. Truly
 * host-specific settings (those that name-reference a host or are
 * UI affordances unique to one host's toolkit) live in the per-host
 * extension schema, when one exists.
 */

const NON_REGEX_REPLACEMENT_CATEGORIES = [
  'latex_spacing',
  'equations',
  'sections',
  'latex_forbidden_commands',
  'characters',
  'font_commands',
  'latex_xml',
  'unicode',
  'html_entities',
  'latexdiff',
  'gptness',
  'personal_style',
  'max_style',
] as const;

const REGEX_REPLACEMENT_CATEGORIES = [
  'fenced_latex_blocks',
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
  'equation_macros',
  'personal_style_contextual',
  'max_style_regex',
] as const;

export const LATEXDIFF_TEMP_FILE_LOCATIONS = [
  'sameDirectory',
  'workspaceTemp',
] as const;

export const AGENT_REVIEW_APPROACHES = ['quick', 'thorough'] as const;

export type NonRegexReplacementCategory =
  (typeof NON_REGEX_REPLACEMENT_CATEGORIES)[number];
export type RegexReplacementCategory =
  (typeof REGEX_REPLACEMENT_CATEGORIES)[number];
export type LatexdiffTempFileLocation =
  (typeof LATEXDIFF_TEMP_FILE_LOCATIONS)[number];
export type AgentReviewApproach = (typeof AGENT_REVIEW_APPROACHES)[number];

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
    useGoogleInteractionsAPI: true,
    useGoogleInteractionsServerState: true,
    useBackgroundResponses: true,
    openaiParallelToolCalls: true,
    compactionThresholdPercent: 75,
    gpt5ReasoningSummary: false,
    retry: {
      maxAttempts: 2,
    },
  },
  chatgptCodex: {
    preferSubscription: false,
  },
  files: {
    included: {
      mediaExtensions: [
        '.png',
        '.pdf',
        '.jpeg',
        '.jpg',
        '.gif',
        '.heic',
        '.heif',
        '.webp',
        '.wav',
        '.m4a',
        '.mp3',
        '.aiff',
        '.aac',
        '.opus',
        '.l16',
        '.alaw',
        '.mulaw',
        '.ogg',
        '.flac',
      ],
      inputExtensions: ['.txt', '.tex', '.md'],
      contextExtensions: [
        '.txt',
        '.tex',
        '.md',
        '.bib',
        '.bbl',
        '.cls',
        '.sty',
      ],
      editedExtensions: ['.txt', '.tex'],
    },
    ignored: {
      fileExtensions: [
        '.pdf',
        '.bst',
        '.json',
        '.py',
        '.ipynb',
        '.png',
        '.vsix',
        '.ts',
        '.js',
        '.yaml',
      ],
      inputFiles: ['command.tex', 'commands.tex', 'preamble.tex', 'yaml'],
      inputDirectories: [],
      mediaDirectories: [
        'build',
        'node_modules',
        '__pycache__',
        'versions',
        'history',
        'venv',
        'Diffs',
      ],
      directories: [
        'build',
        'node_modules',
        '__pycache__',
        'figures',
        'media',
        'figs',
        'versions',
        'history',
        'stuff',
        'draft',
        'miscellaneous',
        'diffs',
        'venv',
      ],
      keywords: [
        'Makefile',
        'template',
        '_thinking',
        '_diff',
        'draw',
        'versions',
        'history',
        '.egg-info',
        'venv',
        'yaml',
      ],
    },
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
    enabledReplacements: [
      'latex_spacing',
      'equations',
      'sections',
      'latex_forbidden_commands',
      'characters',
      'font_commands',
      'latex_xml',
      'unicode',
      'html_entities',
      'latexdiff',
      'gptness',
    ] satisfies NonRegexReplacementCategory[],
    enabledReplacementsRegex: [
      'fenced_latex_blocks',
      'inline_math',
      'parentheses',
      'latexdiff_markup',
      'equation_style',
      'personal_style_contextual',
    ] satisfies RegexReplacementCategory[],
    customReplacementsRegex: {},
    customReplacements: {},
  },
  latexdiff: {
    pictureEnvironments: '(?:picture|tikzpicture|scope|DIFnomarkup)[\\w\\d*@]*',
    tempFileLocation: 'sameDirectory' as LatexdiffTempFileLocation,
  },
  git: {
    numberOfCommitsToShow: 20,
  },
  agentReview: {
    runOnCommit: false,
    includeSubmodules: true,
    includeUntrackedFiles: true,
    approach: 'quick' as AgentReviewApproach,
    model: '',
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

const stringArray = (defaultValue: string[], description: string) =>
  z.array(z.string()).describe(description).prefault(defaultValue);

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
      useGoogleInteractionsAPI: boolField(
        DEFAULT_CORE_SETTINGS.model.useGoogleInteractionsAPI,
        "Use Google's Interactions API instead of Generate Content when available. Enabled by default. OpenRouter-proxied Google models always use Generate Content.",
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
          maxAttempts: numberField(
            DEFAULT_CORE_SETTINGS.model.retry.maxAttempts,
            'Automatic retry attempts for transient model failures. Parallel runs share one recovery probe per affected model route.',
            { min: 0 },
          ),
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
  files: z
    .strictObject({
      included: z
        .strictObject({
          mediaExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.mediaExtensions,
            'File extensions to include when searching for media files',
          ),
          inputExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.inputExtensions,
            'File extensions to include when searching for input files',
          ),
          contextExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.contextExtensions,
            'File extensions to include when searching for context files',
          ),
          editedExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.editedExtensions,
            'File extensions to include when searching for edited files',
          ),
        })
        .prefault(DEFAULT_CORE_SETTINGS.files.included),
      ignored: z
        .strictObject({
          fileExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.fileExtensions,
            'File extensions to ignore when listing text files',
          ),
          inputFiles: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.inputFiles,
            'Files to ignore when listing input, sample, and edited files',
          ),
          inputDirectories: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.inputDirectories,
            'Additional directories to ignore when listing input and edited files',
          ),
          mediaDirectories: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.mediaDirectories,
            'Directories to ignore in the figure path',
          ),
          directories: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.directories,
            'Directories to ignore when listing files',
          ),
          keywords: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.keywords,
            'Keywords to ignore when selecting files',
          ),
        })
        .prefault(DEFAULT_CORE_SETTINGS.files.ignored),
    })
    .prefault(DEFAULT_CORE_SETTINGS.files),
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
      pictureEnvironments: stringField(
        DEFAULT_CORE_SETTINGS.latexdiff.pictureEnvironments,
        'Regular expression pattern for environments to be treated as pictures. These environments will be processed as a unit without internal differencing.',
      ),
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
      includeSubmodules: boolField(
        DEFAULT_CORE_SETTINGS.agentReview.includeSubmodules,
        'Include changes from Git submodules in the review.',
      ),
      includeUntrackedFiles: boolField(
        DEFAULT_CORE_SETTINGS.agentReview.includeUntrackedFiles,
        'Include untracked files (new files not yet added to Git) in the review.',
      ),
      approach: z
        .enum(AGENT_REVIEW_APPROACHES)
        .describe(
          'Choose between quick or more thorough, higher-cost analysis.',
        )
        .meta({
          enumDescriptions: [
            'The reviewer verifies only its strongest suspicions with tools — fast and cheap.',
            'The reviewer reads every changed file in full, checks callers, and pulls diagnostics before reporting — deeper, higher-cost analysis.',
          ],
        })
        .prefault(DEFAULT_CORE_SETTINGS.agentReview.approach),
      model: stringField(
        DEFAULT_CORE_SETTINGS.agentReview.model,
        'Model id for the review session (e.g. a stronger model for thorough reviews). Leave empty to use the default agent model.',
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
        'Send a usage record for each model round to TeXRA: model and provider, agent name and category, token counts, cost, response time, route, stream id, and the TeXRA version and host. Never prompt text, document content, or file names. Records are sent only while signed in. Turning this off stops reporting for rounds billed to your own API key; rounds that went through the relay or a subscription are still recorded, because they meter your hosted usage against your plan. Setting TEXRA_NO_TELEMETRY=1 or DO_NOT_TRACK=1 in the environment turns it off regardless of this setting.',
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

/**
 * Dotted leaf paths of the settings tree, enumerated at the type level.
 *
 * Drives the compile-time guards below so {@link CORE_SETTING_PATHS} stays in
 * lockstep with {@link CoreSettingsShape}: a record/array/primitive field is a
 * leaf, a nested settings group is recursed into.
 */
type IsRecord<T> = string extends keyof T ? true : false;

/**
 * `NonNullable` is applied before the `extends object` test so that an optional
 * group added without a default (`Group | undefined`) still recurses into its
 * leaves instead of silently collapsing to a single key. The guard therefore
 * stays sound whether a nested group is declared with `.prefault()` (every group
 * today) or `.optional()`. Arrays and records resolve to leaves; nested settings
 * groups recurse.
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
 * `satisfies` clause rejects a typo'd or renamed path, and `_AssertCorePathsExhaustive`
 * fails the build if a setting is added to the schema without a matching entry
 * here. Previously both failure modes were silent (the list compiled fine while
 * host typo-detection quietly broke).
 */
export const CORE_SETTING_PATHS = [
  'agentOutputs.autoOpenFinal',
  'inlineCriticism.enabled',
  'goal.enabled',
  'model.useOpenAIResponsesAPI',
  'model.useGoogleInteractionsAPI',
  'model.useGoogleInteractionsServerState',
  'model.useBackgroundResponses',
  'model.openaiParallelToolCalls',
  'model.compactionThresholdPercent',
  'model.gpt5ReasoningSummary',
  'model.retry.maxAttempts',
  'chatgptCodex.preferSubscription',
  'files.included.mediaExtensions',
  'files.included.inputExtensions',
  'files.included.contextExtensions',
  'files.included.editedExtensions',
  'files.ignored.fileExtensions',
  'files.ignored.inputFiles',
  'files.ignored.inputDirectories',
  'files.ignored.mediaDirectories',
  'files.ignored.directories',
  'files.ignored.keywords',
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
  'latexdiff.pictureEnvironments',
  'latexdiff.tempFileLocation',
  'git.numberOfCommitsToShow',
  'agentReview.runOnCommit',
  'agentReview.includeSubmodules',
  'agentReview.includeUntrackedFiles',
  'agentReview.approach',
  'agentReview.model',
  'audio.soxPath',
  'logger.debugMode',
  'telemetry.enabled',
  'debug.saveModelIO',
  'skills.enabled',
  'toolUse.requireEditApproval',
  'toolUse.requireBashApproval',
] as const satisfies readonly LeafPaths<CoreSettings>[];

type CoreSettingPath = (typeof CORE_SETTING_PATHS)[number];

// Build fails if any schema leaf path is missing from CORE_SETTING_PATHS above.
type _AssertCorePathsExhaustive = AssertNever<
  Exclude<LeafPaths<CoreSettings>, CoreSettingPath>
>;

/**
 * Which hosts actually read each Core setting, keyed by the file that reads it.
 *
 * The split matters because `.texra/config.json` is shared by the CLI and the
 * desktop app while the VS Code extension keeps its configuration in
 * `.vscode/settings.json`. A setting only the extension reads is inert in
 * `.texra/config.json`, so the CLI's unknown-key warning must report it rather
 * than accept it silently.
 *
 * This mirrors the `cliConsumer` discipline {@link STATE_SETTINGS} enforces in
 * `stateSettings.ts`. State-backed settings additionally carry
 * `cliRuntimeReachability` because they are surfaced as editable rows in the
 * CLI `/config` panel; the entries here make the weaker claim that the key is
 * not a no-op, so the reading file is the whole of the evidence. The guardrail
 * suite checks that each file exists and sits on the side of the host split it
 * is filed under.
 */
export const CLI_CORE_SETTING_CONSUMERS = {
  'src/agent/runtime/selectAutoOpenFinalOutput.ts': [
    'agentOutputs.autoOpenFinal',
  ],
  'src/tools/goal/goalFeatureFlag.ts': ['goal.enabled'],
  'src/agent/runtime/ModelFactory.ts': [
    'model.useOpenAIResponsesAPI',
    'model.useGoogleInteractionsAPI',
  ],
  'src/agent/modelHandlers/google/modelHandlerGoogleInteractions.ts': [
    'model.useGoogleInteractionsServerState',
  ],
  'src/agent/modelHandlers/openai/modelHandlerOpenAIResponse.ts': [
    'model.useBackgroundResponses',
    'model.gpt5ReasoningSummary',
  ],
  'src/agent/modelHandlers/openai/modelHandlerOpenAI.ts': [
    'model.openaiParallelToolCalls',
  ],
  'src/agent/modelHandlers/ModelHandler.ts': [
    'model.compactionThresholdPercent',
  ],
  'src/agent/core/flows/RetryState.ts': ['model.retry.maxAttempts'],
  'src/model/codex/codexPreference.ts': ['chatgptCodex.preferSubscription'],
  'src/common/files/fileTypeUtils.ts': [
    'files.included.mediaExtensions',
    'files.included.inputExtensions',
    'files.included.contextExtensions',
    'files.included.editedExtensions',
  ],
  'src/common/files/fileListingRules.ts': [
    'files.ignored.fileExtensions',
    'files.ignored.inputFiles',
    'files.ignored.inputDirectories',
    'files.ignored.mediaDirectories',
    'files.ignored.directories',
    'files.ignored.keywords',
  ],
  'src/utils/media/img.ts': ['maxImageDimension'],
  'src/tools/latex/ExtractBibliographyTool.ts': ['bib.defaultPath'],
  'src/tools/zotero/bbtClient.ts': ['bib.zoteroPort'],
  'src/latex/formatter/latexindentpt.ts': ['latex.latexindentConfig'],
  'src/latex/formatter/texfmt.ts': ['latex.texfmtConfig'],
  'src/latex/texTools.ts': [
    'latex.tikzInputDirectory',
    'latex.includeWorkspaceInTexinputs',
  ],
  'src/latex/TikzPictureManager.ts': ['latex.tikzTemplate'],
  'src/replacement/engine.ts': [
    'latex.wrapCritiqueInAlign',
    'latex.enabledReplacements',
    'latex.enabledReplacementsRegex',
    'latex.customReplacementsRegex',
    'latex.customReplacements',
  ],
  'src/latex/latexdiff/diffCommandExecutor.ts': [
    'latexdiff.pictureEnvironments',
  ],
  'src/tools/approval/latexPreview.ts': ['latexdiff.tempFileLocation'],
  // Only the extension's git commands read the commit count, but the setup
  // assistant's `update_config` tool writes it from any host, so a CLI-written
  // value must not then be reported as unknown.
  'src/tools/setup/ConfigTools.ts': ['git.numberOfCommitsToShow'],
  'src/tools/media/audio.ts': ['audio.soxPath'],
  'src/logger/logUtils.ts': ['logger.debugMode'],
  'src/telemetry/UsageLogService.ts': ['telemetry.enabled'],
  'src/agent/utils/debugMessageSaver.ts': ['debug.saveModelIO'],
  'src/agent/utils/userVars.ts': ['skills.enabled'],
  'src/tools/approval/toolEditApproval.ts': ['toolUse.requireEditApproval'],
  'src/tools/approval/bashApproval.ts': ['toolUse.requireBashApproval'],
} as const satisfies Readonly<Record<string, readonly CoreSettingPath[]>>;

const EXTENSION_ONLY_CONSUMER_FILES = {
  // The criticism sink that honors this flag is a VS Code diagnostics surface;
  // the desktop reports inline criticism as unsupported.
  'packages/extension/src/frontend/latex/inlineCriticism.ts': [
    'inlineCriticism.enabled',
  ],
  'packages/extension/src/frontend/review/agentReviewCommitWatcher.ts': [
    'agentReview.runOnCommit',
  ],
  'packages/extension/src/frontend/review/AgentReviewService.ts': [
    'agentReview.includeSubmodules',
    'agentReview.includeUntrackedFiles',
    'agentReview.approach',
    'agentReview.model',
  ],
} as const satisfies Readonly<Record<string, readonly CoreSettingPath[]>>;

/**
 * Core settings only the VS Code extension reads. Setting one of these in
 * `.texra/config.json` does nothing, so the CLI reports it as unknown.
 *
 * Exported with widened keys: the SDK declaration build (`packages/agent`)
 * forbids `packages/extension/src/` text in emitted `.d.ts`, so the literal
 * consumer-file keys stay on the internal const above, which also feeds the
 * classification guard below.
 */
export const EXTENSION_ONLY_CORE_SETTING_CONSUMERS: Readonly<
  Record<string, readonly CoreSettingPath[]>
> = EXTENSION_ONLY_CONSUMER_FILES;

type ConsumedPaths<T extends Readonly<Record<string, readonly string[]>>> =
  T[keyof T][number];

// Build fails when a Core setting is added without filing it on one side of the
// host split, so a new extension-only key cannot silently rejoin the CLI's
// known-key set.
type _AssertEveryCorePathClassified = AssertNever<
  Exclude<
    CoreSettingPath,
    | ConsumedPaths<typeof CLI_CORE_SETTING_CONSUMERS>
    | ConsumedPaths<typeof EXTENSION_ONLY_CONSUMER_FILES>
  >
>;
