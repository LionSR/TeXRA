import { ModelProvider, type ModelConfig, ReasoningEffort } from 'llm-zoo';

import {
  LEVEL_TO_EFFORT,
  supportsReasoningLevel,
} from '@agent/modelHandlers/support/reasoningEffort';
import { preferredCopilotRouteModels } from '@model/copilotRouting';
import { resolveModelSource } from '@model/openRouterRouting';
import {
  discoveredCopilotRoutes,
  staticModelConfigEntries,
  type CopilotModelRoute,
} from '@model/runtimeModelRegistry';
import { resolveEffectiveHelperModel } from '@model/helperModelSelection';
import { isGpt5ModelName } from '@model/modelNames';
import {
  computeModelOptionsData,
  getEnabledModels,
  setModelEnabled,
} from '@model/computeModelOptions';
import type { StateStore } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  type CopilotRouteInfo,
  type ModelOptionData,
  type ModelSelectionItem,
  type ReasoningLevel,
  type UpdateModelSelectionMessage,
  ReasoningLevelSchema,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  isFastFirstResponseModel,
  MODEL_SOURCE_ORDER,
} from '@shared/constants/providers';
import { byName } from '@utils/core';

export interface SettingsModelSelectionControllerDeps {
  /** Persisted picker state: enabled models, helper model, reasoning levels. */
  globalState: StateStore;
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

/** Membership form of the order the Models tab groups by. */
const MODEL_SELECTION_SOURCES = new Set<string>(MODEL_SOURCE_ORDER);

export class SettingsModelSelectionController {
  constructor(private readonly deps: SettingsModelSelectionControllerDeps) {}

  async buildSelectionData(): Promise<SettingsModelSelectionData> {
    const visibleModels = getEnabledModels(this.deps.globalState);
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
      preferShortModelNames: this.deps.globalState.get<boolean>(
        GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
        false,
      ),
      copilotModels: this.buildCopilotRouteInfos(routes, preferredModels),
    };
  }

  /** Outbound message carrying the full selection payload to the webview. */
  async buildModelSelectionMessage(): Promise<UpdateModelSelectionMessage> {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ...(await this.buildSelectionData()),
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
    await setModelEnabled({
      model: input.modelName,
      enabled: input.enabled,
      state: this.deps.globalState,
    });
  }

  async setHelperModel(modelName: string): Promise<void> {
    await this.deps.globalState.update(GlobalStateKey.HELPER_MODEL, modelName);
  }

  async setReasoningLevel(input: {
    modelName: string;
    level: ReasoningLevel | null;
  }): Promise<void> {
    const overrides = { ...this.getReasoningLevelOverrides() };
    if (input.level == null) {
      delete overrides[input.modelName];
    } else {
      overrides[input.modelName] = input.level;
    }
    await this.deps.globalState.update(
      GlobalStateKey.REASONING_LEVELS,
      overrides,
    );
  }

  private getReasoningLevelOverrides(): Record<string, string> {
    return this.deps.globalState.get<Record<string, string>>(
      GlobalStateKey.REASONING_LEVELS,
      {},
    );
  }

  private async buildSelectionItems(
    copilotRoutes: ReadonlyMap<string, CopilotModelRoute>,
    preferredCopilotModels: ReadonlySet<string>,
  ): Promise<ModelSelectionItem[]> {
    const enabledSet = new Set(getEnabledModels(this.deps.globalState));
    const reasoningOverrides = this.getReasoningLevelOverrides();

    // Resolve availability (personal-key, subscription) once for the
    // models this host shows, via the same shared computation the CLI picker
    // uses. Passing an explicit list keeps the picker's view authoritative and
    // avoids re-deriving availability at render time. Copilot routes are not
    // candidates: they are transports for the canonical base models (#9635).
    const configs = new Map<string, ModelConfig>(staticModelConfigEntries());
    const candidates = [...configs.values()]
      .filter((config) => config.provider !== ModelProvider.COPILOT)
      // The Models tab groups rows by `MODEL_SOURCE_ORDER`, so a config whose
      // resolved source is outside that order can never render as a row.
      // Admitting it anyway would leak it into the serialized `models` payload
      // and — once enabled — into the helper-model dropdown, which does not
      // group. Registry-derived, so a new provider needs no edit here.
      .filter((config) =>
        MODEL_SELECTION_SOURCES.has(
          resolveModelSource(config) ?? config.provider,
        ),
      )
      .map((config) => config.name);
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
      this.deps.globalState.get<string | undefined>(
        GlobalStateKey.HELPER_MODEL,
      ),
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

    const parsed = ReasoningLevelSchema.safeParse(override);
    if (parsed.success) {
      item.reasoningLevel = parsed.data;
    }
  }
}
