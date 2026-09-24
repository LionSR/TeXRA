/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import { Cause, Data, Effect, FileSystem } from 'effect';
import { AgentRosterController } from '@agent/roster/AgentRosterController';
import { withLogChannel } from '@logger/effectLog';
import { AgentDirectories, type StateReadFailed } from '@platform/interfaces';
import type { GlobalStorageFs } from '@platform/rootedFs';
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
import { toErrorMessage } from '@utils/errors/errorMessage';
import { scanDirectory } from './agentYamlScanner';
import { builtInToolUseRoots } from './BundledAgentDirectories';
import { loadRemoteAgents } from './remoteAgentMeta';
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
 * Source priority for lookups (higher priority first). Every source must be
 * listed, not omitted: `deduplicateByName` compares `indexOf`, and an absent
 * source scores `-1`, ranking it first by accident instead of by decision.
 * Bundled outranks remote, so a stale hosted row never shadows a bundled name.
 */
const LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'builtInWorkflow',
  'builtInToolUse',
  'remote',
];

// =============================================================================
// STATE
// =============================================================================

/** The cache. Just a Map. */
const cache = new Map<string, AgentEntry>();

/**
 * What the cache currently holds, or `undefined` before any load published one.
 * Only a load that reaches its publish barrier assigns it, so a failed load
 * leaves the previous catalog described exactly as it still is.
 */
let catalog: { readonly includesRemote: boolean } | undefined;

/** Custom-directory YAML the last published load could not turn into an agent. */
let customScanIssues: readonly AgentScanIssue[] = Object.freeze([]);

/**
 * Loads are serialized on one per-key lane: every load enters it, so the
 * registry has one serialization point instead of a promise plus a queue.
 * A fiber that arrives while a load runs waits for it, then re-checks what
 * that load published — nothing on the load path may take the lane from
 * inside a load of its own.
 */
const catalogLoadLanes = new Map<string, PerKeyLane>();
const onCatalogLoadLane = withPerKeyLane(catalogLoadLanes, 'agentCatalogLoad');

/**
 * Advanced by {@link refresh} only. A load carries the epoch it was requested
 * at and publishes nothing once a refresh has moved past it, so a post-sign-in
 * rebuild can never be overwritten by the signed-out load it raced.
 */
let epoch = 0;

export interface LoadAgentsOptions {
  /** Include remote agent metadata that requires auth/network access. */
  includeRemote?: boolean;
}

/**
 * On {@link refresh}, `includeRemote: true` refetches remote metadata and
 * `false` drops it. Omitted, it rescans only the local directories and keeps
 * the remote entries the catalog already holds: a local edit costs no network.
 */
type RemoteMode = boolean | undefined;

// =============================================================================
// CORE API
// =============================================================================

/**
 * Load all agents into cache. Call once at activation.
 * Concurrent calls join the in-flight load through the lane and re-check what
 * it published, so only one scan runs.
 */
export function loadAgents(
  options: LoadAgentsOptions = {},
): Effect.Effect<
  void,
  AgentCatalogLoadError | StateReadFailed,
  GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> {
  const includeRemote = options.includeRemote ?? true;
  return onCatalogLoadLane(
    Effect.suspend(() =>
      catalog && (!includeRemote || catalog.includesRemote)
        ? Effect.void
        : queueLoad(includeRemote, epoch),
    ),
  );
}

/**
 * Run one load, superseding checks included. The caller holds the lane, so a
 * stale-epoch load skips without publishing and a failed load fails only its
 * own caller — the lane hands the next entrant off regardless.
 */
function queueLoad(
  includeRemote: RemoteMode,
  loadEpoch: number,
): Effect.Effect<
  void,
  AgentCatalogLoadError | StateReadFailed,
  GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> {
  return Effect.gen(function* () {
    if (loadEpoch !== epoch) return;
    const startTime = Date.now();

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

    const [customScan, builtInScan, toolUseScan, remoteEntries] =
      yield* Effect.all(
        [
          scanDirectory([customDir], 'custom'),
          scanDirectory([builtInDir], 'builtInWorkflow'),
          scanDirectory(builtInToolUseRoots(toolUseDir), 'builtInToolUse'),
          includeRemote
            ? loadRemoteAgents()
            : Effect.succeed([] as AgentEntry[]),
        ],
        { concurrency: 'unbounded' },
      );
    // builtInScan.issues and toolUseScan.issues are intentionally unused:
    // only custom-agent scan failures are a product surface.

    // Register all entries.
    const allEntries = [
      ...customScan.entries,
      ...builtInScan.entries,
      ...toolUseScan.entries,
      ...remoteEntries,
    ];

    if (loadEpoch !== epoch) return;

    // Carried-over remote entries are read at publish time, after every older
    // load and any sign-out removal have settled.
    const keptRemote =
      includeRemote === undefined
        ? [...cache.values()].filter((entry) => entry.source === 'remote')
        : [];
    cache.clear();
    customScanIssues = Object.freeze(customScan.issues);
    for (const entry of [...allEntries, ...keptRemote]) {
      cache.set(agentKeyOf(entry), entry);
    }
    catalog = {
      includesRemote: includeRemote ?? catalog?.includesRemote ?? false,
    };

    yield* Effect.logInfo(
      `Loaded ${cache.size} agents in ${Date.now() - startTime}ms`,
    ).pipe(withLogChannel(CHANNEL));
  });
}

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

