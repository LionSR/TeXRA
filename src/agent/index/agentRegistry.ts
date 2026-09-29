/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import { Clock, Data, Effect } from 'effect';
import { AgentRosterController } from '@agent/roster/AgentRosterController';
import { withLogChannel } from '@logger/effectLog';
import { AgentDirectories, type StateReadFailed } from '@platform/interfaces';
import type { AgentCatalogServices } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type {
  AgentCategory as AgentCategoryType,
  AgentDelegationScope,
  AgentOptionData,
  AgentSource,
} from '@shared/schemas';
import type { AgentScanIssue } from '@shared/settingsView/settingsViewMessages';
import {
  AgentCategory,
  DEFAULT_WORKFLOW_AGENT,
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
} from '@shared/schemas';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName } from '@utils/core';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { scanDirectory } from './agentYamlScanner';
import { enabledToolUseRoots } from './BundledAgentDirectories';
import { scanPluginAgents } from './pluginAgents';
import type { AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';

/** Resolving an agent directory failed (I/O or a rejected configured path). */
export class AgentCatalogLoadError extends Data.TaggedError(
  'AgentCatalogLoadError',
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Source priority for lookups, highest first. Every source is listed: an
 * absent one scores `-1` in `deduplicateByName`'s `indexOf`, ranking first by
 * accident.
 */
const LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'builtInWorkflow',
  'builtInToolUse',
  'plugin',
];

/** The cache. Just a Map. */
const cache = new Map<string, AgentEntry>();

/** Custom-directory YAML the last published load could not turn into an agent. */
let customScanIssues: readonly AgentScanIssue[] = Object.freeze([]);

/**
 * Loads are serialized on one per-key lane: every load enters it, so the
 * registry has one serialization point instead of a promise plus a queue.
 * A fiber that arrives while a load runs waits for it — nothing on the load
 * path may take the lane from inside a load of its own.
 */
const catalogLoadLanes = new Map<string, PerKeyLane>();
const onCatalogLoadLane = withPerKeyLane(catalogLoadLanes, 'agentCatalogLoad');

// =============================================================================
// CORE API
// =============================================================================

/**
 * Scan every agent source and publish the result. The caller holds the lane,
 * and a failed scan fails only its own caller — the lane hands the next
 * entrant off regardless, and the previous catalog keeps serving.
 */
const scanCatalog: Effect.Effect<
  void,
  AgentCatalogLoadError | StateReadFailed,
  AgentCatalogServices
> = Effect.gen(function* () {
  const startTime = yield* Clock.currentTimeMillis;

  const dirs = yield* AgentDirectories;
  const [customDir, builtInDir, toolUseDir] = yield* Effect.all(
    [dirs.custom(), dirs.builtIn(), dirs.builtInToolUse()],
    { concurrency: 'unbounded' },
  ).pipe(
    // The port names its own failure; the catalog load is what the caller
    // asked for, so it carries the reason and the original cause up.
    Effect.mapError(
      (failure) =>
        new AgentCatalogLoadError({
          message: failure.message,
          cause: failure.cause,
        }),
    ),
  );
  const toolUseRoots = yield* enabledToolUseRoots(toolUseDir);
  // Only custom-agent scan issues are a product surface; the rest go unused.
  const [customScan, builtInScan, toolUseScan, pluginAgents] =
    yield* Effect.all(
      [
        scanDirectory([customDir], 'custom'),
        scanDirectory([builtInDir], 'builtInWorkflow'),
        scanDirectory(toolUseRoots, 'builtInToolUse'),
        scanPluginAgents,
      ],
      { concurrency: 'unbounded' },
    );

  cache.clear();
  customScanIssues = Object.freeze(customScan.issues);
  for (const entry of [
    ...customScan.entries,
    ...builtInScan.entries,
    ...toolUseScan.entries,
    ...pluginAgents,
  ]) {
    cache.set(agentKeyOf(entry), entry);
  }

  yield* Effect.logInfo(
    `Loaded ${cache.size} agents in ${(yield* Clock.currentTimeMillis) - startTime}ms`,
  ).pipe(withLogChannel(CHANNEL));
});

/**
 * Category-blind catalog lookup by identifier: a "source:name" key hits its
 * entry directly, and a plain name takes the first source in
 * `LOOKUP_PRIORITY`. Callers that require a category resolve through
 * `getCategoryAgent` or `resolveAgentForLaunch` instead.
 */
export function getAgent(identifier: string): AgentEntry | undefined {
  // Direct lookup for source:name format (already resolved)
  const direct = cache.get(identifier);
  if (direct) return direct;

  for (const source of LOOKUP_PRIORITY) {
    const entry = cache.get(agentKey(source, identifier));
    if (entry) return entry;
  }
  return undefined;
}

/** Get agents for a category, deduplicated by name. */
export function getAgentsByCategory(category: AgentCategory): AgentEntry[] {
  return deduplicateByName(
    [...cache.values()].filter((e) => e.category === category),
  );
}

/**
 * Custom-directory YAML files the last published load skipped, with the
 * reason. Empty until a load publishes a catalog.
 */
export function getCustomAgentScanIssues(): readonly AgentScanIssue[] {
  return customScanIssues;
}

/**
 * The one loader: rescan every source, after every older load has settled,
 * and publish the catalog rebuilt from empty. The process's catalog layer
 * (`agentCatalogFollower`) calls it when the runtime is built and on every
 * change; nothing else needs the catalog loaded first. The cache keeps
 * serving the catalog it already published until the new one lands,
 * including when the rescan fails.
 */
export function refresh(): Effect.Effect<
  void,
  AgentCatalogLoadError | StateReadFailed,
  AgentCatalogServices
> {
  return onCatalogLoadLane(scanCatalog);
}

// =============================================================================
// VISIBLE AGENTS (for dropdowns)
// =============================================================================

/**
 * The two state slots the durable roster resolves against: the repository's
 * selection and the cross-workspace defaults. Every roster read is answered for
 * the workspace whose slots the caller hands over, so a process holding several
 * sessions never answers one paper's question with another's roster.
 */
export type AgentRosterStores = Pick<
  WorkspaceRoots,
  'repoState' | 'globalState'
>;

/**
 * Construct the roster controller over the given workspace's stores. This is
 * the one place the durable roster's dependencies are wired, so every host
 * reads and writes the same selection through identical resolution rules. The
 * caller passes the roots it holds (a tool call's `call.roots`, a host's
 * session roots) rather than this reading the calling context's scope.
 */
export function createWorkspaceAgentRosterController(
  roots: AgentRosterStores,
  getAgents: (category: AgentCategory) => AgentEntry[] = getAgentsByCategory,
): AgentRosterController<AgentEntry> {
  const { repoState, globalState } = roots;
  return new AgentRosterController({
    repoState,
    globalState,
    getAgents,
    getPresets: () =>
      repoState.get<unknown>(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    resolveAgent: getCategoryAgent,
  });
}

/**
 * Get visible agents for a category (filtered by user visibility config).
 * Agents are already deduplicated by name from the getter functions.
 * No default → undefined means "never configured" (show all).
 */
export function getVisibleAgents(
  stores: AgentRosterStores,
  category: AgentCategory,
) {
  return createWorkspaceAgentRosterController(stores).getVisibleAgents(
    category,
  );
}

/**
 * Resolve delegation targets for a run: the scope's pinned keys when a
 * delegation scope is active, or the workspace-visible roster otherwise. The
 * single resolver behind both the "Available agents:" tool-description block
 * (`delegationAvailability.ts`) and the delegation tools' agent lookup
 * (`proposalFlow.ts`), so a delegating agent's tool description can never
 * list a different roster from the one its calls are resolved against.
 */
export function resolveDelegationScopeAgents(
  stores: AgentRosterStores,
  scope: AgentDelegationScope | undefined,
  category: AgentCategoryType,
) {
  return Effect.gen(function* () {
    if (!scope) return yield* getVisibleAgents(stores, category);
    const keys = scope[category];

    // Deduplicated by canonical key: two identifiers that resolve to the same
    // entry contribute it once.
    const byKey = new Map<string, AgentEntry>();
    for (const key of keys) {
      const entry = getCategoryAgent(category, key);
      if (entry) byKey.set(agentKeyOf(entry), entry);
    }
    return [...byKey.values()];
  });
}

/**
 * Match an identifier against a candidate set. A source-qualified identifier
 * names one specific entry, so only an exact key match counts. Bare identifiers
 * may match any candidate by name.
 *
 * This is the single identity-matching rule. Every resolver that picks an entry
 * out of a list by name-or-key goes through it, so the rule lives in exactly
 * one place.
 */
export function findAgentByIdentifier(
  entries: readonly AgentEntry[],
  identifier: string,
): AgentEntry | undefined {
  return entries.find((entry) => agentMatchesIdentifier(entry, identifier));
}

/** Resolve an identifier to a currently visible agent entry. */
export function getVisibleAgent(
  stores: AgentRosterStores,
  category: AgentCategory,
  identifier: string,
) {
  return Effect.gen(function* () {
    return findAgentByIdentifier(
      yield* getVisibleAgents(stores, category),
      identifier,
    );
  });
}

/**
 * Resolve an identifier to an agent in a category, ignoring visibility: the
 * one member identity rule the roster, team plans and launch share. A bare
 * name matches the category's deduplicated entries; a `source:name` key
 * matches its exact entry, even one a higher-priority source shadows. An
 * entry outside `category` is no match.
 */
export function getCategoryAgent(
  category: AgentCategoryType,
  identifier: string,
): AgentEntry | undefined {
  const entry =
    identifier === agentName(identifier)
      ? findAgentByIdentifier(getAgentsByCategory(category), identifier)
      : cache.get(identifier);
  return entry?.category === category ? entry : undefined;
}

/** Resolve a launch by pinned source, visible roster, then full category.
 * Each tier runs only when the preceding one has no match, preserving the
 * exact agent chosen during validation even when visibility changes. Only an
 * explicit `source` (a run record's decided identity) pins, and that tier is
 * category-blind, so a caller that requires a category checks the returned
 * entry. A `source:name` identifier resolves through the category-scoped
 * tiers, which match its exact entry even when a higher-priority source
 * shadows the name, and never answer with an entry of the other category.
 */
export function resolveAgentForLaunch(
  stores: AgentRosterStores,
  category: AgentCategory,
  identifier: string,
  source?: AgentSource | null,
) {
  return Effect.gen(function* () {
    return (
      (source
        ? cache.get(agentKey(source, agentName(identifier)))
        : undefined) ??
      (yield* getVisibleAgent(stores, category, identifier)) ??
      getCategoryAgent(category, identifier)
    );
  });
}

/**
 * Deduplicate agents by name, keeping only the highest-priority source
 * (custom > builtInWorkflow > builtInToolUse > plugin) for the dropdown.
 */
function deduplicateByName(entries: AgentEntry[]): AgentEntry[] {
  const byKey = new Map<string, AgentEntry>();

  for (const entry of entries) {
    const existing = byKey.get(entry.name);

    // Keep entry if none exists or if this one has higher priority
    const isHigherPriority =
      !existing ||
      LOOKUP_PRIORITY.indexOf(entry.source) <
        LOOKUP_PRIORITY.indexOf(existing.source);

    if (isHigherPriority) {
      byKey.set(entry.name, entry);
    }
  }

  return [...byKey.values()];
}

// =============================================================================
// TYPED OPTIONS BUILDER (Lit-native)
// =============================================================================

interface AgentOptionsDataPayload {
  workflow: AgentOptionData[];
  toolUse: AgentOptionData[];
}

function entriesToOptionData(
  entries: readonly AgentEntry[],
): AgentOptionData[] {
  return entries.map((entry) => ({
    value: agentKeyOf(entry),
    label: entry.name,
    isToolUse: entry.category === AgentCategory.ToolUse,
    isOrchestrator: hasDelegationTool(entry.tools),
    source: entry.source,
  }));
}

/** Sort entries: preferred agents first (in priority order), then alphabetically. */
function sortAgentEntries(
  entries: AgentEntry[],
  preferredNames: readonly string[],
): AgentEntry[] {
  const preferredSet = new Map(
    preferredNames
      .map((name, i) => [entries.find((e) => e.name === name), i] as const)
      .filter(([entry]) => entry != null),
  );
  return entries.toSorted((a, b) => {
    const aIdx = preferredSet.get(a);
    const bIdx = preferredSet.get(b);
    if (aIdx != null && bIdx != null) return aIdx - bIdx;
    if (aIdx != null) return -1;
    if (bIdx != null) return 1;
    return byName(a, b);
  });
}

/** Compute typed agent options data for Lit-native rendering. */
export function computeAgentOptionsData(
  stores: AgentRosterStores,
): Effect.Effect<AgentOptionsDataPayload, StateReadFailed> {
  return Effect.gen(function* () {
    return {
      workflow: entriesToOptionData(
        sortAgentEntries(yield* getVisibleAgents(stores, 'workflow'), [
          DEFAULT_WORKFLOW_AGENT,
        ]),
      ),
      toolUse: entriesToOptionData(
        sortAgentEntries(
          yield* getVisibleAgents(stores, 'toolUse'),
          PREFERRED_TOOL_USE_AGENTS,
        ),
      ),
    };
  });
}
