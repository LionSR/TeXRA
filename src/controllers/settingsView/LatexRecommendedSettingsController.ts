type LatexRecommendedSettingField = 'outDir' | 'autoRevealExclude';

interface LatexRecommendedSettingUpdate {
  key: string;
  value: unknown;
}

interface LatexRecommendedSettingsConfig {
  getConfig(key: string): unknown;
  getGlobalValue(key: string): unknown;
  isExplicitlySet(key: string): boolean;
}

interface LatexRecommendedSettingsControllerDeps {
  config: LatexRecommendedSettingsConfig;
}

/** A recommended setting whose target value is a single scalar. */
interface LatexRecommendedScalarSetting {
  kind: 'scalar';
  key: string;
  value: string;
  field: LatexRecommendedSettingField;
}

/**
 * A recommended setting whose target value is an object merged key-by-key
 * into whatever the user already has set (rather than overwritten wholesale).
 */
interface LatexRecommendedObjectSetting {
  kind: 'object';
  key: string;
  value: Record<string, unknown>;
  field: LatexRecommendedSettingField;
}

type LatexRecommendedSetting =
  LatexRecommendedScalarSetting | LatexRecommendedObjectSetting;

/** Recommended LaTeX-related VS Code settings and their target values. */
const LATEX_RECOMMENDED_SETTINGS: LatexRecommendedSetting[] = [
  {
    kind: 'scalar',
    key: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    field: 'outDir',
  },
  {
    kind: 'object',
    key: 'explorer.autoRevealExclude',
    value: { '**/build/': true },
    field: 'autoRevealExclude',
  },
];

export class LatexRecommendedSettingsController {
  constructor(private readonly deps: LatexRecommendedSettingsControllerDeps) {}

  buildUpdates(input: {
    field?: LatexRecommendedSettingField;
    reset: boolean;
  }): LatexRecommendedSettingUpdate[] {
    const targets = input.field
      ? LATEX_RECOMMENDED_SETTINGS.filter(
          (setting) => setting.field === input.field,
        )
      : LATEX_RECOMMENDED_SETTINGS;

    return targets.map((setting) => ({
      key: setting.key,
      value: this.resolveUpdateValue(setting, input.reset),
    }));
  }

  isRecommendedValueSet(field: LatexRecommendedSettingField): boolean {
    const setting = LATEX_RECOMMENDED_SETTINGS.find(
      (setting) => setting.field === field,
    );
    if (!setting) return false;
    if (!this.deps.config.isExplicitlySet(setting.key)) return false;

    const current = this.deps.config.getConfig(setting.key);
    if (setting.kind === 'scalar') {
      return current === setting.value;
    }

    if (typeof current !== 'object' || current === null) return false;
    const currentObject = current as Record<string, unknown>;
    return Object.entries(setting.value).every(
      ([key, value]) => currentObject[key] === value,
    );
  }

  private resolveUpdateValue(
    setting: LatexRecommendedSetting,
    reset: boolean,
  ): unknown {
    if (setting.kind === 'scalar') {
      return reset ? undefined : setting.value;
    }

    const globalValue = this.deps.config.getGlobalValue(setting.key);
    const remaining =
      typeof globalValue === 'object' && globalValue !== null
        ? { ...(globalValue as Record<string, unknown>) }
        : {};

    if (reset) {
      for (const recommendedKey of Object.keys(setting.value)) {
        delete remaining[recommendedKey];
      }
      return Object.keys(remaining).length > 0 ? remaining : undefined;
    }

    return { ...remaining, ...setting.value };
  }
}
