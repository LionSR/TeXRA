// Standard library imports
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - schemas
import {
  buildTexraPackageConfiguration,
  flattenTexraSettings,
  getTexraSettingDefault,
  TEXRA_SETTING_KEYS,
  TexraSettingsSchema,
} from '@extensionSchemas/texraSettings';
import { PROVIDER_VSCODE_SETTINGS } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  getGLMUseChina,
  getMoonshotUseChina,
  getPreferKimiCode,
} from '@utils/config/providerConfig';

interface PackageConfigurationProperty {
  default?: unknown;
  type?: string;
  [key: string]: unknown;
}

interface PackageConfigurationSection {
  properties?: Record<string, PackageConfigurationProperty>;
  [key: string]: unknown;
}

interface PackageJson {
  contributes?: {
    configuration?: PackageConfigurationSection | PackageConfigurationSection[];
  };
}

const packageRequire = createRequire(`${process.cwd()}/package.json`);
const packageJson = packageRequire(
  './packages/extension/package.json',
) as PackageJson;

function getPackageConfigurationSections(): PackageConfigurationSection[] {
  const configuration = packageJson.contributes?.configuration;
  if (!Array.isArray(configuration)) {
    assert.fail('package.json contributes.configuration must be an array');
  }
  return configuration;
}

function getPackageConfigurationProperties(): Record<
  string,
  PackageConfigurationProperty
> {
  return Object.assign(
    {},
    ...getPackageConfigurationSections().map(
      (section) => section.properties ?? {},
    ),
  );
}

