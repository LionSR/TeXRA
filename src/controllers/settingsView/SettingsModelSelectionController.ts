// Third-party imports
import { Effect } from 'effect';
import {
  MODEL_CONFIGS,
  ModelProvider,
  type ModelConfig,
  type ReasoningEffort,
} from 'llm-zoo';

// Local imports
import { getHelperModelName } from '@agent/runtime/helperModelName';
import {
  reasoningEffortOverrides,
  supportsReasoningLevel,
} from '@model/reasoningLevel';
import {
  preferredCopilotRouteModels,
  type CopilotModelRoute,
} from '@model/copilotRouting';
import { resolveModelSource } from '@model/openRouterRouting';
import {
  getEnabledModels,
  setModelEnabled,
  type ModelOptionStores,
} from '@model/computeModelOptions';
import { StateReadFailed, StateWriteFailed } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { type ModelOptionData } from '@shared/schemas';
import {
  type CopilotRouteInfo,
  type ModelSelectionItem,
  type UpdateModelSelectionMessage,
} from '@shared/settingsView/settingsViewMessages';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  isExpensiveModel,
  isFastFirstResponseModel,
  MODEL_SOURCE_ORDER,
} from '@shared/constants/providers';
import { byName } from '@utils/core';
import { readSettingFrom } from '@utils/config/platformSettings';

interface SettingsModelSelectionControllerDeps<R> {
  /**
   * The three setting slots this tab answers for. `globalState` holds the
   * persisted picker state (enabled models, helper model, reasoning levels);
   * all three are what the availability read resolves the routing switches
   * against, so the rows show the values a run will honor.
   */
  stores: SettingsStores;
  /** Provider credentials behind the availability decoration on each option. */
  secrets: PlatformSecrets;
  /**
   * The Copilot routes the editor offers now (`discoverCopilotRoutes` over
   * the host's language-model port). This controller composes the read and
   * hands the result back as one program the host settles at its message
   * boundary.
   */
  copilotRoutes: Effect.Effect<
    ReadonlyMap<string, CopilotModelRoute>,
    Error,
    R
  >;
  getPreferredCopilotRouteModels?: () => Effect.Effect<
    readonly string[],
    StateReadFailed
  >;
  /**
   * Resolve availability-decorated options for the given models, reading the
   * shared availability inputs and finishing them with `modelOptionsFrom` —
   * the same source the CLI picker uses.
   */
  resolveModelOptions: (
    stores: ModelOptionStores,
    models: readonly string[],
  ) => Effect.Effect<ModelOptionData[], Error, R>;
}

interface SettingsModelSelectionData {
  models: ModelSelectionItem[];
  helperModel: string;
  preferShortModelNames: boolean;
  copilotModels: CopilotRouteInfo[];
}

/** Membership form of the order the Models tab groups by. */
const MODEL_SELECTION_SOURCES = new Set<string>(MODEL_SOURCE_ORDER);

export class SettingsModelSelectionController<R = never> {
  constructor(private readonly deps: SettingsModelSelectionControllerDeps<R>) {}

  buildSelectionData(): Effect.Effect<SettingsModelSelectionData, Error, R> {
    return Effect.gen({ self: this }, function* () {
      // A failed discovery shows every preferred route as unavailable; the
      // port has already logged the failure at `warn`.
      const routes = yield* this.deps.copilotRoutes.pipe(
        Effect.orElseSucceed(
          (): ReadonlyMap<string, CopilotModelRoute> => new Map(),
        ),
      );
      const preferredModels = new Set(
        yield* this.deps.getPreferredCopilotRouteModels?.() ??
          preferredCopilotRouteModels(this.deps.stores.globalState),
      );
      const models = yield* this.buildSelectionItems(routes, preferredModels);
      return {
        models,
        helperModel: yield* getHelperModelName(this.deps.stores),
        preferShortModelNames: yield* readSettingFrom<boolean>(
          this.deps.stores,
          GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
        ),
        copilotModels: this.buildCopilotRouteInfos(routes, preferredModels),
      };
    });
  }

