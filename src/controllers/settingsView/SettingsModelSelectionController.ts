import {
  MODELS,
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import { LEVEL_TO_EFFORT } from '@agent/runtime/reasoningEffort';
import { FREE_TIER, MAX_TIER } from '@auth/sharedConfig';
import {
  DEFAULT_MODELS,
  formatContext,
  formatCost,
} from '@model/modelOptionsBasic';
import {
  DEFAULT_HELPER_MODEL,
  MODEL_PROVIDERS_ORDER,
} from '@shared/constants/providers';
import { isFastFirstResponseModel } from '@shared/constants/fastModels';
import {
  ReasoningLevelSchema,
  type ModelSelectionItem,
  type ReasoningLevel,
} from '@shared/schemas/settingsViewMessages';

export interface SettingsModelSelectionState {
  getEnabledModels(): string[] | undefined;
  setEnabledModels(models: string[]): Promise<void>;
  getHelperModel(): string | undefined;
  setHelperModel(model: string): Promise<void>;
  getReasoningLevelOverrides(): Record<string, string> | undefined;
  setReasoningLevelOverrides(overrides: Record<string, string>): Promise<void>;
  getPreferShortModelNames(): boolean | undefined;
  setPreferShortModelNames(enabled: boolean): Promise<void>;
}

export interface SettingsModelSelectionControllerDeps {
  state: SettingsModelSelectionState;
  modelProviders?: readonly string[];
  useIncludedAccess?: () => boolean;
  getUserTier?: () => string | undefined;
}

export interface SettingsModelSelectionData {
  models: ModelSelectionItem[];
  helperModel: string;
  preferShortModelNames: boolean;
}

const EFFORT_TO_LEVEL = new Map<ReasoningEffort, ReasoningLevel>(
  Object.entries(LEVEL_TO_EFFORT).map(
    ([level, effort]) => [effort, level as ReasoningLevel] as const,
  ),
);

export class SettingsModelSelectionController {
  private readonly modelProviders: Set<string>;

  constructor(private readonly deps: SettingsModelSelectionControllerDeps) {
    this.modelProviders = new Set(deps.modelProviders ?? MODEL_PROVIDERS_ORDER);
  }

  getVisibleModels(): string[] {
    // Normalize at the single read boundary: an empty persisted list (e.g. the
    // user disabled every model) falls back to defaults so downstream consumers
    // — including the helper-model dropdown — never see an empty model set.
    const enabled = this.deps.state.getEnabledModels();
    return enabled && enabled.length > 0 ? enabled : DEFAULT_MODELS;
  }

  buildSelectionData(): SettingsModelSelectionData {
    const visibleModels = this.getVisibleModels();
    return {
      models: this.buildSelectionItems(),
      helperModel: this.getEffectiveHelperModel(visibleModels),
      preferShortModelNames:
        this.deps.state.getPreferShortModelNames() ?? false,
    };
  }

  async setModelEnabled(input: {
    modelName: string;
    enabled: boolean;
  }): Promise<void> {
    const current = this.getVisibleModels();
    const updated = input.enabled
      ? current.includes(input.modelName)
        ? current
        : [...current, input.modelName]
      : current.filter((modelName) => modelName !== input.modelName);
    const wasHelper =
      !input.enabled &&
      this.getEffectiveHelperModel(current) === input.modelName;

    await this.deps.state.setEnabledModels(updated);
    if (wasHelper) {
      await this.deps.state.setHelperModel(updated[0] ?? DEFAULT_HELPER_MODEL);
    }
  }

  async setHelperModel(modelName: string): Promise<void> {
    await this.deps.state.setHelperModel(modelName);
  }

  async setReasoningLevel(input: {
    modelName: string;
    level: ReasoningLevel | null;
  }): Promise<void> {
    const overrides = {
      ...(this.deps.state.getReasoningLevelOverrides() ?? {}),
    };
    if (input.level == null) {
      delete overrides[input.modelName];
    } else {
      overrides[input.modelName] = input.level;
    }
    await this.deps.state.setReasoningLevelOverrides(overrides);
  }

  async setPreferShortModelNames(enabled: boolean): Promise<void> {
    await this.deps.state.setPreferShortModelNames(enabled);
  }

  private buildSelectionItems(): ModelSelectionItem[] {
    const enabledSet = new Set(this.getVisibleModels());
    const reasoningOverrides =
      this.deps.state.getReasoningLevelOverrides() ?? {};

    const items: ModelSelectionItem[] = [];
    for (const name of MODELS) {
      const config = MODEL_CONFIGS[name];
      if (!config || !this.modelProviders.has(config.provider)) continue;

      const item: ModelSelectionItem = {
        name,
        label: config.label,
        provider: config.provider,
        enabled: enabledSet.has(name),
        deprecated: config.deprecated ?? false,
        contextWindow: formatContext(config.contextWindow),
        cost: formatCost(config.inputPrice, config.outputPrice),
        isFast: isFastFirstResponseModel(config.inputPrice),
      };

      this.addReasoningLevelData(item, config, reasoningOverrides[name]);
      items.push(item);
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
  }

  private getEffectiveHelperModel(visibleModels: readonly string[]): string {
    const helperModel = this.deps.state.getHelperModel()?.trim();
    if (!helperModel || helperModel === DEFAULT_HELPER_MODEL) {
      return DEFAULT_HELPER_MODEL;
    }
    if (visibleModels.length === 0 || visibleModels.includes(helperModel)) {
      return helperModel;
    }
    return visibleModels[0] ?? DEFAULT_HELPER_MODEL;
  }

  private addReasoningLevelData(
    item: ModelSelectionItem,
    config: ModelConfig,
    override: string | undefined,
  ): void {
    if (!supportsReasoningLevel(config)) return;

    item.supportsReasoningLevel = true;
    const defaultLevel = EFFORT_TO_LEVEL.get(
      config.capabilities.reasoningEffort,
    );
    if (defaultLevel) {
      item.defaultReasoningLevel = defaultLevel;
    }

    const includedAccessCap = this.getIncludedAccessReasoningCap(config);
    if (includedAccessCap) {
      item.includedAccessReasoningCap = includedAccessCap;
    }

    const parsed = ReasoningLevelSchema.safeParse(override);
    if (parsed.success) {
      item.reasoningLevel = parsed.data;
    }
  }

  private getIncludedAccessReasoningCap(
    config: ModelConfig,
  ): ReasoningLevel | undefined {
    if (
      !this.deps.useIncludedAccess?.() ||
      !config.name.startsWith('gpt5') ||
      config.capabilities.reasoningEffort !== ReasoningEffort.XHIGH
    ) {
      return undefined;
    }

    const userTier = this.deps.getUserTier?.();
    if (userTier === MAX_TIER) return 'high';
    if (userTier === FREE_TIER) return 'medium';
    return undefined;
  }
}

function supportsReasoningLevel(config: ModelConfig): boolean {
  return (
    config.capabilities.supportsReasoningEffort ||
    (config.provider === ModelProvider.DEEPSEEK &&
      config.capabilities.supportsReasoning)
  );
}
