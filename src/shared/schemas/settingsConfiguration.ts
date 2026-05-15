// Third-party imports
import { z } from 'zod';

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

export const DEFAULT_TEXRA_SETTINGS = {
  agentOutputs: {
    autoOpenFinal: true,
  },
  inlineCriticism: {
    enabled: false,
  },
  ui: {
    showApiKeyReminders: true,
    showLoginBanner: true,
    showGettingStartedBanner: true,
    showOrchestratorBanner: true,
  },
  auth: {
    enableVSCodeGitHub: false,
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
  apiKeys: {
    set: null,
    remove: null,
  },
  logger: {
    debugMode: false,
  },
  debug: {
    saveDebugObjects: false,
    saveInputPrompt: false,
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

export const TexraSettingsSchema = z
  .strictObject({
    agentOutputs: z
      .strictObject({
        autoOpenFinal: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.agentOutputs.autoOpenFinal),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.agentOutputs),
    inlineCriticism: z
      .strictObject({
        enabled: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.inlineCriticism.enabled),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.inlineCriticism),
    ui: z
      .strictObject({
        showApiKeyReminders: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.ui.showApiKeyReminders),
        showLoginBanner: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.ui.showLoginBanner),
        showGettingStartedBanner: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.ui.showGettingStartedBanner),
        showOrchestratorBanner: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.ui.showOrchestratorBanner),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.ui),
    auth: z
      .strictObject({
        enableVSCodeGitHub: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.auth.enableVSCodeGitHub),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.auth),
    model: z
      .strictObject({
        useImprovedConnection: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.model.useImprovedConnection),
        improvedConnectionDomain: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.model.improvedConnectionDomain),
        useOpenAIResponsesAPI: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.model.useOpenAIResponsesAPI),
        useBackgroundResponses: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.model.useBackgroundResponses),
        openaiParallelToolCalls: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.model.openaiParallelToolCalls),
        compactionThresholdPercent: z
          .number()
          .min(0)
          .max(100)
          .prefault(DEFAULT_TEXRA_SETTINGS.model.compactionThresholdPercent),
        gpt5ReasoningSummary: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.model.gpt5ReasoningSummary),
        retry: z
          .strictObject({
            maxAttempts: z
              .number()
              .min(0)
              .prefault(DEFAULT_TEXRA_SETTINGS.model.retry.maxAttempts),
            backoffMs: z
              .number()
              .min(0)
              .prefault(DEFAULT_TEXRA_SETTINGS.model.retry.backoffMs),
          })
          .prefault(DEFAULT_TEXRA_SETTINGS.model.retry),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.model),
    files: z
      .strictObject({
        included: z
          .strictObject({
            mediaExtensions: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.included.mediaExtensions,
            ),
            inputExtensions: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.included.inputExtensions,
            ),
            contextExtensions: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.included.contextExtensions,
            ),
            editedExtensions: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.included.editedExtensions,
            ),
          })
          .prefault(DEFAULT_TEXRA_SETTINGS.files.included),
        ignored: z
          .strictObject({
            fileExtensions: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.ignored.fileExtensions,
            ),
            inputFiles: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.ignored.inputFiles,
            ),
            inputDirectories: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.ignored.inputDirectories,
            ),
            mediaDirectories: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.ignored.mediaDirectories,
            ),
            directories: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.ignored.directories,
            ),
            keywords: stringArray(
              DEFAULT_TEXRA_SETTINGS.files.ignored.keywords,
            ),
          })
          .prefault(DEFAULT_TEXRA_SETTINGS.files.ignored),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.files),
    maxImageDimension: z
      .number()
      .min(100)
      .max(10000)
      .prefault(DEFAULT_TEXRA_SETTINGS.maxImageDimension),
    bib: z
      .strictObject({
        defaultPath: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.bib.defaultPath),
        zoteroPort: z
          .number()
          .min(1)
          .max(65535)
          .prefault(DEFAULT_TEXRA_SETTINGS.bib.zoteroPort),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.bib),
    latex: z
      .strictObject({
        showLatexindentWarning: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.showLatexindentWarning),
        latexindentConfig: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.latexindentConfig),
        texfmtConfig: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.texfmtConfig),
        tikzInputDirectory: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.tikzInputDirectory),
        tikzTemplate: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.tikzTemplate),
        includeWorkspaceInTexinputs: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.includeWorkspaceInTexinputs),
        wrapCritiqueInAlign: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.wrapCritiqueInAlign),
        enabledReplacements: z
          .array(z.enum(NON_REGEX_REPLACEMENT_CATEGORIES))
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.enabledReplacements),
        enabledReplacementsRegex: z
          .array(z.enum(REGEX_REPLACEMENT_CATEGORIES))
          .prefault(DEFAULT_TEXRA_SETTINGS.latex.enabledReplacementsRegex),
        customReplacementsRegex: stringRecord(
          DEFAULT_TEXRA_SETTINGS.latex.customReplacementsRegex,
        ),
        customReplacements: stringRecord(
          DEFAULT_TEXRA_SETTINGS.latex.customReplacements,
        ),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.latex),
    latexdiff: z
      .strictObject({
        pictureEnvironments: z
          .string()
          .prefault(DEFAULT_TEXRA_SETTINGS.latexdiff.pictureEnvironments),
        tempFileLocation: z
          .enum(LATEXDIFF_TEMP_FILE_LOCATIONS)
          .prefault(DEFAULT_TEXRA_SETTINGS.latexdiff.tempFileLocation),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.latexdiff),
    git: z
      .strictObject({
        numberOfCommitsToShow: z
          .number()
          .min(1)
          .max(100)
          .prefault(DEFAULT_TEXRA_SETTINGS.git.numberOfCommitsToShow),
        emitPrCiStartedEvents: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.git.emitPrCiStartedEvents),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.git),
    audio: z
      .strictObject({
        soxPath: z.string().prefault(DEFAULT_TEXRA_SETTINGS.audio.soxPath),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.audio),
    apiKeys: z
      .strictObject({
        set: z.null().prefault(DEFAULT_TEXRA_SETTINGS.apiKeys.set),
        remove: z.null().prefault(DEFAULT_TEXRA_SETTINGS.apiKeys.remove),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.apiKeys),
    logger: z
      .strictObject({
        debugMode: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.logger.debugMode),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.logger),
    debug: z
      .strictObject({
        saveDebugObjects: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.debug.saveDebugObjects),
        saveInputPrompt: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.debug.saveInputPrompt),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.debug),
    toolUse: z
      .strictObject({
        requireEditApproval: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.toolUse.requireEditApproval),
        requireBashApproval: z
          .boolean()
          .prefault(DEFAULT_TEXRA_SETTINGS.toolUse.requireBashApproval),
        persistence: z
          .strictObject({
            enabled: z
              .boolean()
              .prefault(DEFAULT_TEXRA_SETTINGS.toolUse.persistence.enabled),
            ttlHours: z
              .number()
              .min(1)
              .prefault(DEFAULT_TEXRA_SETTINGS.toolUse.persistence.ttlHours),
          })
          .prefault(DEFAULT_TEXRA_SETTINGS.toolUse.persistence),
      })
      .prefault(DEFAULT_TEXRA_SETTINGS.toolUse),
  })
  .prefault(DEFAULT_TEXRA_SETTINGS);

