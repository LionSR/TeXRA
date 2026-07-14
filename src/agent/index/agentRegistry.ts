/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import * as path from 'node:path';

import { platform } from '@platform/platform';
import { AgentRosterController } from '@agent/roster/AgentRosterController';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import * as logger from '@logger/logUtils';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { parseAgentModePresets } from '@shared/schemas/agentPresets';
import type {
  AgentCategory as AgentCategoryType,
  AgentSource,
} from '@shared/schemas/agent';
import {
  agentMatchesIdentifier,
  agentKey as createKey,
  agentKeyOf,
  agentName,
} from '@shared/schemas/agent';
import { unique } from '@utils/core';
import {
  DEFAULT_WORKFLOW_AGENT,
  LEGACY_AGENT_ALIASES,
  LOOKUP_PRIORITY,
  PREFERRED_TOOL_USE_AGENTS,
  TOOL_USE_LOOKUP_PRIORITY,
} from './agentRegistryConstants';
import { scanDirectory } from './agentYamlScanner';
import { loadRemoteAgents, persistRemoteAgentMeta } from './remoteAgentMeta';
import {
  entriesToOptionData,
  sortAgentEntries,
  type AgentOptionsDataPayload,
} from './agentOptionsBuilder';
import type { AgentEntry, ResolvedAgent } from './agentEntry';

const CHANNEL = 'agentRegistry';
logger.initialize(CHANNEL);

// Re-exports kept stable for external consumers.
export type { AgentEntry, ResolvedAgent } from './agentEntry';
export { extractToolNames } from './agentYamlScanner';
export { BUILTIN_TEAM_ROOT_AGENT_NAMES } from './agentRegistryConstants';
export { createKey };

/** Legacy prefix from pre-rename era (builtIn → builtInWorkflow). */
const LEGACY_BUILTIN_PREFIX = 'builtIn:';
const NEW_BUILTIN_PREFIX = 'builtInWorkflow:';

function isLegacyBuiltInKey(k: string): boolean {
  return (
    k.startsWith(LEGACY_BUILTIN_PREFIX) && !k.startsWith('builtInToolUse:')
  );
}

/**
 * Category-to-key map for the legacy visibility mirrors. Compatibility
 * migrations iterate it so the relationship is not re-encoded per function;
 * current roster selection is owned by AgentRosterController.
 */
const ENABLED_AGENTS_STATE_KEY: Record<AgentCategory, WorkspaceStateKey> = {
  [AgentCategory.Workflow]: WorkspaceStateKey.ENABLED_AGENTS,
  [AgentCategory.ToolUse]: WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
};

/**
 * Migrate persisted `builtIn:*` keys to `builtInWorkflow:*`.
 * Idempotent: skips a state key when it holds no legacy keys.
 */
function migrateLegacySourceKeys(): void {
  for (const stateKey of Object.values(ENABLED_AGENTS_STATE_KEY)) {
    const stored = platform().workspaceState.get<string[]>(stateKey, []);
    if (!stored?.length) continue;
    if (!stored.some(isLegacyBuiltInKey)) continue;

    const migrated = stored.map((k) =>
      isLegacyBuiltInKey(k)
        ? NEW_BUILTIN_PREFIX + k.slice(LEGACY_BUILTIN_PREFIX.length)
        : k,
    );
    void platform().workspaceState.update(stateKey, migrated);
    logger.info(CHANNEL, `Migrated legacy builtIn keys in ${stateKey}`);
  }
}

// =============================================================================
// STATE
// =============================================================================

/** The cache. Just a Map. */
const cache = new Map<string, AgentEntry>();

/** Initialization state */
let initialized = false;
let initPromise: Promise<void> | null = null;
let cacheIncludesRemote = false;
let refreshQueue: Promise<void> = Promise.resolve();
let registryEpoch = 0;

export interface LoadAgentsOptions {
  /** Include remote agent metadata that requires auth/network access. */
  includeRemote?: boolean;
}

// =============================================================================
// CORE API
// =============================================================================

/**
 * Load all agents into cache. Call once at activation.
 * Thread-safe: concurrent calls share the same promise.
 */
