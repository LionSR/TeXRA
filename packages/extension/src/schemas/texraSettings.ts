// Third-party imports
import { z } from 'zod';

// Local imports - shared core/runtime modules
import {
  CORE_SETTING_PATHS,
  CoreSettingsShape,
  DEFAULT_CORE_SETTINGS,
} from '@shared/schemas/coreSettings';

/**
 * Extension view of TeXRA's host-neutral settings. Settings are edited in the
 * native TeXRA view and persisted by the shared configuration provider; none
 * are contributed to VS Code's settings editor.
 */

export const DEFAULT_TEXRA_SETTINGS = DEFAULT_CORE_SETTINGS;

export const TexraSettingsSchema = z
  .strictObject(CoreSettingsShape)
  .prefault(DEFAULT_TEXRA_SETTINGS);

type TexraSettings = z.infer<typeof TexraSettingsSchema>;

export const TEXRA_SETTING_PATHS = [...CORE_SETTING_PATHS] as const;

export type TexraSettingPath = (typeof TEXRA_SETTING_PATHS)[number];
export type TexraSettingKey = `texra.${TexraSettingPath}`;
export type FlatTexraSettings = Record<TexraSettingKey, unknown>;

export const TEXRA_SETTING_KEYS = TEXRA_SETTING_PATHS.map(
  (path) => `texra.${path}` as TexraSettingKey,
);
const TEXRA_SETTING_KEY_SET = new Set<TexraSettingKey>(TEXRA_SETTING_KEYS);

export const VSCODE_CONTRIBUTED_SETTING_KEYS: readonly TexraSettingKey[] = [];

type TexraPackageConfigurationProperty = {
  [key: string]: unknown;
};

export interface TexraPackageConfigurationSection {
  title?: string;
  properties?: Record<string, TexraPackageConfigurationProperty>;
  [key: string]: unknown;
}

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

export function buildTexraPackageConfiguration(
  sections: TexraPackageConfigurationSection[],
): TexraPackageConfigurationSection[] {
  return sections
    .map((section) => {
      const properties = section.properties;
      if (!properties) return section;

      const remainingProperties = Object.fromEntries(
        Object.entries(properties).flatMap(([key, property]) => {
          if (!TEXRA_SETTING_KEY_SET.has(key as TexraSettingKey)) {
            if (key.startsWith('texra.')) {
              throw new Error(
                `Package configuration contains unknown setting key: ${key}`,
              );
            }
            return [[key, property]];
          }
          return [];
        }),
      );

      return { ...section, properties: remainingProperties };
    })
    .filter(
      (section) =>
        section.properties === undefined ||
        Object.keys(section.properties).length > 0,
    );
}
