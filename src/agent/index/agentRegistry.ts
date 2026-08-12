/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import { DEFAULT_WORKFLOW_AGENT } from '@agent/core/definition/AgentConfig';
import { AgentRosterController } from '@agent/roster/AgentRosterController';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { AgentOptionData } from '@shared/schemas';
import { PREFERRED_TOOL_USE_AGENTS } from '@shared/constants/agents';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { parseAgentModePresets } from '@shared/schemas/agentPresets';
import type {
  AgentCategory as AgentCategoryType,
  AgentSource,
} from '@shared/schemas/agent';
import type { AgentDelegationScope } from '@shared/schemas/agentRoster';
import {
  agentMatchesIdentifier,
  agentKey,
  agentKeyOf,
  agentName,
  AgentCategory,
} from '@shared/schemas/agent';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName } from '@utils/core';
import { scanDirectory } from './agentYamlScanner';
import {
  clearInlineAgentDefinitions,
  defineInlineAgents,
  inlineAgentDefinition,
  inlineAgentEntries,
} from './inlineAgents';
import { loadRemoteAgents, persistRemoteAgentMeta } from './remoteAgentMeta';
import type { AgentEntry, ResolvedAgent } from './agentEntry';

const CHANNEL = 'agentRegistry';

/**
 * Source priority for lookups (higher priority first). `inline` must be listed,
 * not omitted: `deduplicateByName` compares `indexOf`, and an absent source
 * scores `-1`, ranking it first by accident instead of by decision.
 */
const LOOKUP_PRIORITY: AgentSource[] = [
  'inline',
  'custom',
  'remote',
  'builtInWorkflow',
  'builtInToolUse',
];

/** Source priority for tool-use sessions (prefers tool-use agents over workflow). */
const TOOL_USE_LOOKUP_PRIORITY: AgentSource[] = [
  'inline',
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

/**
 * The load producing the next catalog. Every load chains on it, so the registry
 * has one serialization point instead of a promise plus a queue. Nothing on the
 * load path may await a load of its own: that await would wait on the chain it
 * is running inside. Fire-and-forget re-entry (the sign-out invalidation) is
 * fine — it queues behind the running load.
 */
let inFlight: Promise<void> | undefined;

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
 * Concurrent calls join the in-flight load and re-check what it published, so
 * only one scan runs.
 */
export async function loadAgents(
  options: LoadAgentsOptions = {},
): Promise<void> {
  const includeRemote = options.includeRemote ?? true;
  if (inFlight) await inFlight;
  if (catalog && (!includeRemote || catalog.includesRemote)) return;
  await startLoad(includeRemote, epoch);
}

/** Rebuild the cache after every older load has settled. */
function startLoad(includeRemote: boolean, loadEpoch: number): Promise<void> {
  const previous = inFlight?.catch(() => undefined) ?? Promise.resolve();
  const load: Promise<void> = previous
    .then(async () => {
      if (loadEpoch !== epoch) return;
      if (await doLoad(includeRemote, loadEpoch)) {
        catalog = { includesRemote: includeRemote };
      }
    })
    .finally(() => {
      if (inFlight === load) inFlight = undefined;
    });
  inFlight = load;
  return load;
}

/**
 * Register agent definitions supplied as values, so an embedder can hand the
 * runtime an agent without writing a YAML file. Each definition is validated
 * here (throwing on a malformed one) and published under `inline:<name>` — a
 * namespace of its own, so an inline agent can never collide with a same-named
 * `custom` entry, only outrank it in bare-name lookups.
 *
 * Safe before or after {@link loadAgents}: entries land in the live cache
 * immediately and are re-merged by every subsequent load or refresh.
 */
export function registerInlineAgents(definitions: readonly unknown[]): void {
  for (const entry of defineInlineAgents(definitions)) {
    cache.set(agentKeyOf(entry), entry);
  }
}

/**
 * Remove all inline definitions and their corresponding live registry entries.
 * The two stores form one public registration state and must change together.
 */
export function clearInlineAgents(): void {
  clearInlineAgentDefinitions();
  for (const [key, entry] of cache) {
    if (entry.source === 'inline') cache.delete(key);
  }
}

async function doLoad(
  includeRemote: boolean,
  loadEpoch: number,
): Promise<boolean> {
  const startTime = Date.now();

  // Load from all sources in parallel
  const dirs = platform().agentDirectories;
  const [customDir, builtInDir, toolUseDir] = await Promise.all([
    dirs.custom(),
    dirs.builtIn(),
    dirs.builtInToolUse(),
  ]);

  const [customEntries, builtInEntries, toolUseEntries, remoteEntries] =
    await Promise.all([
      scanDirectory(customDir, 'custom'),
      scanDirectory(builtInDir, 'builtInWorkflow'),
      scanDirectory(toolUseDir, 'builtInToolUse'),
      includeRemote ? loadRemoteAgents() : Promise.resolve([]),
    ]);

  // Register all entries. Inline definitions were normalized at registration
  // and live outside the directory scan, so they are re-merged on every load —
  // a catalog refresh rebuilds the cache from scratch and would otherwise drop
  // them.
  const allEntries = [
    ...inlineAgentEntries(),
    ...customEntries,
    ...builtInEntries,
    ...toolUseEntries,
    ...remoteEntries,
  ];

  if (loadEpoch !== epoch) return false;

  cache.clear();
  for (const entry of allEntries) {
    cache.set(agentKeyOf(entry), entry);
  }

  logger.info(
    CHANNEL,
    `Loaded ${cache.size} agents in ${Date.now() - startTime}ms`,
  );
  return true;
}

/**
 * Canonical agent resolver: look up an agent by identifier.
 *
 * Supports "source:name" format or just "name". Plain names use the default
 * source priority unless `lookupCategory` requests a category-specific
 * priority. This is not a category filter: callers that require a category
 * must check the returned entry.
 *
 * All other lookups in this module (`resolveAgent`, `resolveAgentKey`,
 * `isRemoteAgent`, `updateAgent*`) delegate here.
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

/**
 * Update a remote agent's metadata in the cache after its YAML is loaded.
 *
 * `description` is display-only and not persisted. `tools` and
 * `defaultOutputFiles` are persisted so orchestrator agents can see them across
 * reloads; passing an empty/undefined value clears stale entries. Fields absent
 * from `meta` are left untouched.
 */
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

  if (meta.description) {
    entry.description = meta.description;
  }

  const persisted: { tools?: string[]; defaultOutputFiles?: string[] } = {};
  if ('tools' in meta) {
    entry.tools = persisted.tools = meta.tools?.length ? meta.tools : undefined;
  }
  if ('defaultOutputFiles' in meta) {
    const value = meta.defaultOutputFiles?.length
      ? meta.defaultOutputFiles
      : undefined;
    entry.defaultOutputFiles = persisted.defaultOutputFiles = value;
  }
  if ('tools' in meta || 'defaultOutputFiles' in meta) {
    persistRemoteAgentMeta(entry.name, persisted);
  }
}

