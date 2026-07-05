import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  DEFAULT_MODELS,
  isDeprecatedModel,
  isRetiredModel,
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

  // Generic deprecated-model sweep for users upgrading past version 16: remove
  // models the registry now marks as deprecated so normal dropdowns stay
  // current. Introduced at version 15 (sonnet/opus tiers) and re-bumped to 16
  // when opus47/opus47T were deprecated in favor of opus48/opus48T. Version
  // 18 leads DEFAULT_MODELS with gemini35f and version 19 adds fable5; both
  // only add or reorder models (no removals), so the deprecated-model sweep
  // intentionally remains guarded at version 16. These thresholds are frozen
  // historical facts about specific past migrations, not tied to the current
  // value of MODEL_LIST_VERSION: since #7191, that value is a hash of the
  // resolved default set rather than a hand-bumped integer, so it no longer
  // makes sense to "bump the guard to the current version" -- a future
  // one-time sweep would add its own new numeric threshold here instead.
  if ((previousVersion ?? 0) < 16) {
    for (const model of currentModels) {
      if (isDeprecatedModel(model)) strippedSet.add(model);
    }
  }

  // Retired models are hard unavailable even for users with included relay
  // access. This sweep runs on every reconciliation, unconditionally --
  // deliberately *not* gated behind a version threshold like the two sweeps
  // above. `reconcileEnabledModels` only ever runs when MODEL_LIST_VERSION
  // has changed (see `refreshModelListStateIfNeeded`), and since #7191 that
  // version is a hash of the resolved default set: it changes again every
  // time a future pick quietly retires, at which point the user's persisted
  // version is already a hash-derived value from a prior run, permanently
  // past any legacy "< N" gate. Freezing this sweep behind such a gate (it
  // used to read `previousVersion < 21`, the last hand-bumped version before
  // #7191) would mean it fires exactly once during the pre-#7191 migration
  // and then never again -- silently leaving future retired defaults stuck in
  // an existing user's enabled-models list. Running it unconditionally keeps
  // it correct across both versioning schemes, at negligible cost (the set of
  // currently-enabled models is small).
  for (const model of currentModels) {
    if (isRetiredModel(model)) strippedSet.add(model);
  }

  const kept = currentModels.filter((model) => !strippedSet.has(model));
  // DEFAULT_MODELS is already resolved against the live registry --
  // resolveDefaultModels (modelOptionsBasic.ts) drops retired/deprecated
  // picks before this module ever sees them -- so the only remaining check
  // here is "not already present".
  const added = DEFAULT_MODELS.filter((model) => !kept.includes(model));

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
