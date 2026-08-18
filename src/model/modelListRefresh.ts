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

interface CopilotRouteReconciliation {
  models: string[];
  cleared: string[];
}

export interface ModelListRefreshResult {
  skipped: boolean;
  previousVersion: number | undefined;
  currentVersion: number;
  added: string[];
  removed: string[];
  /** True when the persisted enabled list was rewritten only to change order. */
  reordered: boolean;
  /** Copilot route preferences cleared because their base model is retired or deprecated. */
  routePreferencesCleared: string[];
}

/**
 * Reconciles a persisted enabled-models list with the current defaults.
 * Existing user choices are preserved unless a removal rule applies. Defaults
 * are added only when the preferred-model version changes.
 */
function reconcileEnabledModels(
  currentModels: readonly string[],
  addDefaults: boolean,
): EnabledModelReconciliation {
  const strippedSet = new Set<string>();

  // Retired models are hard unavailable even for users with included relay
  // access. This sweep runs on every reconciliation, unconditionally --
  // deliberately *not* gated behind a version threshold.
  // `reconcileEnabledModels` runs on every startup so a catalogue
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
  const keptSet = new Set(kept);
  const added = addDefaults
    ? DEFAULT_MODELS.filter((model) => !keptSet.has(model))
    : [];
  // Preferred defaults keep their curated order in the picker: when defaults
  // are added, every preferred pick is either kept or added, so the whole
  // block lands in DEFAULT order. User-enabled extras stay after that block
  // so a stale Gemini-first list cannot keep leading once Sonnet is the
  // default.
  const defaultOrdered = DEFAULT_MODELS.filter(
    (model) => addDefaults || keptSet.has(model),
  );
  const extras = kept.filter((model) => !DEFAULT_MODELS.includes(model));

  return {
    models: [...defaultOrdered, ...extras],
    added,
    removed: [...strippedSet],
  };
}

/**
 * Clear persisted Copilot route preferences whose base model is retired or
 * deprecated — stale in the sense that Copilot discovery (`matchingBaseModel`
 * in runtimeModelRegistry.ts) deliberately excludes both kinds of config, so
 * the preference can never resolve to a route. Leaving it persisted would
 * strand the model behind the hard no-fallthrough error (#9635) on every
 * launch. Unlike the version-gated enabled-list deprecated sweep above, this
 * runs unconditionally: affected users may already have persisted the current
 * MODEL_LIST_VERSION before this migration shipped.
 */
function reconcileCopilotRoutePreferences(
  currentModels: readonly string[],
): CopilotRouteReconciliation {
  const isStale = (model: string) =>
    isRetiredModel(model) || isDeprecatedModel(model);
  return {
    models: currentModels.filter((model) => !isStale(model)),
    cleared: currentModels.filter(isStale),
  };
}

function sameModelList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length && left.every((model, i) => model === right[i])
  );
}

/**
 * Reconcile persisted model-list state. The enabled list keeps its retired
 * sweep and version-gated default reconciliation; Copilot route preferences
 * are swept unconditionally so stale retired/deprecated routes are cleared
 * even when MODEL_LIST_VERSION is already current.
 */
export async function refreshModelListStateIfNeeded(
  state: ModelListState,
): Promise<ModelListRefreshResult> {
  const previousVersion = state.get<number>(GlobalStateKey.MODEL_LIST_VERSION);
  const versionChanged = previousVersion !== MODEL_LIST_VERSION;
  const currentModels = state.get<string[]>(GlobalStateKey.ENABLED_MODELS);
  const currentRoutePreferences = state.get<string[]>(
    GlobalStateKey.COPILOT_ROUTE_MODELS,
  );
  let added: string[] = [];
  let removed: string[] = [];
  let reordered = false;
  let routePreferencesCleared: string[] = [];
  if (currentModels) {
    const reconciliation = reconcileEnabledModels(
      currentModels,
      versionChanged,
    );
    added = reconciliation.added;
    removed = reconciliation.removed;
    reordered =
      added.length === 0 &&
      removed.length === 0 &&
      !sameModelList(currentModels, reconciliation.models);
    if (added.length > 0 || removed.length > 0 || reordered) {
      await state.update(GlobalStateKey.ENABLED_MODELS, reconciliation.models);
    }
  }

  if (versionChanged) {
    await state.update(GlobalStateKey.MODEL_LIST_VERSION, MODEL_LIST_VERSION);
  }
  // Sweep route preferences last so a rejected write here cannot prevent the
  // pre-existing enabled-list/version reconciliation above. A transient write
  // failure retries on the next startup, where the earlier writes are already
  // idempotent.
  if (currentRoutePreferences) {
    const reconciliation = reconcileCopilotRoutePreferences(
      currentRoutePreferences,
    );
    routePreferencesCleared = reconciliation.cleared;
    if (routePreferencesCleared.length > 0) {
      await state.update(
        GlobalStateKey.COPILOT_ROUTE_MODELS,
        reconciliation.models,
      );
    }
  }
  return {
    skipped:
      !versionChanged &&
      added.length === 0 &&
      removed.length === 0 &&
      !reordered &&
      routePreferencesCleared.length === 0,
    previousVersion,
    currentVersion: MODEL_LIST_VERSION,
    added,
    removed,
    reordered,
    routePreferencesCleared,
  };
}
