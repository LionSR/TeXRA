// Third-party imports
import { Effect, Result } from 'effect';
import { MODEL_CONFIGS, type ModelConfig, type ReasoningEffort } from 'llm-zoo';

// Local imports
import { resolveModelSource } from '@texra-ai/llm';
import {
  getEnabledModels,
  getHelperModelName,
  setModelEnabled,
  StateReadFailed,
  StateWriteFailed,
  type ModelOption,
  type ModelOptionStores,
  type PlatformSecrets,
  Settings,
} from '@texra-ai/harness';
import { GlobalStateKey } from '@texra-ai/harness/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import {
  MODEL_SOURCE_ORDER,
  type ModelSelectionItem,
  type UpdateModelSelectionMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import {
  isExpensiveModel,
  isFastFirstResponseModel,
} from '@texra/shared/model/modelPicker';
import { modelOptionsFrom } from '@texra/model/modelOptions';
import type { SettingsStores } from '@texra-ai/harness';

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
   * The shared model options (`readModelOptions`) for the given models — the
   * same source the CLI picker uses. Each option carries its decided route's
   * config, which the reasoning controls read.
   */
  resolveModelOptions: (
    stores: ModelOptionStores,
    models: readonly string[],
  ) => Effect.Effect<readonly ModelOption[], Error, R>;
}

interface SettingsModelSelectionData {
  models: ModelSelectionItem[];
  helperModel: string;
  preferShortModelNames: boolean;
}

/** Membership form of the order the Models tab groups by. */
const MODEL_SELECTION_SOURCES = new Set<string>(MODEL_SOURCE_ORDER);

export class SettingsModelSelectionController<R = never> {
  constructor(private readonly deps: SettingsModelSelectionControllerDeps<R>) {}

  buildSelectionData(): Effect.Effect<SettingsModelSelectionData, Error, R> {
    return Effect.gen({ self: this }, function* () {
      const models = yield* this.buildSelectionItems();
      return {
        models,
        helperModel: yield* getHelperModelName(this.deps.stores),
        preferShortModelNames: yield* Settings.get<boolean>(
          this.deps.stores,
          GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
        ),
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
  }): Effect.Effect<void, StateWriteFailed> {
    // One read-modify-write at the store's authority: hosts in separate
    // processes share the record, so a get-then-update would drop a
    // concurrent write. The stored record is carried as written, so every
    // entry goes back to storage; reads that need the effort go through
    // `reasoningEffortOverrides`.
    return this.deps.stores.globalState
      .modify(GlobalStateKey.REASONING_LEVELS, (stored) => {
        const overrides = {
          ...(stored as Record<string, string> | undefined),
        };
        if (input.level == null) {
          delete overrides[input.modelName];
        } else {
          overrides[input.modelName] = input.level;
        }
        return Result.succeed(overrides);
      })
      .pipe(Effect.asVoid);
  }

  private buildSelectionItems(): Effect.Effect<ModelSelectionItem[], Error, R> {
    return Effect.gen({ self: this }, function* () {
      const enabledSet = new Set(
        yield* getEnabledModels(this.deps.stores.globalState),
      );

      // Resolve availability (personal-key, subscription) once for the
      // models this host shows, via the same shared computation the CLI picker
      // uses. Passing an explicit list keeps the picker's view authoritative and
      // avoids re-deriving availability at render time.
      const configs = new Map<string, ModelConfig>(
        Object.entries(MODEL_CONFIGS),
      );
      const candidates = [...configs.values()]
        // The Models tab groups rows by `MODEL_SOURCE_ORDER`, so a config whose
        // resolved source is outside that order can never render as a row.
        // Admitting it anyway would leak it into the serialized `models` payload
        // and — once enabled — into the helper-model dropdown, which does not
        // group. A provider a new llm-zoo release adds fails to compile until
        // `MODEL_SOURCE_ORDER` places it.
        .filter((config) =>
          MODEL_SELECTION_SOURCES.has(resolveModelSource(config)),
        )
        .map((config) => config.ref);
      const options = yield* this.deps.resolveModelOptions(
        { ...this.deps.stores, secrets: this.deps.secrets },
        candidates,
      );
      const rows = modelOptionsFrom(options);

      const items: ModelSelectionItem[] = [];
      for (const [index, decided] of options.entries()) {
        const option = rows[index];
        const name = decided.model;
        const config = configs.get(name);
        if (!config || !option || !('config' in decided)) continue;

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

        items.push({ ...item, ...reasoningLevelData(decided) });
      }

      return items.sort((a, b) => a.name.localeCompare(b.name));
    });
  }
}

/**
 * A Models-tab row's reasoning controls, from what a run on the row's route
 * sends (`ModelOption.reasoning`, the bind's own decision): the levels the
 * route can carry, the level a run sends with none saved, and, with a level
 * saved, the level a run sends for it: the saved one, or the one the policy
 * substitutes where the route cannot carry it. The row offers no choice
 * where the route carries one level or none.
 */
function reasoningLevelData(
  decided: Extract<ModelOption, { config: ModelConfig }>,
): Pick<
  ModelSelectionItem,
  | 'supportsReasoningLevel'
  | 'supportedReasoningLevels'
  | 'defaultReasoningLevel'
  | 'reasoningLevel'
> {
  const { reasoning, savedEffort } = decided;
  if (reasoning === undefined || reasoning.efforts.length <= 1) return {};
  const sent = 'refused' in reasoning.sent ? undefined : reasoning.sent.effort;
  return {
    supportsReasoningLevel: true,
    supportedReasoningLevels: [...reasoning.efforts],
    ...(!('refused' in reasoning.fallback) && {
      defaultReasoningLevel: reasoning.fallback.effort,
    }),
    ...(savedEffort !== undefined &&
      sent !== undefined &&
      reasoning.efforts.includes(sent) && { reasoningLevel: sent }),
  };
}