describe('TexraSettingsSchema', () => {
  it('parses default settings', () => {
    const parsed = TexraSettingsSchema.parse({});

    assert.equal(parsed.model.compactionThresholdPercent, 75);
    assert.equal(parsed.toolUse.persistence.ttlHours, 336);
    assert.deepEqual(parsed.latex.customReplacements, {});
  });

  it('covers every package.json contributed setting key', () => {
    const packageKeys = Object.keys(getPackageConfigurationProperties()).sort();
    const schemaKeys = [...TEXRA_SETTING_KEYS].sort();

    assert.deepEqual(schemaKeys, packageKeys);
  });

  it('keeps schema defaults aligned with package.json contributions', () => {
    const packageProperties = getPackageConfigurationProperties();
    const defaults = flattenTexraSettings();

    for (const [key, property] of Object.entries(packageProperties)) {
      if (Object.hasOwn(property, 'default')) {
        assert.deepEqual(
          defaults[key as keyof typeof defaults],
          property.default,
          key,
        );
      } else if (property.type === 'null') {
        assert.equal(defaults[key as keyof typeof defaults], null, key);
      }
    }
  });

  it('keeps provider dashboard defaults aligned with behavioral defaults', () => {
    const settingsDefaults = flattenTexraSettings();
    const globalStateDefaults: Record<string, boolean> = {
      [GlobalStateKey.GLM_USE_CHINA]: getGLMUseChina(),
      [GlobalStateKey.MOONSHOT_USE_CHINA]: getMoonshotUseChina(),
      [GlobalStateKey.KIMI_CODE_PREFER]: getPreferKimiCode(),
    };

    for (const setting of Object.values(PROVIDER_VSCODE_SETTINGS).flat()) {
      if (setting.defaultValue === undefined) continue;

      if (Object.hasOwn(settingsDefaults, setting.key)) {
        assert.equal(
          settingsDefaults[setting.key as keyof typeof settingsDefaults],
          setting.defaultValue,
          setting.key,
        );
        continue;
      }

      if (Object.hasOwn(globalStateDefaults, setting.key)) {
        assert.equal(
          globalStateDefaults[setting.key],
          setting.defaultValue,
          setting.key,
        );
        continue;
      }

      assert.fail(`No behavioral default assertion for ${setting.key}`);
    }
  });

  it('returns isolated flattened setting defaults', () => {
    const defaults = flattenTexraSettings();
    const mediaExtensions = defaults[
      'texra.files.included.mediaExtensions'
    ] as string[];
    mediaExtensions.push('.mutated');
    const customReplacements = defaults[
      'texra.latex.customReplacements'
    ] as Record<string, string>;
    customReplacements.mutated = 'value';

    const nextDefaults = flattenTexraSettings();

    assert.equal(
      (
        nextDefaults['texra.files.included.mediaExtensions'] as string[]
      ).includes('.mutated'),
      false,
    );
    assert.equal(
      Object.hasOwn(
        nextDefaults['texra.latex.customReplacements'] as Record<
          string,
          string
        >,
        'mutated',
      ),
      false,
    );
  });

  it('returns isolated individual setting defaults', () => {
    const mediaExtensions = getTexraSettingDefault(
      'files.included.mediaExtensions',
    ) as string[];
    mediaExtensions.push('.mutated');
    const customReplacements = getTexraSettingDefault(
      'latex.customReplacements',
    ) as Record<string, string>;
    customReplacements.mutated = 'value';

    assert.equal(
      (
        getTexraSettingDefault('files.included.mediaExtensions') as string[]
      ).includes('.mutated'),
      false,
    );
    assert.equal(
      Object.hasOwn(
        getTexraSettingDefault('latex.customReplacements') as Record<
          string,
          string
        >,
        'mutated',
      ),
      false,
    );
  });

  it('regenerates package.json contributions from schema metadata', () => {
    const sections = getPackageConfigurationSections();

    assert.deepEqual(buildTexraPackageConfiguration(sections), sections);
  });

  it('removes stale generated package schema fields during regeneration', () => {
    const sections = getPackageConfigurationSections();
    // `order` and `editPresentation` are VS Code-presentation-only fields that
    // stay hand-maintained in package.json (not in the generator allowlist), so
    // they must survive regeneration. `enum` is generated, so a stale value not
    // present in the schema must be removed (compactionThresholdPercent is a
    // plain number with no enum).
    const sectionWithStaleField = {
      ...sections[0],
      properties: {
        ...sections[0].properties,
        'texra.model.compactionThresholdPercent': {
          ...sections[0].properties?.['texra.model.compactionThresholdPercent'],
          order: 999,
          enum: [75],
        },
      },
    };

    const [regenerated] = buildTexraPackageConfiguration([
      sectionWithStaleField,
      ...sections.slice(1),
    ]);
    const regeneratedProperty =
      regenerated.properties?.['texra.model.compactionThresholdPercent'];

    assert.equal(regeneratedProperty?.order, 999);
    assert.equal(Object.hasOwn(regeneratedProperty ?? {}, 'enum'), false);
  });

  it('pairs every enum setting with one description per enum value', () => {
    const packageProperties = getPackageConfigurationProperties();

    for (const [key, property] of Object.entries(packageProperties)) {
      const enumValues = property.enum;
      if (!Array.isArray(enumValues)) {
        continue;
      }
      const enumDescriptions = property.enumDescriptions;
      assert.ok(
        Array.isArray(enumDescriptions),
        `${key} declares enum but no enumDescriptions`,
      );
      assert.equal(
        (enumDescriptions as unknown[]).length,
        enumValues.length,
        key,
      );
    }
  });

  it('rejects unknown texra package configuration keys', () => {
    const sections = getPackageConfigurationSections();
    const sectionWithUnknownTexraKey = {
      ...sections[0],
      properties: {
        ...sections[0].properties,
        'texra.removed.setting': {
          type: 'boolean',
          default: false,
        },
      },
    };

    assert.throws(
      () =>
        buildTexraPackageConfiguration([
          sectionWithUnknownTexraKey,
          ...sections.slice(1),
        ]),
      /unknown setting key: texra\.removed\.setting/,
    );
  });

  it('enforces package numeric ranges and setting enums', () => {
    assert.throws(() =>
      TexraSettingsSchema.parse({ model: { compactionThresholdPercent: 101 } }),
    );
    assert.throws(() => TexraSettingsSchema.parse({ maxImageDimension: 99 }));
    assert.throws(() =>
      TexraSettingsSchema.parse({
        latexdiff: { tempFileLocation: 'workspace' },
      }),
    );
    assert.throws(() =>
      TexraSettingsSchema.parse({
        latex: { enabledReplacements: ['not_a_real_category'] },
      }),
    );
  });
});