export type TexraSettings = z.infer<typeof TexraSettingsSchema>;

export const TEXRA_SETTING_PATHS = [
  'agentOutputs.autoOpenFinal',
  'inlineCriticism.enabled',
  'ui.showApiKeyReminders',
  'ui.showLoginBanner',
  'ui.showGettingStartedBanner',
  'ui.showOrchestratorBanner',
  'auth.enableVSCodeGitHub',
  'model.useImprovedConnection',
  'model.improvedConnectionDomain',
  'model.useOpenAIResponsesAPI',
  'model.useBackgroundResponses',
  'model.openaiParallelToolCalls',
  'model.compactionThresholdPercent',
  'model.gpt5ReasoningSummary',
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
  'apiKeys.set',
  'apiKeys.remove',
  'logger.debugMode',
  'debug.saveDebugObjects',
  'debug.saveInputPrompt',
  'toolUse.requireEditApproval',
  'toolUse.requireBashApproval',
  'toolUse.persistence.enabled',
  'toolUse.persistence.ttlHours',
  'model.retry.maxAttempts',
  'model.retry.backoffMs',
] as const;

export type TexraSettingPath = (typeof TEXRA_SETTING_PATHS)[number];
export type TexraSettingKey = `texra.${TexraSettingPath}`;
export type FlatTexraSettings = Record<TexraSettingKey, unknown>;

export const TEXRA_SETTING_KEYS = TEXRA_SETTING_PATHS.map(
  (path) => `texra.${path}` as TexraSettingKey,
);
const TEXRA_SETTING_KEY_SET = new Set<TexraSettingKey>(TEXRA_SETTING_KEYS);

