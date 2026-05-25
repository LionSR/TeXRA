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
  'latex_xml',
  'latex_document',
  'unicode',
  'html_entities',
  'scratchpad_xml',
  'latexdiff',
  'gptness',
  'personal_style',
  'max_style',
] as const;

export const REGEX_REPLACEMENT_CATEGORIES = [
  'inline_math',
  'parentheses',
  'latexdiff_markup',
  'equation_style',
  'equation_macros',
  'max_style_regex',
] as const;

export const LATEXDIFF_TEMP_FILE_LOCATIONS = [
  'sameDirectory',
  'workspaceTemp',
] as const;

export type NonRegexReplacementCategory =
  (typeof NON_REGEX_REPLACEMENT_CATEGORIES)[number];
export type RegexReplacementCategory =
  (typeof REGEX_REPLACEMENT_CATEGORIES)[number];
export type LatexdiffTempFileLocation =
  (typeof LATEXDIFF_TEMP_FILE_LOCATIONS)[number];

export const DEFAULT_CORE_SETTINGS = {
  agentOutputs: {
    autoOpenFinal: true,
  },
  inlineCriticism: {
    enabled: false,
  },
  experimental: {
    odyssey: {
      enabled: false,
    },
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
    useBackgroundResponses: true,
    openaiParallelToolCalls: false,
    compactionThresholdPercent: 75,
    gpt5ReasoningSummary: false,
    retry: {
      maxAttempts: 0,
      backoffMs: 1000,
    },
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
      'latex_xml',
      'latex_document',
      'unicode',
      'html_entities',
      'scratchpad_xml',
      'latexdiff',
      'gptness',
    ] satisfies NonRegexReplacementCategory[],
    enabledReplacementsRegex: [
      'inline_math',
      'parentheses',
      'latexdiff_markup',
      'equation_style',
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

const stringArray = (defaultValue: string[]) =>
  z.array(z.string()).prefault(defaultValue);

const stringRecord = (defaultValue: Record<string, string>) =>
  z.record(z.string(), z.string()).prefault(defaultValue);

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
      autoOpenFinal: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.agentOutputs.autoOpenFinal),
    })
    .prefault(DEFAULT_CORE_SETTINGS.agentOutputs),
  inlineCriticism: z
    .strictObject({
      enabled: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.inlineCriticism.enabled),
    })
    .prefault(DEFAULT_CORE_SETTINGS.inlineCriticism),
  experimental: z
    .strictObject({
      odyssey: z
        .strictObject({
          enabled: z
            .boolean()
            .prefault(DEFAULT_CORE_SETTINGS.experimental.odyssey.enabled),
        })
        .prefault(DEFAULT_CORE_SETTINGS.experimental.odyssey),
    })
    .prefault(DEFAULT_CORE_SETTINGS.experimental),
  ui: z
    .strictObject({
      showApiKeyReminders: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.ui.showApiKeyReminders),
      showLoginBanner: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.ui.showLoginBanner),
      showGettingStartedBanner: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.ui.showGettingStartedBanner),
      showOrchestratorBanner: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.ui.showOrchestratorBanner),
    })
    .prefault(DEFAULT_CORE_SETTINGS.ui),
  model: z
    .strictObject({
      useImprovedConnection: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.model.useImprovedConnection),
      improvedConnectionDomain: z
        .string()
        .prefault(DEFAULT_CORE_SETTINGS.model.improvedConnectionDomain),
      useOpenAIResponsesAPI: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.model.useOpenAIResponsesAPI),
      useBackgroundResponses: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.model.useBackgroundResponses),
      openaiParallelToolCalls: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.model.openaiParallelToolCalls),
      compactionThresholdPercent: z
        .number()
        .min(0)
        .max(100)
        .prefault(DEFAULT_CORE_SETTINGS.model.compactionThresholdPercent),
      gpt5ReasoningSummary: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.model.gpt5ReasoningSummary),
      retry: z
        .strictObject({
          maxAttempts: z
            .number()
            .min(0)
            .prefault(DEFAULT_CORE_SETTINGS.model.retry.maxAttempts),
          backoffMs: z
            .number()
            .min(0)
            .prefault(DEFAULT_CORE_SETTINGS.model.retry.backoffMs),
        })
        .prefault(DEFAULT_CORE_SETTINGS.model.retry),
    })
    .prefault(DEFAULT_CORE_SETTINGS.model),
  files: z
    .strictObject({
      included: z
        .strictObject({
          mediaExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.mediaExtensions,
          ),
          inputExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.inputExtensions,
          ),
          contextExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.contextExtensions,
          ),
          editedExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.included.editedExtensions,
          ),
        })
        .prefault(DEFAULT_CORE_SETTINGS.files.included),
      ignored: z
        .strictObject({
          fileExtensions: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.fileExtensions,
          ),
          inputFiles: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.inputFiles,
          ),
          inputDirectories: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.inputDirectories,
          ),
          mediaDirectories: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.mediaDirectories,
          ),
          directories: stringArray(
            DEFAULT_CORE_SETTINGS.files.ignored.directories,
          ),
          keywords: stringArray(DEFAULT_CORE_SETTINGS.files.ignored.keywords),
        })
        .prefault(DEFAULT_CORE_SETTINGS.files.ignored),
    })
    .prefault(DEFAULT_CORE_SETTINGS.files),
  maxImageDimension: z
    .number()
    .min(100)
    .max(10000)
    .prefault(DEFAULT_CORE_SETTINGS.maxImageDimension),
  bib: z
    .strictObject({
      defaultPath: z.string().prefault(DEFAULT_CORE_SETTINGS.bib.defaultPath),
      zoteroPort: z
        .number()
        .min(1)
        .max(65535)
        .prefault(DEFAULT_CORE_SETTINGS.bib.zoteroPort),
    })
    .prefault(DEFAULT_CORE_SETTINGS.bib),
  latex: z
    .strictObject({
      showLatexindentWarning: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.latex.showLatexindentWarning),
      latexindentConfig: z
        .string()
        .prefault(DEFAULT_CORE_SETTINGS.latex.latexindentConfig),
      texfmtConfig: z
        .string()
        .prefault(DEFAULT_CORE_SETTINGS.latex.texfmtConfig),
      tikzInputDirectory: z
        .string()
        .prefault(DEFAULT_CORE_SETTINGS.latex.tikzInputDirectory),
      tikzTemplate: z
        .string()
        .prefault(DEFAULT_CORE_SETTINGS.latex.tikzTemplate),
      includeWorkspaceInTexinputs: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.latex.includeWorkspaceInTexinputs),
      wrapCritiqueInAlign: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.latex.wrapCritiqueInAlign),
      enabledReplacements: z
        .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
        .prefault(DEFAULT_CORE_SETTINGS.latex.enabledReplacements),
      enabledReplacementsRegex: z
        .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
        .prefault(DEFAULT_CORE_SETTINGS.latex.enabledReplacementsRegex),
      customReplacementsRegex: stringRecord(
        DEFAULT_CORE_SETTINGS.latex.customReplacementsRegex,
      ),
      customReplacements: stringRecord(
        DEFAULT_CORE_SETTINGS.latex.customReplacements,
      ),
    })
    .prefault(DEFAULT_CORE_SETTINGS.latex),
  latexdiff: z
    .strictObject({
      pictureEnvironments: z
        .string()
        .prefault(DEFAULT_CORE_SETTINGS.latexdiff.pictureEnvironments),
      tempFileLocation: z
        .enum(LATEXDIFF_TEMP_FILE_LOCATIONS)
        .prefault(DEFAULT_CORE_SETTINGS.latexdiff.tempFileLocation),
    })
    .prefault(DEFAULT_CORE_SETTINGS.latexdiff),
  git: z
    .strictObject({
      numberOfCommitsToShow: z
        .number()
        .min(1)
        .max(100)
        .prefault(DEFAULT_CORE_SETTINGS.git.numberOfCommitsToShow),
      emitPrCiStartedEvents: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.git.emitPrCiStartedEvents),
    })
    .prefault(DEFAULT_CORE_SETTINGS.git),
  audio: z
    .strictObject({
      soxPath: z.string().prefault(DEFAULT_CORE_SETTINGS.audio.soxPath),
    })
    .prefault(DEFAULT_CORE_SETTINGS.audio),
  logger: z
    .strictObject({
      debugMode: z.boolean().prefault(DEFAULT_CORE_SETTINGS.logger.debugMode),
    })
    .prefault(DEFAULT_CORE_SETTINGS.logger),
  debug: z
    .strictObject({
      saveDebugObjects: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.debug.saveDebugObjects),
      saveInputPrompt: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.debug.saveInputPrompt),
    })
    .prefault(DEFAULT_CORE_SETTINGS.debug),
  skills: z
    .strictObject({
      enabled: z.boolean().prefault(DEFAULT_CORE_SETTINGS.skills.enabled),
    })
    .prefault(DEFAULT_CORE_SETTINGS.skills),
  toolUse: z
    .strictObject({
      requireEditApproval: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.toolUse.requireEditApproval),
      requireBashApproval: z
        .boolean()
        .prefault(DEFAULT_CORE_SETTINGS.toolUse.requireBashApproval),
      persistence: z
        .strictObject({
          enabled: z
            .boolean()
            .prefault(DEFAULT_CORE_SETTINGS.toolUse.persistence.enabled),
          ttlHours: z
            .number()
            .min(1)
            .prefault(DEFAULT_CORE_SETTINGS.toolUse.persistence.ttlHours),
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
 * Dotted leaf paths for every Core setting.
 *
 * Used by per-host "known TeXRA key" sets to derive `texra.*` prefixed key
 * lists for typo detection without hand-maintaining the list in each host.
 */
export const CORE_SETTING_PATHS = [
  'agentOutputs.autoOpenFinal',
  'inlineCriticism.enabled',
  'experimental.odyssey.enabled',
  'ui.showApiKeyReminders',
  'ui.showLoginBanner',
  'ui.showGettingStartedBanner',
  'ui.showOrchestratorBanner',
  'model.useImprovedConnection',
  'model.improvedConnectionDomain',
  'model.useOpenAIResponsesAPI',
  'model.useBackgroundResponses',
  'model.openaiParallelToolCalls',
  'model.compactionThresholdPercent',
  'model.gpt5ReasoningSummary',
  'model.retry.maxAttempts',
  'model.retry.backoffMs',
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
  'audio.soxPath',
  'logger.debugMode',
  'debug.saveDebugObjects',
  'debug.saveInputPrompt',
  'skills.enabled',
  'toolUse.requireEditApproval',
  'toolUse.requireBashApproval',
  'toolUse.persistence.enabled',
  'toolUse.persistence.ttlHours',
] as const;

export type CoreSettingPath = (typeof CORE_SETTING_PATHS)[number];