/**
 * Resolve an agent to a {@link ResolvedAgent} (entry + carried inline definition).
 *
 * Thin wrapper around {@link getAgent} that also carries the inline
 * definition the resolver selected. Returns `undefined` when the identifier
 * doesn't match any cached agent.
 *
 * Category-blind: a bare name resolves by source priority, so this is for
 * display/diagnostic/inheritance lookups, NOT launch. Launch must use
 * {@link resolveAgentForLaunch} so it lands on the exact entry validation chose.
 */
export function resolveAgent(identifier: string): ResolvedAgent | undefined {
  const entry = getAgent(identifier);
  return entry ? toResolvedAgent(entry) : undefined;
}

function toResolvedAgent(entry: AgentEntry): ResolvedAgent {
  const resolved: ResolvedAgent = { entry };
  // Carry the inline definition in the resolution so the load path doesn't
  // re-lookup mutable global state — a re-registration between resolution
  // and load could otherwise pair a stale entry with a replaced definition.
  if (entry.source === 'inline') {
    resolved.inlineDefinition = inlineAgentDefinition(entry.name);
  }
  return resolved;
}

/** Get agents for a category, deduplicated by name. */
export function getAgentsByCategory(category: AgentCategory): AgentEntry[] {
  return deduplicateByName(
    [...cache.values()].filter((e) => e.category === category),
  );
}

/** Get agents by source. */
export function getAgentsBySource(source: AgentSource): AgentEntry[] {
  return [...cache.values()].filter((e) => e.source === source);
}

/**
 * Whether the local registry has been loaded so `getAgent` lookups are
 * meaningful. Callers that distinguish "agent absent" from "registry not yet
 * loaded" must check this first — an empty cache looks identical otherwise.
 */
export function isAgentRegistryReady(): boolean {
  return catalog !== undefined;
}

/**
 * Force a new load after every older one has settled, superseding any load
 * still queued from before. The cache keeps serving the catalog it already
 * published until the new one lands, including when the refresh fails.
 */
export function refresh(options: LoadAgentsOptions = {}): Promise<void> {
  return startLoad(options.includeRemote ?? true, ++epoch);
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
export function invalidateRemoteAgentsAfterSignOut(): Promise<void> {
  removeRemoteEntries();
  return refresh({ includeRemote: false }).catch((error: unknown) => {
    // An older in-flight remote load may have settled before the rebuild.
    // Preserve the signed-out invariant even when local directory I/O fails.
    removeRemoteEntries();
    logger.warn(
      CHANNEL,
      `Local agent catalog rebuild failed after sign-out: ${String(error)}`,
    );
  });
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
  const { workspaceState, globalState } = platform();
  return new AgentRosterController({
    workspaceState,
    globalState,
    getAgents: getAgentsByCategory,
    getPresets: () =>
      parseAgentModePresets(
        workspaceState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
      ),
    resolveAgent: getRosterAgent,
    fallbackTeamId: null,
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
): ResolvedAgent | undefined {
  const entry =
    (source ? getAgent(agentKey(source, agentName(identifier))) : undefined) ??
    getVisibleAgent(category, identifier) ??
    getCategoryAgent(category, identifier);
  return entry ? toResolvedAgent(entry) : undefined;
}

/**
 * Deduplicate agents by name, keeping only the highest priority source.
 * Priority: inline > custom > remote > builtInWorkflow > builtInToolUse.
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

export interface AgentOptionsDataPayload {
  workflow: AgentOptionData[];
  toolUse: AgentOptionData[];
}

export function entriesToOptionData(
  entries: readonly AgentEntry[],
): AgentOptionData[] {
  return entries.map((entry) => ({
    value: agentKeyOf(entry),
    label: entry.name,
    isToolUse: entry.category === AgentCategory.ToolUse,
    isOrchestrator: hasDelegationTool(entry.tools),
    isRemote: entry.source === 'remote',
    isCustom: entry.source === 'custom',
    isInline: entry.source === 'inline',
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
export async function computeAgentOptionsData(): Promise<AgentOptionsDataPayload> {
  await loadAgents();

  return {
    workflow: entriesToOptionData(
      sortAgentEntries(getVisibleAgents('workflow'), [DEFAULT_WORKFLOW_AGENT]),
    ),
    toolUse: entriesToOptionData(
      sortAgentEntries(getVisibleAgents('toolUse'), PREFERRED_TOOL_USE_AGENTS),
    ),
  };
}
