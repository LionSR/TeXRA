// Third-party imports
import { z } from 'zod';

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

export const NON_REGEX_REPLACEMENT_CATEGORIES = [
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

export const REGEX_REPLACEMENT_CATEGORIES = [
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
  ui: {
    showApiKeyReminders: true,
    showLoginBanner: true,
    showGettingStartedBanner: true,
    showOrchestratorBanner: true,
  },
  model: {
    useImprovedConnection: false,
    improvedConnectionDomain: 'proxy.texra.ai',
    useOpenAIResponsesAPI: true,
    useGoogleInteractionsAPI: true,
    useGoogleInteractionsServerState: true,
    useBackgroundResponses: true,
    openaiParallelToolCalls: true,
    compactionThresholdPercent: 75,
    gpt5ReasoningSummary: false,
    retry: {
      maxAttempts: 0,
      backoffMs: 1000,
    },
  },
  chatgptCodex: {
    preferSubscription: false,
    subscriptionToolUseOnly: false,
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
    showLatexindentWarning: false,
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
    emitPrCiStartedEvents: false,
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
  debug: {
    saveDebugObjects: false,
    saveInputPrompt: false,
  },
  skills: {
    enabled: true,
  },
  toolUse: {
    requireEditApproval: true,
    requireBashApproval: true,
    persistence: {
      enabled: true,
      ttlHours: 336,
    },
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
  ui: z
    .strictObject({
      showApiKeyReminders: boolField(
        DEFAULT_CORE_SETTINGS.ui.showApiKeyReminders,
        'Show API key reminders in the status bar and main view when no API keys are configured',
      ),
      showLoginBanner: boolField(
        DEFAULT_CORE_SETTINGS.ui.showLoginBanner,
        'Show login banner prompting users to sign in for access to remote agents',
      ),
      showGettingStartedBanner: boolField(
        DEFAULT_CORE_SETTINGS.ui.showGettingStartedBanner,
        'Show getting started banner with import options when no LaTeX files are found',
      ),
      showOrchestratorBanner: boolField(
        DEFAULT_CORE_SETTINGS.ui.showOrchestratorBanner,
        'Show orchestrator and session reminder text in the main view',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.ui),
  model: z
    .strictObject({
      useImprovedConnection: boolField(
        DEFAULT_CORE_SETTINGS.model.useImprovedConnection,
        'Use improved connection for API requests',
      ),
      improvedConnectionDomain: stringField(
        DEFAULT_CORE_SETTINGS.model.improvedConnectionDomain,
        'Domain to use when using improved connection',
      ),
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
            'Flow-managed retry attempts (Google, OpenRouter 429/408, background transients). Anthropic/OpenAI/OpenAIResponse retries are provider-managed by their SDKs (default 2); this setting does not affect them.',
            { min: 0 },
          ),
          backoffMs: numberField(
            DEFAULT_CORE_SETTINGS.model.retry.backoffMs,
            'Base backoff delay in milliseconds between retry attempts for model calls',
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
      subscriptionToolUseOnly: boolField(
        DEFAULT_CORE_SETTINGS.chatgptCodex.subscriptionToolUseOnly,
        'Use the ChatGPT subscription for tool-use agents only. Workflow agents fall back to your OpenAI API key or relay, because the Codex backend has no background mode and is less stable for long workflow runs.',
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
      showLatexindentWarning: boolField(
        DEFAULT_CORE_SETTINGS.latex.showLatexindentWarning,
        'Show warning when latexindent is not installed',
      ),
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
      emitPrCiStartedEvents: boolField(
        DEFAULT_CORE_SETTINGS.git.emitPrCiStartedEvents,
        'Emit a PR subscription event when GitHub check runs first appear for a new head commit.',
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
  debug: z
    .strictObject({
      saveDebugObjects: boolField(
        DEFAULT_CORE_SETTINGS.debug.saveDebugObjects,
        'Save message and response objects to JSON files for debugging purposes',
      ),
      saveInputPrompt: boolField(
        DEFAULT_CORE_SETTINGS.debug.saveInputPrompt,
        'Save the final input prompt sent to the model as an XML file for debugging purposes',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.debug),
  skills: z
    .strictObject({
      enabled: boolField(
        DEFAULT_CORE_SETTINGS.skills.enabled,
        'Discover imported skills and expose them to tool-use agent prompts',
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.skills),
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
      persistence: z
        .strictObject({
          enabled: boolField(
            DEFAULT_CORE_SETTINGS.toolUse.persistence.enabled,
            'Persist tool-use conversations across VS Code restarts',
          ),
          ttlHours: numberField(
            DEFAULT_CORE_SETTINGS.toolUse.persistence.ttlHours,
            'Maximum age (in hours) to keep saved tool-use sessions before automatic cleanup',
            { min: 1 },
          ),
        })
        .prefault(DEFAULT_CORE_SETTINGS.toolUse.persistence),
    })
    .prefault(DEFAULT_CORE_SETTINGS.toolUse),
};

export const CoreSettingsSchema = z
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
  'ui.showApiKeyReminders',
  'ui.showLoginBanner',
  'ui.showGettingStartedBanner',
  'ui.showOrchestratorBanner',
  'model.useImprovedConnection',
  'model.improvedConnectionDomain',
  'model.useOpenAIResponsesAPI',
  'model.useGoogleInteractionsAPI',
  'model.useGoogleInteractionsServerState',
  'model.useBackgroundResponses',
  'model.openaiParallelToolCalls',
  'model.compactionThresholdPercent',
  'model.gpt5ReasoningSummary',
  'model.retry.maxAttempts',
  'model.retry.backoffMs',
  'chatgptCodex.preferSubscription',
  'chatgptCodex.subscriptionToolUseOnly',
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
  'latex.showLatexindentWarning',
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
  'git.emitPrCiStartedEvents',
  'agentReview.runOnCommit',
  'agentReview.includeSubmodules',
  'agentReview.includeUntrackedFiles',
  'agentReview.approach',
  'agentReview.model',
  'audio.soxPath',
  'logger.debugMode',
  'debug.saveDebugObjects',
  'debug.saveInputPrompt',
  'skills.enabled',
  'toolUse.requireEditApproval',
  'toolUse.requireBashApproval',
  'toolUse.persistence.enabled',
  'toolUse.persistence.ttlHours',
] as const satisfies readonly LeafPaths<CoreSettings>[];

export type CoreSettingPath = (typeof CORE_SETTING_PATHS)[number];

// Build fails if any schema leaf path is missing from CORE_SETTING_PATHS above.
type _AssertCorePathsExhaustive = AssertNever<
  Exclude<LeafPaths<CoreSettings>, CoreSettingPath>
>;
