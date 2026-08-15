import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import {
  hasConfigurableReasoningEffort,
  LEVEL_TO_EFFORT,
} from '@agent/modelHandlers/support/reasoningEffort';
import { FREE_TIER, MAX_TIER } from '@auth/config';
import { preferredCopilotRouteModels } from '@model/copilotRouting';
import { resolveModelSource } from '@model/openRouterRouting';
import {
  discoveredCopilotRoutes,
  staticModelConfigEntries,
  type CopilotModelRoute,
} from '@model/runtimeModelRegistry';
import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import { DEFAULT_MODELS } from '@model/modelOptionsBasic';
import { isGpt5ModelName } from '@model/modelNames';
import { computeModelOptionsData } from '@model/computeModelOptions';
import type {
  CopilotRouteInfo,
  ModelOptionData,
  ModelSelectionItem,
  ReasoningLevel,
} from '@shared/schemas';
import { ReasoningLevelSchema } from '@shared/schemas';
import {
  DEFAULT_HELPER_MODEL,
  MODEL_SOURCE_ORDER,
  isFastFirstResponseModel,
} from '@shared/constants/providers';
import { byName } from '@utils/core';

export interface SettingsModelSelectionState {
  getEnabledModels(): readonly string[] | undefined;
  setEnabledModels(models: readonly string[]): Promise<void>;
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
  getCopilotRoutes?: () => Promise<ReadonlyMap<string, CopilotModelRoute>>;
  getPreferredCopilotRouteModels?: () => readonly string[];
  /**
   * Resolve availability-decorated options for the given models. Injected as a
   * port so the controller stays unit-testable; production wiring uses the
   * shared `computeModelOptionsData` — the same source the CLI picker uses.
   */
  resolveModelOptions?: (
    models: readonly string[],
  ) => Promise<ModelOptionData[]>;
}

interface SettingsModelSelectionData {
  models: ModelSelectionItem[];
  helperModel: string;
  preferShortModelNames: boolean;
  copilotModels: CopilotRouteInfo[];
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

  getVisibleModels(): readonly string[] {
    // Normalize at the single read boundary: an empty persisted list (e.g. the
    // user disabled every model) falls back to defaults so downstream consumers
    // — including the helper-model dropdown — never see an empty model set.
    const enabled = this.deps.state.getEnabledModels();
    return enabled && enabled.length > 0 ? enabled : DEFAULT_MODELS;
  }

  async buildSelectionData(): Promise<SettingsModelSelectionData> {
    const visibleModels = this.getVisibleModels();
    const routes = await (
      this.deps.getCopilotRoutes ?? discoveredCopilotRoutes
    )();
    const preferredModels = new Set(
      (
        this.deps.getPreferredCopilotRouteModels ?? preferredCopilotRouteModels
      )(),
    );
    return {
      models: await this.buildSelectionItems(routes, preferredModels),
      helperModel: this.getEffectiveHelperModel(visibleModels),
      preferShortModelNames:
        this.deps.state.getPreferShortModelNames() ?? false,
      copilotModels: this.buildCopilotRouteInfos(routes, preferredModels),
    };
  }

  /**
   * Route status for the Models tab Copilot section: every discovered route
   * plus every persisted preference, labelled by the base model it serves.
   * A preferred route absent from discovery remains visible as unavailable so
   * the user can clear it. Routes are transports, never picker rows.
   */
  private buildCopilotRouteInfos(
    routes: ReadonlyMap<string, CopilotModelRoute>,
    preferredModels: ReadonlySet<string>,
  ): CopilotRouteInfo[] {
    const configs = new Map(staticModelConfigEntries());
    const names = new Set([...routes.keys(), ...preferredModels]);
    return [...names].map((name) => ({
      name,
      label: configs.get(name)?.label ?? name,
      access: routes.get(name)?.access ?? 'unavailable',
      preferred: preferredModels.has(name),
    }));
  }

  async setModelEnabled(input: {
    modelName: string;
    enabled: boolean;
  }): Promise<void> {
    const current = this.getVisibleModels();

    let updated: readonly string[];
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
      await this.deps.state.setHelperModel(DEFAULT_HELPER_MODEL);
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

  private async buildSelectionItems(
    copilotRoutes: ReadonlyMap<string, CopilotModelRoute>,
    preferredCopilotModels: ReadonlySet<string>,
  ): Promise<ModelSelectionItem[]> {
    const enabledSet = new Set(this.getVisibleModels());
    const reasoningOverrides =
      this.deps.state.getReasoningLevelOverrides() ?? {};

    // Resolve availability (relay/included, personal-key, quota) once for the
    // models this host shows, via the same shared computation the CLI picker
    // uses. Passing an explicit list keeps the picker's view authoritative and
    // avoids re-deriving availability at render time. Copilot routes are not
    // candidates: they are transports for the canonical base models (#9635).
    const configEntries = staticModelConfigEntries();
    const configs = new Map<string, ModelConfig>(configEntries);
    const candidates = configEntries
      .filter(
        ([, config]) =>
          config.provider !== ModelProvider.COPILOT &&
          this.modelSources.has(resolveModelSource(config) ?? config.provider),
      )
      .map(([name]) => name);
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
        // Catalogue placement is a stable registry fact. `option.provider`
        // describes the effective request route and may change with credentials.
        provider: resolveModelSource(config) ?? config.provider,
        routeLabel: option.routeLabel,
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

      const copilotRoute = copilotRoutes.get(name);
      const effectiveConfig =
        preferredCopilotModels.has(name) && copilotRoute?.access === 'allowed'
          ? copilotRoute.effectiveConfig
          : config;
      this.addReasoningLevelData(
        item,
        effectiveConfig,
        reasoningOverrides[name],
      );
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
