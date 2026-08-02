// Standard library imports
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - schemas
import {
  buildTexraPackageConfiguration,
  DEFAULT_TEXRA_SETTINGS,
  flattenTexraSettings,
  getTexraSettingDefault,
  TEXRA_SETTING_KEYS,
  VSCODE_CONTRIBUTED_SETTING_KEYS,
  TEXRA_SETTING_PATHS,
  TexraSettingsSchema,
} from '@extensionSchemas/texraSettings';
import { PROVIDER_VSCODE_SETTINGS } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { MODEL_RETRY_MAX_ATTEMPTS_SETTING } from '@shared/schemas/coreSettings';
import { REPO_ROOT } from '@test/support/repoScan';
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

const packageRequire = createRequire(`${REPO_ROOT}/package.json`);
const packageJson = packageRequire(
  './packages/extension/package.json',
) as PackageJson;

function getPackageConfigurationSections(): PackageConfigurationSection[] {
  const configuration = packageJson.contributes?.configuration;
  if (configuration === undefined) return [];
  return Array.isArray(configuration) ? configuration : [configuration];
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
  it('parses an empty object to the full default tree', () => {
    const parsed = TexraSettingsSchema.parse({});

    assert.equal(parsed.model.compactionThresholdPercent, 75);
    assert.deepEqual(parsed.latex.customReplacements, {});
    assert.equal(parsed.model.useGoogleInteractionsServerState, true);
    assert.deepEqual(parsed, DEFAULT_TEXRA_SETTINGS);
  });

  it('bounds automatic model retries as additional whole attempts', () => {
    const atMaximum = TexraSettingsSchema.parse({
      model: { retry: { maxAttempts: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max } },
    });

    assert.equal(
      atMaximum.model.retry.maxAttempts,
      MODEL_RETRY_MAX_ATTEMPTS_SETTING.max,
    );
    assert.throws(() =>
      TexraSettingsSchema.parse({
        model: {
          retry: { maxAttempts: MODEL_RETRY_MAX_ATTEMPTS_SETTING.max + 1 },
        },
      }),
    );
    assert.throws(() =>
      TexraSettingsSchema.parse({
        model: { retry: { maxAttempts: 1.5 } },
      }),
    );
  });

  it('exposes every TEXRA_SETTING_PATH on the parsed tree', () => {
    const parsed = TexraSettingsSchema.parse({});

    for (const path of TEXRA_SETTING_PATHS) {
      let value: unknown = parsed;
      for (const segment of path.split('.')) {
        value = (value as Record<string, unknown>)[segment];
      }
      assert.notEqual(value, undefined, `path ${path} should resolve`);
    }
  });

  it('flattens the defaults to one entry per setting path', () => {
    const flat = flattenTexraSettings();

    assert.equal(Object.keys(flat).length, TEXRA_SETTING_PATHS.length);
    assert.equal(flat['texra.model.retry.maxAttempts'], 2);
  });

  it('covers every package.json contributed setting key', () => {
    const packageKeys = Object.keys(getPackageConfigurationProperties()).sort();
    const schemaKeys = [...VSCODE_CONTRIBUTED_SETTING_KEYS].sort();

    assert.deepEqual(schemaKeys, packageKeys);
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

  it('keys every provider dashboard group by its lowercased provider id', () => {
    // getProviderVscodeSettings looks these up by `provider.toLowerCase()`, so a
    // camelCase key (e.g. the `kimiCode` provider id) would silently never
    // render its toggles. Enforce the lowercase convention every entry relies
    // on, and confirm the Kimi Code provider resolves to its Prefer switch.
    for (const key of Object.keys(PROVIDER_VSCODE_SETTINGS)) {
      assert.equal(key, key.toLowerCase(), key);
    }
    const kimiCode = (
      PROVIDER_VSCODE_SETTINGS as Record<string, { key: string }[]>
    )['kimiCode'.toLowerCase()];
    assert.ok(
      kimiCode?.some((s) => s.key === GlobalStateKey.KIMI_CODE_PREFER),
      'kimiCode provider must expose the Prefer Kimi Code toggle',
    );
  });

  it('returns isolated flattened setting defaults', () => {
    const defaults = flattenTexraSettings();
    const customReplacements = defaults[
      'texra.latex.customReplacements'
    ] as Record<string, string>;
    customReplacements.mutated = 'value';

    const nextDefaults = flattenTexraSettings();

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
    const customReplacements = getTexraSettingDefault(
      'latex.customReplacements',
    ) as Record<string, string>;
    customReplacements.mutated = 'value';

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

  it('does not contribute TeXRA settings to VS Code', () => {
    assert.deepEqual(VSCODE_CONTRIBUTED_SETTING_KEYS, []);
    assert.deepEqual(getPackageConfigurationSections(), []);
  });

  it('removes former TeXRA settings while preserving unrelated settings', () => {
    const [regenerated] = buildTexraPackageConfiguration([
      {
        title: 'Mixed settings',
        properties: {
          'texra.latex.wrapCritiqueInAlign': { type: 'boolean' },
          'anotherExtension.enabled': { type: 'boolean', default: true },
        },
      },
    ]);

    assert.deepEqual(regenerated, {
      title: 'Mixed settings',
      properties: {
        'anotherExtension.enabled': { type: 'boolean', default: true },
      },
    });
  });

  it('rejects unknown texra package configuration keys', () => {
    const sectionWithUnknownTexraKey = {
      properties: {
        'texra.removed.setting': {
          type: 'boolean',
          default: false,
        },
      },
    };

    assert.throws(
      () => buildTexraPackageConfiguration([sectionWithUnknownTexraKey]),
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
