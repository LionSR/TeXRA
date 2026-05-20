// Third-party imports
import { z } from 'zod';

// Local imports - layered settings schemas
import {
  CoreSettingsShape,
  DEFAULT_CORE_SETTINGS,
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
  type LatexdiffTempFileLocation,
  type NonRegexReplacementCategory,
  type RegexReplacementCategory,
} from './settings/coreSettings';
import {
  DEFAULT_VSCODE_SETTINGS_EXTENSION,
  VscodeSettingsExtensionShape,
} from './settings/vscodeSettings';

// Re-export the core schema's enums and types so existing call sites that
// import them from `@shared/schemas/settingsConfiguration` keep working.
export {
  LATEXDIFF_TEMP_FILE_LOCATIONS,
  NON_REGEX_REPLACEMENT_CATEGORIES,
  REGEX_REPLACEMENT_CATEGORIES,
};
export type {
  LatexdiffTempFileLocation,
  NonRegexReplacementCategory,
  RegexReplacementCategory,
};

/**
 * Canonical default values for the VS Code-facing TeXRA settings tree.
 *
 * This is the composed default object — core defaults plus VS Code-only
 * additions (`auth.enableVSCodeGitHub`, `apiKeys.*`). See `./settings/` for
 * the per-layer defaults.
 */
export const DEFAULT_TEXRA_SETTINGS = {
  ...DEFAULT_CORE_SETTINGS,
  ...DEFAULT_VSCODE_SETTINGS_EXTENSION,
};

/**
 * VS Code-facing TeXRA settings schema.
 *
 * Composed from {@link CoreSettingsShape} (host-neutral) and
 * {@link VscodeSettingsExtensionShape} (VS Code-only). The on-disk shape is
 * identical to the pre-split monolithic schema, so existing call sites
 * (`flattenTexraSettings`, `buildTexraPackageConfiguration`, etc.) see
 * exactly the same parsed object.
 */
export const TexraSettingsSchema = z
  .strictObject({
    ...CoreSettingsShape,
    ...VscodeSettingsExtensionShape,
  })
  .prefault(DEFAULT_TEXRA_SETTINGS);

export type TexraSettings = z.infer<typeof TexraSettingsSchema>;

export const TEXRA_SETTING_PATHS = [
  'agentOutputs.autoOpenFinal',
  'inlineCriticism.enabled',
  'experimental.odyssey.enabled',
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
