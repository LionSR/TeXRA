// Third-party imports
import { z } from 'zod';

// Local imports - shared core/runtime modules
import { stripPrefix } from '@shared/config/configKeys';
import {
  CORE_SETTING_PATHS,
  CoreSettingsShape,
  DEFAULT_CORE_SETTINGS,
} from '@shared/schemas/coreSettings';

// Local imports - VS Code extension schema
import {
  DEFAULT_VSCODE_SETTINGS_EXTENSION,
  VSCODE_SETTING_PATHS,
  VscodeSettingsExtensionShape,
} from './vscodeSettings';

/**
 * VS Code-facing TeXRA settings — Core + VS Code-only extension.
 *
 * This file lives in the extension package because it composes a host-specific
 * view of the settings tree (with VS Code-only entries like
 * `auth.enableVSCodeGitHub` and the `apiKeys.set` / `apiKeys.remove` UI
 * triggers) and provides the JSON-schema generator + flattener used to keep
 * `packages/extension/package.json` aligned with the Zod definitions.
 *
 * Other hosts compose their own equivalents (`CliSettingsSchema`,
 * `DesktopSettingsSchema`) in their own packages, all rooted at the same
 * shared {@link CoreSettingsShape}.
 */

export const DEFAULT_TEXRA_SETTINGS = {
  ...DEFAULT_CORE_SETTINGS,
  ...DEFAULT_VSCODE_SETTINGS_EXTENSION,
};

export const TexraSettingsSchema = z
  .strictObject({
    ...CoreSettingsShape,
    ...VscodeSettingsExtensionShape,
  })
  .prefault(DEFAULT_TEXRA_SETTINGS);

type TexraSettings = z.infer<typeof TexraSettingsSchema>;

export const TEXRA_SETTING_PATHS = [
  ...CORE_SETTING_PATHS,
  ...VSCODE_SETTING_PATHS,
] as const;

export type TexraSettingPath = (typeof TEXRA_SETTING_PATHS)[number];
export type TexraSettingKey = `texra.${TexraSettingPath}`;
export type FlatTexraSettings = Record<TexraSettingKey, unknown>;

export const TEXRA_SETTING_KEYS = TEXRA_SETTING_PATHS.map(
  (path) => `texra.${path}` as TexraSettingKey,
);
const TEXRA_SETTING_KEY_SET = new Set<TexraSettingKey>(TEXRA_SETTING_KEYS);

interface TexraPackageConfigurationProperty {
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
  description?: string;
  enumDescriptions?: unknown[];
};

const GENERATED_PACKAGE_SCHEMA_FIELDS = [
  'type',
  'items',
  'additionalProperties',
  'default',
  'enum',
  'minimum',
  'maximum',
  'description',
  'enumDescriptions',
] as const;

let texraSettingsJsonSchema: JsonSchemaObject | undefined;
let parsedDefaultTexraSettings: TexraSettings | undefined;

function getParsedDefaults(): TexraSettings {
  return (parsedDefaultTexraSettings ??= TexraSettingsSchema.parse({}));
}

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
      ? getParsedDefaults()
      : TexraSettingsSchema.parse(settings);
  return Object.fromEntries(
    TEXRA_SETTING_PATHS.map((path) => [
      `texra.${path}` satisfies TexraSettingKey,
      cloneSettingValue(getNestedValue(parsed, path)),
    ]),
  ) as FlatTexraSettings;
}

export function getTexraSettingDefault(path: TexraSettingPath): unknown {
  return cloneSettingValue(getNestedValue(getParsedDefaults(), path));
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

function buildTexraPackageConfigurationProperty(
  key: TexraSettingKey,
  existing: TexraPackageConfigurationProperty = {},
): TexraPackageConfigurationProperty {
  const path = stripPrefix(key) as TexraSettingPath;
  const schema = getNestedJsonSchema(path);
  // Regenerate every managed field from the Zod-derived JSON schema, replacing
  // whatever the package.json copy held. Non-null settings take their default
  // from the parsed schema defaults rather than the raw JSON schema node.
  const property: Record<string, unknown> = { ...existing };
  for (const field of GENERATED_PACKAGE_SCHEMA_FIELDS) {
    const value =
      field === 'default' && schema.type !== 'null'
        ? getTexraSettingDefault(path)
        : schema[field];
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