export async function loadAgents(
  options: LoadAgentsOptions = {},
): Promise<void> {
  const includeRemote = options.includeRemote ?? true;

  if (initPromise) {
    await initPromise;
  }

  if (initialized && (!includeRemote || cacheIncludesRemote)) {
    return;
  }

  const previousInitialized = initialized;
  const previousCacheIncludesRemote = cacheIncludesRemote;
  const loadEpoch = registryEpoch;
  initPromise = doLoad(includeRemote, loadEpoch)
    .then((published) => {
      if (!published) return;
      initialized = true;
      cacheIncludesRemote = includeRemote;
    })
    .catch((error: unknown) => {
      initialized = previousInitialized;
      cacheIncludesRemote = previousCacheIncludesRemote;
      throw error;
    })
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
}

async function doLoad(
  includeRemote: boolean,
  loadEpoch: number,
): Promise<boolean> {
  const startTime = Date.now();

  // Migrate legacy builtIn:* → builtInWorkflow:* in persisted state
  migrateLegacySourceKeys();

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

  // Register all entries
  const allEntries = [
    ...customEntries,
    ...builtInEntries,
    ...toolUseEntries,
    ...remoteEntries,
  ];

  migrateFilenameAgentNameKeys(allEntries);

  // Apply category overrides from config
  const toolUseOverrides = new Set(
    platform().workspaceState.get<string[]>(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      [],
    ),
  );

  if (loadEpoch !== registryEpoch) return false;

  cache.clear();
  for (const entry of allEntries) {
    if (toolUseOverrides.has(entry.name)) {
      entry.category = AgentCategory.ToolUse;
      entry.rounds = undefined;
    }
    cache.set(agentKeyOf(entry), entry);
  }

  // Migrate legacy agent names (chat → assistant) in persisted visibility
  // sets. Runs after registration so a user-defined agent that still uses
  // the legacy name keeps its key.
  migrateLegacyAgentNameKeys();

  logger.info(
    CHANNEL,
    `Loaded ${cache.size} agents in ${Date.now() - startTime}ms`,
  );
  return true;
}

/**
 * Rewrite persisted enabled-agent keys whose name part is a legacy alias
 * (e.g. `chat` or `builtInToolUse:chat`) to the canonical agent name. The
 * Agents settings UI matches these keys literally, so leaving stale legacy
 * names in state would make an older host disagree with the current roster.
 * A registered agent that genuinely uses the legacy name (e.g. a custom
 * `chat`) keeps its key untouched.
 */
function migrateLegacyAgentNameKeys(): void {
  for (const category of [
    AgentCategory.Workflow,
    AgentCategory.ToolUse,
  ] as const) {
    rewriteEnabledAgentKeys(
      ENABLED_AGENTS_STATE_KEY[category],
      'Migrated legacy agent names',
      (key) => {
        const name = agentName(key);
        const alias = LEGACY_AGENT_ALIASES[name];
        if (!alias) return key;
        if (key === name ? getAgent(name)?.name === name : cache.has(key)) {
          return key;
        }
        // Rewrite the name part to the alias target, preserving the original
        // key's shape (bare vs source-qualified) when it resolves to an agent
        // IN THIS LIST'S CATEGORY. Otherwise resolve the alias within the
        // category, so the rewrite can never persist a wrong-category key, e.g.
        // a custom workflow `assistant` shadowing the built-in tool-use one
        // must not land in tool-use visibility state (the settings UI matches
        // keys literally, so a cross-category key would orphan the toggle).
        // Keep the original key when no agent of this category matches, rather
        // than inventing one.
        const rewritten = withAgentName(key, alias);
        if (getAgent(rewritten)?.category === category) return rewritten;
        const canonical = getCategoryAgent(category, alias);
        return canonical ? agentKeyOf(canonical) : key;
      },
    );
  }
}

/**
 * Apply `rewrite` to every persisted enabled-agent key in `stateKey` and persist
 * the deduplicated result when anything changed. Shared by the legacy-name and
 * filename-based migrations so the load/compare/persist/log boilerplate lives in
 * one place.
 */
function rewriteEnabledAgentKeys(
  stateKey: WorkspaceStateKey,
  description: string,
  rewrite: (key: string) => string,
): void {
  const stored = platform().workspaceState.get<string[]>(stateKey, []);
  if (!stored?.length) return;

  const migrated = stored.map(rewrite);
  if (migrated.every((key, i) => key === stored[i])) return;

  void platform().workspaceState.update(stateKey, unique(migrated));
  logger.info(CHANNEL, `${description} in ${stateKey}`);
}

