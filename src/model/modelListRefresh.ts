import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  DEFAULT_MODELS,
  isDeprecatedModel,
  isRetiredModel,
  MODEL_LIST_VERSION,
} from './modelOptionsBasic';
import {
  COPILOT_MODEL_PREFIX,
  normalizePersistedCopilotModelId,
} from './runtimeModelRegistry';

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
  const keptSet = new Set(kept);
  const added = addDefaults
    ? DEFAULT_MODELS.filter((model) => !keptSet.has(model))
    : [];
  // Preferred defaults keep their curated order in the picker. User-enabled
  // extras stay after that block so a stale Gemini-first list cannot keep
  // leading once Sonnet is the default.
  const defaultOrdered = DEFAULT_MODELS.filter(
    (model) => keptSet.has(model) || added.includes(model),
  );
  const extras = kept.filter((model) => !DEFAULT_MODELS.includes(model));

  return {
    models: [...defaultOrdered, ...extras],
    added,
    removed: [...strippedSet],
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

/** Sweep retired entries and reconcile defaults when MODEL_LIST_VERSION changes. */
export async function refreshModelListStateIfNeeded(
  state: ModelListState,
): Promise<ModelListRefreshResult> {
  const previousVersion = state.get<number>(GlobalStateKey.MODEL_LIST_VERSION);
  const versionChanged = previousVersion !== MODEL_LIST_VERSION;
  const currentModels = state.get<string[]>(GlobalStateKey.ENABLED_MODELS);
  let added: string[] = [];
  let removed: string[] = [];
  let reordered = false;
  if (currentModels) {
    const reconciliation = reconcileEnabledModels(
      currentModels,
      previousVersion,
      versionChanged,
    );
    added = reconciliation.added;
    removed = reconciliation.removed;
    reordered = !sameModelList(currentModels, reconciliation.models);
    if (added.length > 0 || removed.length > 0 || reordered) {
      await state.update(GlobalStateKey.ENABLED_MODELS, reconciliation.models);
    }
  }

  if (versionChanged) {
    await state.update(GlobalStateKey.MODEL_LIST_VERSION, MODEL_LIST_VERSION);
  }
  return {
    skipped:
      !versionChanged &&
      added.length === 0 &&
      removed.length === 0 &&
      !reordered,
    previousVersion,
    currentVersion: MODEL_LIST_VERSION,
    added,
    removed,
  };
}

/**
 * One-time migration for #9635: rewrite persisted `copilot:<baseModel>`
 * selections to the canonical base model id and record the Copilot route
 * preference so the migrated model keeps routing through Copilot. Covers the
 * enabled-models list, the helper model, and reasoning-level override keys.
 *
 * Temporary: introduced 2026-08-03; retire three months after the
 * route-based model identity ships (target 2026-11-03) together with
 * `normalizePersistedCopilotModelId`. Only the extension host calls this —
 * the desktop app is unreleased and adopts the current format directly, and
 * CLI state uses only current schemas.
 */
export async function migrateCopilotModelRouteSelections(
  state: ModelListState,
): Promise<void> {
  if (state.get<number>(GlobalStateKey.COPILOT_ROUTE_MIGRATION) === 1) return;

  const enabled = state.get<readonly string[]>(GlobalStateKey.ENABLED_MODELS);
  const helperModel = state.get<string>(GlobalStateKey.HELPER_MODEL);
  const reasoningLevels = state.get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
  );

  // Compute and persist the route preference FIRST: if activation stops
  // mid-migration, the retry still sees the `copilot:*` ids and re-derives
  // the same preference, so an interrupted run cannot lose it.
  const routeModels = new Set(
    state.get<readonly string[]>(GlobalStateKey.COPILOT_ROUTE_MODELS) ?? [],
  );
  for (const model of [
    ...(enabled ?? []),
    ...(helperModel ? [helperModel] : []),
    ...Object.keys(reasoningLevels ?? {}),
  ]) {
    if (model.startsWith(COPILOT_MODEL_PREFIX)) {
      routeModels.add(normalizePersistedCopilotModelId(model));
    }
  }
  await state.update(GlobalStateKey.COPILOT_ROUTE_MODELS, [...routeModels]);

  if (enabled?.some((model) => model.startsWith(COPILOT_MODEL_PREFIX))) {
    const migrated: string[] = [];
    for (const model of enabled) {
      const canonical = normalizePersistedCopilotModelId(model);
      if (!migrated.includes(canonical)) migrated.push(canonical);
    }
    await state.update(GlobalStateKey.ENABLED_MODELS, migrated);
  }

  if (helperModel?.startsWith(COPILOT_MODEL_PREFIX)) {
    await state.update(
      GlobalStateKey.HELPER_MODEL,
      normalizePersistedCopilotModelId(helperModel),
    );
  }

  if (
    reasoningLevels &&
    Object.keys(reasoningLevels).some((model) =>
      model.startsWith(COPILOT_MODEL_PREFIX),
    )
  ) {
    const migrated: Record<string, string> = {};
    for (const [model, level] of Object.entries(reasoningLevels)) {
      const canonical = normalizePersistedCopilotModelId(model);
      // A pre-existing canonical override wins over the migrated copilot
      // one, regardless of key iteration order.
      if (!model.startsWith(COPILOT_MODEL_PREFIX) || !(canonical in migrated)) {
        migrated[canonical] = level;
      }
    }
    await state.update(GlobalStateKey.REASONING_LEVELS, migrated);
  }

  await state.update(GlobalStateKey.COPILOT_ROUTE_MIGRATION, 1);
}
