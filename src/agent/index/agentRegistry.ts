/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import { Data, Effect } from 'effect';
import { AgentRosterController } from '@agent/roster/AgentRosterController';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { workspaceRoots } from '@platform/workspaceRoots';
import type {
  AgentCategory as AgentCategoryType,
  AgentDelegationScope,
  AgentOptionData,
  AgentScanIssue,
  AgentSource,
} from '@shared/schemas';
import {
  AgentCategory,
  DEFAULT_WORKFLOW_AGENT,
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  parseAgentModePresets,
} from '@shared/schemas';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { scanDirectory } from './agentYamlScanner';
import { loadRemoteAgents } from './remoteAgentMeta';
import type { AgentEntry } from './agentEntry';

const log = createLog('agentRegistry');

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
 */
const LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'remote',
  'builtInWorkflow',
  'builtInToolUse',
];

/** Source priority for tool-use sessions (prefers tool-use agents over workflow). */
const TOOL_USE_LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'remote',
  'builtInToolUse',
  'builtInWorkflow',
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
): Effect.Effect<void, AgentCatalogLoadError> {
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
  includeRemote: boolean,
  loadEpoch: number,
): Effect.Effect<void, AgentCatalogLoadError> {
  return Effect.suspend(() => {
    if (loadEpoch !== epoch) return Effect.void;
    return doLoad(includeRemote, loadEpoch).pipe(
      Effect.map((loaded) => {
        if (loaded) catalog = { includesRemote: includeRemote };
      }),
    );
  });
}

