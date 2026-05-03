// Standard library imports
import { createRequire } from 'module';
import { strict as assert } from 'assert';

// Local imports - schemas
import {
  buildTexraPackageConfiguration,
  flattenTexraSettings,
  TEXRA_SETTING_KEYS,
  TexraSettingsSchema,
} from '@shared/schemas/settingsConfiguration';

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
const packageJson = packageRequire('./package.json') as PackageJson;

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

  it('regenerates package.json contributions from schema metadata', () => {
    const sections = getPackageConfigurationSections();

    assert.deepEqual(buildTexraPackageConfiguration(sections), sections);
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
        latex: { enabledReplacements: ['font_commands'] },
      }),
    );
  });
});