/**
 * Before canonical YAML names, local agents were keyed by their filename. Keep
 * persisted visibility selections alive after switching identity to `name:`.
 */
function migrateFilenameAgentNameKeys(entries: readonly AgentEntry[]): void {
  const currentKeys = new Set<string>();
  const currentNames = new Set<string>();
  for (const entry of entries) {
    currentKeys.add(agentKeyOf(entry));
    currentNames.add(entry.name);
  }
  const qualifiedCandidates = new Map<string, Set<string>>();
  const bareCandidates = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry.path) continue;
    const oldName = path.basename(entry.path, '.yaml');
    if (!oldName || oldName === entry.name) continue;

    const oldKey = createKey(entry.source, oldName);
    if (!currentKeys.has(oldKey)) {
      const targets = qualifiedCandidates.get(oldKey) ?? new Set<string>();
      targets.add(agentKeyOf(entry));
      qualifiedCandidates.set(oldKey, targets);
    }
    if (!currentNames.has(oldName)) {
      const targets = bareCandidates.get(oldName) ?? new Set<string>();
      targets.add(entry.name);
      bareCandidates.set(oldName, targets);
    }
  }

  const qualified = singleTargetMappings(qualifiedCandidates);
  const bare = singleTargetMappings(bareCandidates);

  if (qualified.size === 0 && bare.size === 0) return;

  for (const stateKey of Object.values(ENABLED_AGENTS_STATE_KEY)) {
    rewriteEnabledAgentKeys(
      stateKey,
      'Migrated filename-based agent names',
      (key) => {
        const name = agentName(key);
        // A source-qualified key differs from its bare name; match it in full,
        // otherwise map the bare name.
        if (key !== name) return qualified.get(key) ?? key;
        return bare.get(name) ?? key;
      },
    );
  }
}

function singleTargetMappings(
  candidates: ReadonlyMap<string, ReadonlySet<string>>,
): Map<string, string> {
  const mappings = new Map<string, string>();
  for (const [oldName, targets] of candidates) {
    if (targets.size === 1) {
      const target = targets.values().next().value;
      if (target) mappings.set(oldName, target);
    }
  }
  return mappings;
}

/**
 * Replace the name part of a possibly source-qualified key while preserving its
 * source prefix ("src:old" → "src:new", bare "old" → "new").
 */
function withAgentName(key: string, newName: string): string {
  const name = agentName(key);
  return key.slice(0, key.length - name.length) + newName;
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
    const entry = cache.get(createKey(source, identifier));
    if (entry) return entry;
  }

  // Legacy-name fallback, for both bare names ("chat") and source-qualified
  // keys ("builtInToolUse:chat"): map the name part through the alias table
  // and retry once.
  const alias = LEGACY_AGENT_ALIASES[agentName(identifier)];
  if (alias) {
    return getAgent(withAgentName(identifier, alias), lookupCategory);
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
 * Resolve an agent to a {@link ResolvedAgent} (entry + flattened metadata).
 *
 * Thin wrapper around {@link getAgent} for callers that want the canonical
 * "resolution" shape (definition path + resolved name) without dereferencing
 * the entry themselves. Returns `undefined` when the identifier doesn't
 * match any cached agent.
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
  return { entry, definitionPath: entry.path, resolvedName: entry.name };
}

/**
 * Agents in a category, deduplicated by name. `includeInternal` controls
 * whether internal agents (hidden from dropdowns but launchable by commands)
 * are in the set: dropdowns exclude them, launch resolution includes them.
 */
function categoryEntries(
  category: AgentCategory,
  includeInternal: boolean,
): AgentEntry[] {
  return deduplicateByName(
    [...cache.values()].filter(
      (e) => e.category === category && (includeInternal || !e.internal),
    ),
  );
}

/** Get non-internal agents for a category, deduplicated by name. */
export function getAgentsByCategory(category: AgentCategory): AgentEntry[] {
  return categoryEntries(category, false);
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
  return initialized;
}

/**
 * Refresh the cache after every older load has settled, then force a new load.
 * This prevents a post-sign-in refresh from joining an in-flight signed-out
 * remote request and incorrectly treating that stale request as authoritative.
 */
