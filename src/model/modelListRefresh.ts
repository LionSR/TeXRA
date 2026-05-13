import { GlobalStateKey } from '@common/state/stateKeys';

import {
  DEFAULT_MODELS,
  isDeprecatedModel,
  MODEL_LIST_VERSION,
} from './modelOptionsBasic';

interface ModelListState {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface EnabledModelReconciliation {
  models: string[];
  added: string[];
  removed: string[];
}

export interface ModelListRefreshResult {
  skipped: boolean;
  previousVersion: number | undefined;
  currentVersion: number;
  added: string[];
  removed: string[];
}

/**
 * Reconciles a persisted enabled-models list with the current defaults.
 * Existing user choices are preserved unless a versioned removal rule applies.
 */
function reconcileEnabledModels(
  currentModels: readonly string[],
  previousVersion: number | undefined,
): EnabledModelReconciliation {
  const strippedSet = new Set<string>();

  // One-time strip for users upgrading past version 13:
  // - gpt54pro: default for 0.36.5-0.36.x, then removed as duplicative with gpt54.
  // - opus46T: default before opus47T landed and superseded it.
  if ((previousVersion ?? 0) < 13) {
    for (const model of ['gpt54pro', 'opus46T']) {
      if (currentModels.includes(model)) strippedSet.add(model);
    }
  }

  // One-time strip for users upgrading past version 15: remove models that
  // the registry now marks as deprecated so normal dropdowns stay current.
  if ((previousVersion ?? 0) < 15) {
    for (const model of currentModels) {
      if (isDeprecatedModel(model)) strippedSet.add(model);
    }
  }

  const kept = currentModels.filter((model) => !strippedSet.has(model));
  const added = DEFAULT_MODELS.filter(
    (model) => !kept.includes(model) && !isDeprecatedModel(model),
  );

  return {
    models: [...kept, ...added],
    added,
    removed: [...strippedSet],
  };
}

/** Refreshes persisted model selection when MODEL_LIST_VERSION changes. */
export async function refreshModelListStateIfNeeded(
  state: ModelListState,
): Promise<ModelListRefreshResult> {
  const previousVersion = state.get<number>(GlobalStateKey.MODEL_LIST_VERSION);
  if (previousVersion === MODEL_LIST_VERSION) {
    return {
      skipped: true,
      previousVersion,
      currentVersion: MODEL_LIST_VERSION,
      added: [],
      removed: [],
    };
  }

  const currentModels = state.get<string[]>(GlobalStateKey.ENABLED_MODELS);
  let added: string[] = [];
  let removed: string[] = [];
  if (currentModels) {
    const reconciliation = reconcileEnabledModels(
      currentModels,
      previousVersion,
    );
    added = reconciliation.added;
    removed = reconciliation.removed;
    if (added.length > 0 || removed.length > 0) {
      await state.update(GlobalStateKey.ENABLED_MODELS, reconciliation.models);
    }
  }

  await state.update(GlobalStateKey.MODEL_LIST_VERSION, MODEL_LIST_VERSION);
  return {
    skipped: false,
    previousVersion,
    currentVersion: MODEL_LIST_VERSION,
    added,
    removed,
  };
}
