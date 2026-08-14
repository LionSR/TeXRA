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
 * Existing user choices are preserved unless a removal rule applies. Defaults
 * are added only when the preferred-model version changes.
 */
function reconcileEnabledModels(
  currentModels: readonly string[],
  previousVersion: number | undefined,
  addDefaults: boolean,
): EnabledModelReconciliation {
  const strippedSet = new Set<string>();

  // Generic deprecated-model sweep for users upgrading past version 16: remove
  // models the registry now marks as deprecated so normal dropdowns stay
  // current. Introduced at version 15 (sonnet/opus tiers) and re-bumped to 16
  // when opus47/opus47T were deprecated in favor of opus48/opus48T. Version
  // 18 leads DEFAULT_MODELS with gemini35f and version 19 adds fable5; both
  // only add or reorder models (no removals), so the deprecated-model sweep
  // intentionally remains guarded at version 16. These thresholds are frozen
  // historical facts about specific past migrations, not tied to the current
  // value of MODEL_LIST_VERSION: it is now a hash of preferred membership and
  // status rather than a hand-bumped integer, so it no longer makes sense to
  // "bump the guard to the current version" -- a future
  // one-time sweep would add its own new numeric threshold here instead.
  if ((previousVersion ?? 0) < 16) {
    for (const model of currentModels) {
      if (isDeprecatedModel(model)) strippedSet.add(model);
    }
  }

  // Retired models are hard unavailable even for users with included relay
  // access. This sweep runs on every reconciliation, unconditionally --
  // deliberately *not* gated behind a version threshold like the two sweeps
  // above. `reconcileEnabledModels` runs on every startup so a catalogue
  // retirement is applied even when preferred-model membership is unchanged.
  // The user's persisted version may already be permanently past any legacy
  // "< N" gate. Freezing this sweep behind such a gate (it
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
  const added = addDefaults
    ? DEFAULT_MODELS.filter((model) => !kept.includes(model))
    : [];

  return {
    models: [...kept, ...added],
    added,
    removed: [...strippedSet],
  };
}

/** Sweep retired entries and reconcile defaults when MODEL_LIST_VERSION changes. */
export async function refreshModelListStateIfNeeded(
  state: ModelListState,
): Promise<ModelListRefreshResult> {
  const previousVersion = state.get<number>(GlobalStateKey.MODEL_LIST_VERSION);
  const versionChanged = previousVersion !== MODEL_LIST_VERSION;
  const currentModels = state.get<string[]>(GlobalStateKey.ENABLED_MODELS);
  let added: string[] = [];
  let removed: string[] = [];
  if (currentModels) {
    const reconciliation = reconcileEnabledModels(
      currentModels,
      previousVersion,
      versionChanged,
    );
    added = reconciliation.added;
    removed = reconciliation.removed;
    if (added.length > 0 || removed.length > 0) {
      await state.update(GlobalStateKey.ENABLED_MODELS, reconciliation.models);
    }
  }

  if (versionChanged) {
    await state.update(GlobalStateKey.MODEL_LIST_VERSION, MODEL_LIST_VERSION);
  }
  return {
    skipped: !versionChanged && removed.length === 0,
    previousVersion,
    currentVersion: MODEL_LIST_VERSION,
    added,
    removed,
  };
}