  /** Outbound message carrying the full selection payload to the webview. */
  buildModelSelectionMessage(): Effect.Effect<
    UpdateModelSelectionMessage,
    Error,
    R
  > {
    return Effect.map(this.buildSelectionData(), (data) => ({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ...data,
    }));
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
    const configs = new Map(Object.entries(MODEL_CONFIGS));
    const names = new Set([...routes.keys(), ...preferredModels]);
    return [...names].map((name) => ({
      name,
      label: configs.get(name)?.label ?? name,
      access: routes.get(name)?.access ?? 'unavailable',
      preferred: preferredModels.has(name),
    }));
  }

  setModelEnabled(input: {
    modelName: string;
    enabled: boolean;
  }): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
    return setModelEnabled({
      model: input.modelName,
      enabled: input.enabled,
      state: this.deps.stores.globalState,
    }).pipe(Effect.asVoid);
  }

  setReasoningLevel(input: {
    modelName: string;
    level: ReasoningEffort | null;
  }): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
    return Effect.gen({ self: this }, function* () {
      // The stored override record as written, so a rewrite carries every entry
      // back to storage. Reads that need the effort go through
      // `reasoningEffortOverrides`.
      const overrides = {
        ...(yield* this.deps.stores.globalState.get<Record<string, string>>(
          GlobalStateKey.REASONING_LEVELS,
          {},
        )),
      };
      if (input.level == null) {
        delete overrides[input.modelName];
      } else {
        overrides[input.modelName] = input.level;
      }
      yield* this.deps.stores.globalState.update(
        GlobalStateKey.REASONING_LEVELS,
        overrides,
      );
    });
  }

  private buildSelectionItems(
    copilotRoutes: ReadonlyMap<string, CopilotModelRoute>,
    preferredCopilotModels: ReadonlySet<string>,
  ): Effect.Effect<ModelSelectionItem[], Error, R> {
    return Effect.gen({ self: this }, function* () {
      const enabledSet = new Set(
        yield* getEnabledModels(this.deps.stores.globalState),
      );
      const reasoningOverrides = yield* reasoningEffortOverrides(
        this.deps.stores.globalState,
      );

      // Resolve availability (personal-key, subscription) once for the
      // models this host shows, via the same shared computation the CLI picker
      // uses. Passing an explicit list keeps the picker's view authoritative and
      // avoids re-deriving availability at render time. Copilot routes are not
      // candidates: they are transports for the canonical base models (#9635).
      const configs = new Map<string, ModelConfig>(
        Object.entries(MODEL_CONFIGS),
      );
      const candidates = [...configs.values()]
        .filter((config) => config.provider !== ModelProvider.COPILOT)
        // The Models tab groups rows by `MODEL_SOURCE_ORDER`, so a config whose
        // resolved source is outside that order can never render as a row.
        // Admitting it anyway would leak it into the serialized `models` payload
        // and — once enabled — into the helper-model dropdown, which does not
        // group. Registry-derived, so a new provider needs no edit here.
        .filter((config) =>
          MODEL_SELECTION_SOURCES.has(resolveModelSource(config)),
        )
        .map((config) => config.name);
      const optionsData = yield* this.deps.resolveModelOptions(
        { ...this.deps.stores, secrets: this.deps.secrets },
        candidates,
      );

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
          provider: resolveModelSource(config),
          routeLabel: option.routeLabel,
          enabled: enabledSet.has(name),
          deprecated: config.deprecated ?? false,
          contextWindow: option.context,
          cost: option.cost,
          isFast: isFastFirstResponseModel(config.inputPrice),
          isExpensive: isExpensiveModel(config.outputPrice),
          availability: option.availability,
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
    });
  }

  private addReasoningLevelData(
    item: ModelSelectionItem,
    config: ModelConfig,
    override: ReasoningEffort | undefined,
  ): void {
    if (!supportsReasoningLevel(config)) return;

    item.supportsReasoningLevel = true;
    const supportedLevels = config.capabilities.supportedReasoningEfforts;
    if (supportedLevels?.length) {
      item.supportedReasoningLevels = [...supportedLevels];
    }

    item.defaultReasoningLevel = config.capabilities.reasoningEffort;

    if (
      override !== undefined &&
      (!supportedLevels?.length || supportedLevels.includes(override))
    ) {
      item.reasoningLevel = override;
    }
  }
}