export function refresh(options: LoadAgentsOptions = {}): Promise<void> {
  const refreshEpoch = ++registryEpoch;
  const run = refreshQueue.then(async () => {
    if (refreshEpoch !== registryEpoch) return;
    if (initPromise) await initPromise.catch(() => undefined);
    if (refreshEpoch !== registryEpoch) return;
    initialized = false;
    cacheIncludesRemote = false;
    await loadAgents(options);
  });
  refreshQueue = run.catch(() => undefined);
  return run;
}

function removeRemoteEntries(): void {
  for (const [key, entry] of cache) {
    if (entry.source === 'remote') cache.delete(key);
  }
  cacheIncludesRemote = false;
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
  const entry = getAgent(identifier, category);
  return entry?.category === category && !entry.internal ? entry : undefined;
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
 * Get visible agents for a category (filtered by user visibility config).
 * Agents are already deduplicated by name from the getter functions.
 * No default → undefined means "never configured" (show all).
 */
export function getVisibleAgents(category: AgentCategory): AgentEntry[] {
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
  }).getVisibleAgents(category) as AgentEntry[];
}

/**
 * Match an identifier against a candidate set. A source-qualified identifier
 * names one specific entry, so only an exact key match counts — matching its
 * bare name could hit a different entry that shares the legacy name (e.g. a
 * custom `chat` shadowing the renamed built-in). Bare identifiers may match any
 * candidate by name.
 *
 * This is the single identity-matching rule. Every resolver that picks an entry
 * out of a list by name-or-key — the category-scoped resolvers here, plus
 * out-of-registry callers like the CLI multi-agent preset planner — goes through
 * it so the rule lives in exactly one place.
 */
export function findAgentByIdentifier(
  entries: readonly AgentEntry[],
  identifier: string,
): AgentEntry | undefined {
  return entries.find((entry) => agentMatchesIdentifier(entry, identifier));
}

/**
 * Resolve an identifier within a category-scoped candidate set: exact identity
 * match first, then the alias-aware canonical resolver mapped back into the set
 * by name. Callers supply the scope (visible-only or the full category); the
 * matching rule is identical regardless of scope.
 */
function resolveWithinCategory(
  entries: readonly AgentEntry[],
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  const exact = findAgentByIdentifier(entries, identifier);
  if (exact) return exact;

  // Legacy-alias fallback (e.g. `chat` → `assistant`). getAgent is category-
  // blind, so map its result back into the category scope by name; an entry
  // from another category is correctly rejected here.
  const entry = getAgent(identifier, category);
  if (!entry) return undefined;
  return entries.find((candidate) => candidate.name === entry.name);
}

/**
 * Resolve an identifier to a currently visible agent entry. Visibility and
 * legacy aliases are owned by the registry, so callers do not need to repeat
 * rename or enabled-agent matching rules.
 */
export function getVisibleAgent(
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  return resolveWithinCategory(
    getVisibleAgents(category),
    category,
    identifier,
  );
}

/**
 * Resolve an identifier to an agent in a category, ignoring visibility
 * (including internal agents, which are hidden from dropdowns but still hold a
 * visibility slot). Shares {@link resolveWithinCategory} with
 * {@link getVisibleAgent} so the category-scoped matching rule is identical to
 * validation's. Used by the legacy-alias migration and as the category floor of
 * {@link resolveAgentForLaunch}.
 */
export function getCategoryAgent(
  category: AgentCategory,
  identifier: string,
): AgentEntry | undefined {
  return resolveWithinCategory(
    categoryEntries(category, true),
    category,
    identifier,
  );
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
 *  3. The full category set (`getCategoryAgent`), reached only for names the
 *     visible set can't resolve — internal agents, launchable by command but
 *     hidden from dropdowns/validation.
 *
 * It never falls back to blind source-priority on a bare name, so launch only
 * ever extends resolution to internal agents — it cannot pick a different entry
 * than validation for any name validation resolves.
 */
export function resolveAgentForLaunch(
  category: AgentCategory,
  identifier: string,
  source?: AgentSource | null,
): ResolvedAgent | undefined {
  const entry =
    (source ? getAgent(createKey(source, agentName(identifier))) : undefined) ??
    getVisibleAgent(category, identifier) ??
    getCategoryAgent(category, identifier);
  return entry ? toResolvedAgent(entry) : undefined;
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
