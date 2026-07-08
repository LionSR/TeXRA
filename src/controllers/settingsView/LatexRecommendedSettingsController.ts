export type LatexRecommendedSettingField = 'outDir' | 'autoRevealExclude';

export interface LatexRecommendedSettingUpdate {
  key: string;
  value: unknown;
}

interface LatexRecommendedSettingsConfig {
  getConfig(key: string): unknown;
  getGlobalValue(key: string): unknown;
  isExplicitlySet(key: string): boolean;
}

export interface LatexRecommendedSettingsControllerDeps {
  config: LatexRecommendedSettingsConfig;
}

/** Recommended LaTeX-related VS Code settings and their target values. */
const LATEX_RECOMMENDED_SETTINGS: {
  key: string;
  value: unknown;
  field: LatexRecommendedSettingField;
  /** Object keys from older TeXRA versions to migrate when writing. */
  legacyKeys?: string[];
}[] = [
  {
    key: 'latex-workshop.latex.outDir',
    value: '%DIR%/build/',
    field: 'outDir',
  },
  {
    key: 'explorer.autoRevealExclude',
    value: { '**/build/': true },
    field: 'autoRevealExclude',
    legacyKeys: ['build/'],
  },
];

export class LatexRecommendedSettingsController {
  constructor(private readonly deps: LatexRecommendedSettingsControllerDeps) {}

  buildUpdates(input: {
    field?: LatexRecommendedSettingField;
    reset: boolean;
  }): LatexRecommendedSettingUpdate[] {
    return this.getTargets(input.field).map(({ key, value, legacyKeys }) => ({
      key,
      value: this.resolveUpdateValue(key, value, legacyKeys, input.reset),
    }));
  }

  isRecommendedValueSet(field: LatexRecommendedSettingField): boolean {
    const setting = LATEX_RECOMMENDED_SETTINGS.find(
      (setting) => setting.field === field,
    );
    if (!setting) return false;
    if (!this.deps.config.isExplicitlySet(setting.key)) return false;

    const current = this.deps.config.getConfig(setting.key);
    if (typeof setting.value === 'object' && setting.value !== null) {
      if (typeof current !== 'object' || current === null) return false;
      const currentObject = current as Record<string, unknown>;
      const recommended = setting.value as Record<string, unknown>;
      return (
        Object.entries(recommended).every(
          ([key, value]) => currentObject[key] === value,
        ) ||
        (setting.legacyKeys?.some((key) => currentObject[key] !== undefined) ??
          false)
      );
    }
    return current === setting.value;
  }

  private getTargets(
    field?: LatexRecommendedSettingField,
  ): typeof LATEX_RECOMMENDED_SETTINGS {
    return field
      ? LATEX_RECOMMENDED_SETTINGS.filter((setting) => setting.field === field)
      : LATEX_RECOMMENDED_SETTINGS;
  }

  private resolveUpdateValue(
    key: string,
    recommendedValue: unknown,
    legacyKeys: string[] | undefined,
    reset: boolean,
  ): unknown {
    if (typeof recommendedValue !== 'object' || recommendedValue === null) {
      return reset ? undefined : recommendedValue;
    }

    const recommended = recommendedValue as Record<string, unknown>;
    const globalValue = this.deps.config.getGlobalValue(key);
    const remaining =
      typeof globalValue === 'object' && globalValue !== null
        ? { ...(globalValue as Record<string, unknown>) }
        : {};

    for (const legacyKey of legacyKeys ?? []) {
      delete remaining[legacyKey];
    }

    if (reset) {
      for (const recommendedKey of Object.keys(recommended)) {
        delete remaining[recommendedKey];
      }
      return Object.keys(remaining).length > 0 ? remaining : undefined;
    }

    return { ...remaining, ...recommended };
  }
}
