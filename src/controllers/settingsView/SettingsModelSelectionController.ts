import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import {
  hasConfigurableReasoningEffort,
  LEVEL_TO_EFFORT,
} from '@agent/modelHandlers/support/reasoningEffort';
import { resolveEffectiveHelperModel } from '@agent/runtime/helperModelName';
import { FREE_TIER, MAX_TIER } from '@auth/sharedConfig';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { isGpt5ModelName } from '@model/modelNames';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import {
  discoveredRuntimeModelConfigEntries,
  staticModelConfigEntries,
} from '@model/runtimeModelRegistry';
import { resolveModelSource } from '@model/openRouterRouting';
import type { ModelOptionData } from '@shared/schemas';
import {
  DEFAULT_HELPER_MODEL,
  MODEL_SOURCE_ORDER,
  isFastFirstResponseModel,
} from '@shared/constants/providers';
import {
  ReasoningLevelSchema,
  type ModelSelectionItem,
  type ReasoningLevel,
} from '@shared/schemas/settingsViewMessages';
import { byName } from '@utils/core';

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
  modelSources?: readonly string[];
  useIncludedAccess?: () => boolean;
  getUserTier?: () => string | undefined;
  getRuntimeModelEntries?: () => Promise<
    readonly (readonly [string, ModelConfig])[]
  >;
  /**
   * Resolve availability-decorated options for the given models. Injected as a
   * port so the controller stays unit-testable; production wiring uses the
   * shared `computeModelOptionsData` — the same source the CLI picker uses.
   */
  resolveModelOptions?: (
    models: readonly string[],
  ) => Promise<ModelOptionData[]>;
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
  private readonly modelSources: Set<string>;

  constructor(private readonly deps: SettingsModelSelectionControllerDeps) {
    this.modelSources = new Set(deps.modelSources ?? MODEL_SOURCE_ORDER);
  }

  getVisibleModels(): string[] {
    // Normalize at the single read boundary: an empty persisted list (e.g. the
    // user disabled every model) falls back to defaults so downstream consumers
    // — including the helper-model dropdown — never see an empty model set.
    const enabled = this.deps.state.getEnabledModels();
    return enabled && enabled.length > 0 ? enabled : DEFAULT_MODELS;
  }

  async buildSelectionData(): Promise<SettingsModelSelectionData> {
    const visibleModels = this.getVisibleModels();
    return {
      models: await this.buildSelectionItems(),
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

    let updated: string[];
    if (!input.enabled) {
      updated = current.filter((modelName) => modelName !== input.modelName);
    } else if (current.includes(input.modelName)) {
      updated = current;
    } else {
      updated = [...current, input.modelName];
    }

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

  private async buildSelectionItems(): Promise<ModelSelectionItem[]> {
    const enabledSet = new Set(this.getVisibleModels());
    const reasoningOverrides =
      this.deps.state.getReasoningLevelOverrides() ?? {};

    // Resolve availability (relay/included, personal-key, quota) once for the
    // models this host shows, via the same shared computation the CLI picker
    // uses. Passing an explicit list keeps the picker's view authoritative and
    // avoids re-deriving availability at render time.
    const runtimeEntries = await (
      this.deps.getRuntimeModelEntries ?? discoveredRuntimeModelConfigEntries
    )();
    const staticEntries = staticModelConfigEntries();
    const configs = new Map<string, ModelConfig>([
      ...staticEntries,
      ...runtimeEntries,
    ]);
    const candidates = [
      ...staticEntries
        .filter(
          ([, config]) =>
            config.provider !== ModelProvider.COPILOT &&
            this.modelSources.has(
              resolveModelSource(config) ?? config.provider,
            ),
        )
        .map(([name]) => name),
      ...runtimeEntries
        .filter(([, config]) =>
          this.modelSources.has(resolveModelSource(config) ?? config.provider),
        )
        .map(([name]) => name),
    ];
    const resolveModelOptions =
      this.deps.resolveModelOptions ?? computeModelOptionsData;
    const optionsData = await resolveModelOptions(candidates);

    const items: ModelSelectionItem[] = [];
    for (const option of optionsData) {
      const name = option.value;
      const config = configs.get(name);
      if (!config) continue;

      const item: ModelSelectionItem = {
        name,
        label: option.label,
        provider: option.provider ?? config.provider,
        enabled: enabledSet.has(name),
        deprecated: config.deprecated ?? false,
        contextWindow: option.context,
        cost: option.cost,
        isFast: isFastFirstResponseModel(config.inputPrice),
        availability: option.availability,
        availabilityLabel: option.availabilityLabel,
        requiresKey: option.requiresKey,
        disabled: option.disabled,
      };

      this.addReasoningLevelData(item, config, reasoningOverrides[name]);
      items.push(item);
    }

    return items.sort(byName);
  }

  private getEffectiveHelperModel(visibleModels: readonly string[]): string {
    return resolveEffectiveHelperModel(
      this.deps.state.getHelperModel(),
      visibleModels,
    );
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
      !isGpt5ModelName(config.name) ||
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
    hasConfigurableReasoningEffort(config.capabilities) ||
    (config.provider === ModelProvider.DEEPSEEK &&
      config.capabilities.supportsReasoning)
  );
}