/** Refresh the live catalog entry from a remote agent's validated YAML. */
export function updateAgentMeta(
  identifier: string,
  meta: {
    description?: string;
    tools?: string[];
    defaultOutputFiles?: string[];
  },
): void {
  const entry = getAgent(identifier);
  if (!entry) return;
  if (meta.description) entry.description = meta.description;
  if ('tools' in meta)
    entry.tools = meta.tools?.length ? meta.tools : undefined;
  if ('defaultOutputFiles' in meta)
    entry.defaultOutputFiles = meta.defaultOutputFiles?.length
      ? meta.defaultOutputFiles
      : undefined;
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
 * Force a new load after every older one has settled, superseding any load
 * still queued from before. The cache keeps serving the catalog it already
 * published until the new one lands, including when the refresh fails. The
 * epoch advances only once the refresh actually starts, so constructing a
 * refresh without running it is inert. An omitted `includeRemote` means a
 * local rescan here, unlike {@link loadAgents} (see {@link RemoteMode}).
 */
export function refresh(
  options: LoadAgentsOptions = {},
): Effect.Effect<
  void,
  AgentCatalogLoadError | StateReadFailed,
  GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> {
  return Effect.suspend(() => {
    // A local rescan is weaker than the loads queued before it, so it takes
    // the current epoch instead of superseding a pending remote refetch.
    const loadEpoch = options.includeRemote === undefined ? epoch : ++epoch;
    return onCatalogLoadLane(queueLoad(options.includeRemote, loadEpoch));
  });
}

function removeRemoteEntries(): void {
  for (const [key, entry] of cache) {
    if (entry.source === 'remote') cache.delete(key);
  }
  // The cache no longer holds remote definitions, so the published description
  // of it must not claim otherwise even if the rebuild below never lands.
  if (catalog) catalog = { includesRemote: false };
}

/** Remove remote definitions immediately, then rebuild the local catalog. */
export function invalidateRemoteAgentsAfterSignOut(): Effect.Effect<
  void,
  never,
  GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> {
  return Effect.suspend(() => {
    removeRemoteEntries();
    return refresh({ includeRemote: false });
  }).pipe(
    Effect.catchCause((cause) => {
      // Best effort, defects included: a stale catalog never blocks sign-out.
      // Re-remove: an older remote load may have settled before the rebuild.
      removeRemoteEntries();
      return Effect.logWarning(
        `Local agent catalog rebuild failed after sign-out: ${toErrorMessage(Cause.squash(cause))}`,
      ).pipe(withLogChannel(CHANNEL));
    }),
  );
}

// =============================================================================
// KEY HELPERS
// =============================================================================

/**
 * Resolve one roster identifier without collapsing an exact source key.
 * Module-local: the roster controller it exists for is built here, so no
 * caller outside this file needs the resolution rule on its own.
 */
function getRosterAgent(
  category: AgentCategoryType,
  identifier: string,
): AgentEntry | undefined {
  const name = agentName(identifier);
  const entry =
    identifier === name
      ? getCategoryAgent(category, identifier)
      : getAgent(identifier);
  return entry?.category === category ? entry : undefined;
}

// =============================================================================
// VISIBLE AGENTS (for dropdowns)
// =============================================================================

/**
 * The two state slots the durable roster resolves against: the workspace's own
 * selection and the cross-workspace defaults. Every roster read is answered for
 * the workspace whose slots the caller hands over, so a process holding several
 * sessions never answers one paper's question with another's roster.
 */
export type AgentRosterStores = Pick<
  WorkspaceRoots,
  'workspaceState' | 'globalState'
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
  const { workspaceState, globalState } = roots;
  return new AgentRosterController({
    workspaceState,
    globalState,
    getAgents,
    getPresets: () =>
      workspaceState.get<unknown>(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
    resolveAgent: getRosterAgent,
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
 * (`delegationAvailability.ts`) and the prompt-template agent lists
 * (`userVars.ts`), so a delegating agent's tool description and its own
 * prompt vars can never list a different roster for the same run.
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
      const entry = getRosterAgent(category, key);
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

/** Resolve an identifier to an agent in a category, ignoring visibility. */
export function getCategoryAgent(
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  return findAgentByIdentifier(getAgentsByCategory(category), identifier);
}

/** Resolve a launch by pinned source, visible roster, then full category.
 * Each tier runs only when the preceding one has no match, preserving the
 * exact agent chosen during validation even when visibility changes. The
 * source is pinned either by `source` or by a `source:name` identifier; the
 * pinned tier is category-blind, so a caller that requires a category checks
 * the returned entry.
 */
export function resolveAgentForLaunch(
  stores: AgentRosterStores,
  category: AgentCategory,
  identifier: string,
  source?: AgentSource | null,
) {
  return Effect.gen(function* () {
    const pinnedKey = source
      ? agentKey(source, agentName(identifier))
      : identifier !== agentName(identifier) && identifier;
    return (
      (pinnedKey ? cache.get(pinnedKey) : undefined) ??
      (yield* getVisibleAgent(stores, category, identifier)) ??
      getCategoryAgent(category, identifier)
    );
  });
}

/**
 * Deduplicate agents by name, keeping only the highest-priority source
 * (custom > builtInWorkflow > builtInToolUse > remote) for the dropdown.
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

/**
 * Compute typed agent options data for Lit-native rendering.
 * Ensures cache is loaded first.
 */
export function computeAgentOptionsData(
  stores: AgentRosterStores,
): Effect.Effect<
  AgentOptionsDataPayload,
  AgentCatalogLoadError | StateReadFailed,
  GlobalStorageFs | FileSystem.FileSystem | AgentDirectories
> {
  return Effect.gen(function* () {
    yield* loadAgents();
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