export interface TexraPackageConfigurationProperty {
  type?: string;
  items?: unknown;
  additionalProperties?: unknown;
  default?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  [key: string]: unknown;
}

export interface TexraPackageConfigurationSection {
  title?: string;
  properties?: Record<string, TexraPackageConfigurationProperty>;
  [key: string]: unknown;
}

type JsonSchemaObject = {
  type?: string;
  properties?: Record<string, JsonSchemaObject>;
  items?: unknown;
  additionalProperties?: unknown;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
};

const GENERATED_PACKAGE_SCHEMA_FIELDS = [
  'type',
  'items',
  'additionalProperties',
  'default',
  'enum',
  'minimum',
  'maximum',
] as const;

let texraSettingsJsonSchema: JsonSchemaObject | undefined;
const parsedDefaultTexraSettings = TexraSettingsSchema.parse({});

function getNestedValue(source: unknown, path: TexraSettingPath): unknown {
  let value = source;
  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function cloneSettingValue(value: unknown): unknown {
  return value === undefined ? undefined : structuredClone(value);
}

export function flattenTexraSettings(settings?: unknown): FlatTexraSettings {
  const parsed =
    settings === undefined
      ? parsedDefaultTexraSettings
      : TexraSettingsSchema.parse(settings);
  return Object.fromEntries(
    TEXRA_SETTING_PATHS.map((path) => [
      `texra.${path}` satisfies TexraSettingKey,
      cloneSettingValue(getNestedValue(parsed, path)),
    ]),
  ) as FlatTexraSettings;
}

export function getTexraSettingDefault(path: TexraSettingPath): unknown {
  return cloneSettingValue(getNestedValue(parsedDefaultTexraSettings, path));
}

function getNestedJsonSchema(path: TexraSettingPath): JsonSchemaObject {
  texraSettingsJsonSchema ??= z.toJSONSchema(
    TexraSettingsSchema,
  ) as JsonSchemaObject;
  let schema = texraSettingsJsonSchema;
  for (const segment of path.split('.')) {
    const next = schema.properties?.[segment];
    if (!next) {
      throw new Error(`Missing JSON schema node for setting ${path}`);
    }
    schema = next;
  }
  return schema;
}

function pickPackageSchemaFields(
  schema: JsonSchemaObject,
): TexraPackageConfigurationProperty {
  const property: Record<string, unknown> = {};
  for (const field of GENERATED_PACKAGE_SCHEMA_FIELDS) {
    const value = schema[field];
    if (value !== undefined) {
      property[field] = value;
    }
  }
  return property as TexraPackageConfigurationProperty;
}

function buildTexraPackageConfigurationProperty(
  key: TexraSettingKey,
  existing: TexraPackageConfigurationProperty = {},
): TexraPackageConfigurationProperty {
  const path = key.replace(/^texra\./, '') as TexraSettingPath;
  const generated = pickPackageSchemaFields(getNestedJsonSchema(path));
  if (generated.type !== 'null') {
    generated.default = getTexraSettingDefault(path);
  }
  const property: Record<string, unknown> = { ...existing };
  for (const field of GENERATED_PACKAGE_SCHEMA_FIELDS) {
    const value = generated[field];
    if (value === undefined) {
      delete property[field];
    } else {
      property[field] = value;
    }
  }
  return property as TexraPackageConfigurationProperty;
}

export function buildTexraPackageConfiguration(
  sections: TexraPackageConfigurationSection[],
): TexraPackageConfigurationSection[] {
  const seenKeys = new Set<string>();
  const generatedSections = sections.map((section) => {
    const properties = section.properties;
    if (!properties) {
      return section;
    }

    const generatedProperties = Object.fromEntries(
      Object.entries(properties).map(([key, property]) => {
        if (!TEXRA_SETTING_KEY_SET.has(key as TexraSettingKey)) {
          if (key.startsWith('texra.')) {
            throw new Error(
              `Package configuration contains unknown setting key: ${key}`,
            );
          }
          return [key, property];
        }
        seenKeys.add(key);
        return [
          key,
          buildTexraPackageConfigurationProperty(
            key as TexraSettingKey,
            property,
          ),
        ];
      }),
    );

    return { ...section, properties: generatedProperties };
  });

  const missingKeys = TEXRA_SETTING_KEYS.filter((key) => !seenKeys.has(key));
  if (missingKeys.length > 0) {
    throw new Error(
      `Package configuration is missing setting keys: ${missingKeys.join(', ')}`,
    );
  }

  return generatedSections;
}