function doLoad(
  includeRemote: boolean,
  loadEpoch: number,
): Effect.Effect<boolean, AgentCatalogLoadError> {
  return Effect.gen(function* () {
    const startTime = Date.now();

    // Load from all sources in parallel
    const dirs = platform().agentDirectories;
    const resolveDir = (
      read: () => Promise<string>,
    ): Effect.Effect<string, AgentCatalogLoadError> =>
      Effect.tryPromise({
        try: read,
        catch: (cause) =>
          new AgentCatalogLoadError({
            message: toErrorMessage(cause),
            cause,
          }),
      });
    const [customDir, builtInDir, toolUseDir] = yield* Effect.all(
      [
        resolveDir(() => dirs.custom()),
        resolveDir(() => dirs.builtIn()),
        resolveDir(() => dirs.builtInToolUse()),
      ],
      { concurrency: 'unbounded' },
    );

    const [customScan, builtInScan, toolUseScan, remoteEntries] =
      yield* Effect.all(
        [
          scanDirectory(customDir, 'custom'),
          scanDirectory(builtInDir, 'builtInWorkflow'),
          scanDirectory(toolUseDir, 'builtInToolUse'),
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

    if (loadEpoch !== epoch) return false;

    cache.clear();
    customScanIssues = Object.freeze(customScan.issues);
    for (const entry of allEntries) {
      cache.set(agentKeyOf(entry), entry);
    }

    log.info(`Loaded ${cache.size} agents in ${Date.now() - startTime}ms`);
    return true;
  });
}

/**
 * Canonical agent resolver: look up an agent by identifier.
 *
 * Supports "source:name" format or just "name". Plain names use the default
 * source priority unless `lookupCategory` requests a category-specific
 * priority. This is not a category filter: callers that require a category
 * must check the returned entry.
 *
 * All other lookups in this module (`resolveAgentKey`, `isRemoteAgent`,
 * `updateAgent*`) delegate here.
 */
export function getAgent(
  identifier: string,
  lookupCategory?: AgentCategoryType,
): AgentEntry | undefined {
  // Direct lookup for source:name format (already resolved)
  const direct = cache.get(identifier);
  if (direct) return direct;

  // Find first match using session-appropriate priority
  const priority =
    lookupCategory === AgentCategory.ToolUse
      ? TOOL_USE_LOOKUP_PRIORITY
      : LOOKUP_PRIORITY;
  for (const source of priority) {
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
 * refresh without running it is inert.
 */
export function refresh(
  options: LoadAgentsOptions = {},
): Effect.Effect<void, AgentCatalogLoadError> {
  return Effect.suspend(() => {
    const loadEpoch = ++epoch;
    return onCatalogLoadLane(
      queueLoad(options.includeRemote ?? true, loadEpoch),
    );
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
export function invalidateRemoteAgentsAfterSignOut(): Effect.Effect<void> {
  return Effect.suspend(() => {
    removeRemoteEntries();
    return refresh({ includeRemote: false });
  }).pipe(
    Effect.catch((error: AgentCatalogLoadError) =>
      Effect.sync(() => {
        // An older in-flight remote load may have settled before the rebuild.
        // Preserve the signed-out invariant even when local directory I/O fails.
        removeRemoteEntries();
        log.warn(
          `Local agent catalog rebuild failed after sign-out: ${error.message}`,
        );
      }),
    ),
  );
}

// =============================================================================
// KEY HELPERS
// =============================================================================

/**
 * Resolve an agent identifier to its full source:name key.
 * Handles both plain names ("criticize") and existing keys ("builtIn:criticize").
 * Falls back to original identifier if agent not found.
 */
export function resolveAgentKey(
  agentIdentifier: string,
  lookupCategory?: AgentCategoryType,
): string {
  if (!agentIdentifier) return agentIdentifier;
  const entry = getAgent(agentIdentifier, lookupCategory);
  if (!entry) return agentIdentifier;
  return agentKeyOf(entry);
}

/** Resolve one roster identifier without collapsing an exact source key. */
export function getRosterAgent(
  category: AgentCategoryType,
  identifier: string,
): AgentEntry | undefined {
  const name = agentName(identifier);
  const entry =
    identifier === name
      ? getCategoryAgent(category, identifier)
      : getAgent(identifier, category);
  return entry?.category === category ? entry : undefined;
}

// =============================================================================
// SOURCE HELPERS
// =============================================================================

/** Check if identifier refers to a remote agent. */
export function isRemoteAgent(identifier: string | undefined): boolean {
  if (!identifier) return false;
  const entry = getAgent(identifier);
  return entry?.source === 'remote';
}

// =============================================================================
// VISIBLE AGENTS (for dropdowns)
// =============================================================================

/**
 * Construct the roster controller over the active host stores. This is the one
 * place the durable roster's dependencies are wired, so every host reads and
 * writes the same selection through identical resolution rules.
 */
export function createWorkspaceAgentRosterController(): AgentRosterController<AgentEntry> {
  const { workspaceState, globalState } = workspaceRoots();
  return new AgentRosterController({
    workspaceState,
    globalState,
    getAgents: getAgentsByCategory,
    getPresets: () =>
      parseAgentModePresets(
        workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
      ),
    resolveAgent: getRosterAgent,
  });
}

/**
 * Get visible agents for a category (filtered by user visibility config).
 * Agents are already deduplicated by name from the getter functions.
 * No default → undefined means "never configured" (show all).
 */
export function getVisibleAgents(category: AgentCategory): AgentEntry[] {
  return createWorkspaceAgentRosterController().getVisibleAgents(category);
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
  scope: AgentDelegationScope | undefined,
  category: AgentCategoryType,
): AgentEntry[] {
  if (!scope) return getVisibleAgents(category);
  const keys = scope[category];

  // Deduplicated by canonical key: two identifiers that resolve to the same
  // entry contribute it once.
  const byKey = new Map<string, AgentEntry>();
  for (const key of keys) {
    const entry = getRosterAgent(category, key);
    if (entry) byKey.set(agentKeyOf(entry), entry);
  }
  return [...byKey.values()];
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
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  return findAgentByIdentifier(getVisibleAgents(category), identifier);
}

/** Resolve an identifier to an agent in a category, ignoring visibility. */
export function getCategoryAgent(
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  return findAgentByIdentifier(getAgentsByCategory(category), identifier);
}

/**
 * The single launch-time resolver, in three tiers — each consulted only when the
 * previous yields nothing, so launch resolves a name to the same entry
 * validation would and never a different one:
 *
 *  1. The exact `(source, name)` entry the delegation pinned at validation, so
 *     launch lands on precisely the entry validation chose — even if the agent's
 *     visibility changed since.
 *  2. `getVisibleAgent` — the identical call validation makes — so an unpinned
 *     launch (the webview "Run", CLI, restored records) of a visible agent
 *     resolves to exactly what validation resolved, not a same-name shadow the
 *     full set would dedup to differently.
 *  3. The full category set (`getCategoryAgent`), reached only for an agent the
 *     workspace roster hides but a command still names.
 *
 * It never falls back to blind source-priority on a bare name, so launch only
 * ever extends resolution beyond the visible roster — it cannot pick a
 * different entry than validation for any name validation resolves.
 */
export function resolveAgentForLaunch(
  category: AgentCategory,
  identifier: string,
  source?: AgentSource | null,
): AgentEntry | undefined {
  return (
    (source ? getAgent(agentKey(source, agentName(identifier))) : undefined) ??
    getVisibleAgent(category, identifier) ??
    getCategoryAgent(category, identifier)
  );
}

/**
 * Deduplicate agents by name, keeping only the highest priority source.
 * Priority: custom > remote > builtInWorkflow > builtInToolUse.
 * When the same agent name exists in multiple sources (e.g. local + remote),
 * only the highest-priority version appears in the dropdown.
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
export function computeAgentOptionsData(): Effect.Effect<
  AgentOptionsDataPayload,
  AgentCatalogLoadError
> {
  return Effect.map(loadAgents(), () => ({
    workflow: entriesToOptionData(
      sortAgentEntries(getVisibleAgents('workflow'), [DEFAULT_WORKFLOW_AGENT]),
    ),
    toolUse: entriesToOptionData(
      sortAgentEntries(getVisibleAgents('toolUse'), PREFERRED_TOOL_USE_AGENTS),
    ),
  }));
}
