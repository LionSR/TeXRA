/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import * as path from 'node:path';

import { platform } from '@platform/platform';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import * as logger from '@logger/logUtils';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type {
  AgentCategory as AgentCategoryType,
  AgentSource,
} from '@shared/schemas/agent';
import { agentKey as createKey, agentName } from '@shared/schemas/agent';
import { unique } from '@utils/core';
import { getAgentDirectories } from './agentDirectoriesRegistry';
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
export {
  BUILTIN_TEAM_ROOT_AGENT_NAMES,
  BUNDLED_ORCHESTRATOR_AGENT_NAMES,
  REMOTE_ORCHESTRATOR_AGENT_NAMES,
} from './agentRegistryConstants';
export { createKey };

/** Legacy prefix from pre-rename era (builtIn → builtInWorkflow). */
const LEGACY_BUILTIN_PREFIX = 'builtIn:';
const NEW_BUILTIN_PREFIX = 'builtInWorkflow:';

/**
 * Migrate persisted `builtIn:*` keys to `builtInWorkflow:*`.
 * Idempotent — skips if no legacy keys found.
 */
function isLegacyBuiltInKey(k: string): boolean {
  return (
    k.startsWith(LEGACY_BUILTIN_PREFIX) && !k.startsWith('builtInToolUse:')
  );
}

function migrateLegacySourceKeys(): void {
  for (const stateKey of [
    WorkspaceStateKey.ENABLED_AGENTS,
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  ] as const) {
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

  initPromise = doLoad({ includeRemote })
    .then(() => {
      initialized = true;
      cacheIncludesRemote = includeRemote;
    })
    .catch((error: unknown) => {
      initialized = false;
      cacheIncludesRemote = false;
      throw error;
    })
    .finally(() => {
      initPromise = null;
    });

  return initPromise;
}

async function doLoad(options: LoadAgentsOptions = {}): Promise<void> {
  const startTime = Date.now();
  cache.clear();

  // Migrate legacy builtIn:* → builtInWorkflow:* in persisted state
  migrateLegacySourceKeys();

  // Load from all sources in parallel
  const dirs = getAgentDirectories();
  const [customDir, builtInDir, toolUseDir] = await Promise.all([
    dirs.custom(),
    dirs.builtIn(),
    dirs.builtInToolUse(),
  ]);

  const includeRemote = options.includeRemote ?? true;
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

  for (const entry of allEntries) {
    if (toolUseOverrides.has(entry.name)) {
      entry.category = AgentCategory.ToolUse;
      entry.rounds = undefined;
    }
    const key = `${entry.source}:${entry.name}`;
    cache.set(key, entry);
  }

  // Migrate legacy agent names (chat → assistant) in persisted visibility
  // sets. Runs after registration so a user-defined agent that still uses
  // the legacy name keeps its key.
  migrateLegacyAgentNameKeys();

  logger.info(
    CHANNEL,
    `Loaded ${cache.size} agents in ${Date.now() - startTime}ms`,
  );
}

/**
 * Rewrite persisted enabled-agent keys whose name part is a legacy alias
 * (e.g. `chat` or `builtInToolUse:chat`) to the canonical agent name. The
 * Agents settings UI matches these keys literally, so leaving stale legacy
 * names in state would show the renamed agent as disabled while
 * {@link filterVisible} still surfaces it — and toggling it off in the UI
 * could never remove the stale key. A registered agent that genuinely uses
 * the legacy name (e.g. a custom `chat`) keeps its key untouched.
 */
function migrateLegacyAgentNameKeys(): void {
  for (const stateKey of [
    WorkspaceStateKey.ENABLED_AGENTS,
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  ] as const) {
    const stored = platform().workspaceState.get<string[]>(stateKey, []);
    if (!stored?.length) continue;

    const migrated = stored.map((key) => {
      const name = agentName(key);
      const alias = LEGACY_AGENT_ALIASES[name];
      if (!alias) return key;
      if (key === name ? getAgent(name)?.name === name : cache.has(key)) {
        return key;
      }
      return key.slice(0, key.length - name.length) + alias;
    });
    if (migrated.every((key, i) => key === stored[i])) continue;

    void platform().workspaceState.update(stateKey, unique(migrated));
    logger.info(CHANNEL, `Migrated legacy agent names in ${stateKey}`);
  }
}

/**
 * Before canonical YAML names, local agents were keyed by their filename. Keep
 * persisted visibility selections alive after switching identity to `name:`.
 */
function migrateFilenameAgentNameKeys(entries: readonly AgentEntry[]): void {
  const currentKeys = new Set(
    entries.map((entry) => createKey(entry.source, entry.name)),
  );
  const currentNames = new Set(entries.map((entry) => entry.name));
  const qualifiedCandidates = new Map<string, Set<string>>();
  const bareCandidates = new Map<string, Set<string>>();

  for (const entry of entries) {
    if (!entry.path) continue;
    const oldName = path.basename(entry.path, '.yaml');
    if (!oldName || oldName === entry.name) continue;

    const oldKey = createKey(entry.source, oldName);
    if (!currentKeys.has(oldKey)) {
      const targets = qualifiedCandidates.get(oldKey) ?? new Set<string>();
      targets.add(createKey(entry.source, entry.name));
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

  for (const stateKey of [
    WorkspaceStateKey.ENABLED_AGENTS,
    WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
  ] as const) {
    const stored = platform().workspaceState.get<string[]>(stateKey, []);
    if (!stored?.length) continue;

    const migrated = stored.map((key) => {
      const name = agentName(key);
      const prefix = key.slice(0, key.length - name.length);
      if (prefix) return qualified.get(key) ?? key;
      return bare.get(name) ?? key;
    });
    if (migrated.every((key, i) => key === stored[i])) continue;

    void platform().workspaceState.update(stateKey, unique(migrated));
    logger.info(CHANNEL, `Migrated filename-based agent names in ${stateKey}`);
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
  if (cache.has(identifier)) return cache.get(identifier);

  // Find first match using session-appropriate priority
  const priority =
    lookupCategory === AgentCategory.ToolUse
      ? TOOL_USE_LOOKUP_PRIORITY
      : LOOKUP_PRIORITY;
  for (const source of priority) {
    const entry = cache.get(`${source}:${identifier}`);
    if (entry) return entry;
  }

  // Legacy-name fallback, for both bare names ("chat") and source-qualified
  // keys ("builtInToolUse:chat"): map the name part through the alias table
  // and retry once.
  const name = agentName(identifier);
  const alias = LEGACY_AGENT_ALIASES[name];
  if (alias) {
    const prefix = identifier.slice(0, identifier.length - name.length);
    return getAgent(`${prefix}${alias}`, lookupCategory);
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
 */
export function resolveAgent(identifier: string): ResolvedAgent | undefined {
  const entry = getAgent(identifier);
  if (!entry) return undefined;
  return { entry, definitionPath: entry.path, resolvedName: entry.name };
}

/** Get non-internal agents for a category, deduplicated by name. */
export function getAgentsByCategory(category: AgentCategory): AgentEntry[] {
  return deduplicateByName(
    [...cache.values()].filter((e) => e.category === category && !e.internal),
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
  return initialized;
}

/** Refresh the cache. */
export async function refresh(options: LoadAgentsOptions = {}): Promise<void> {
  initialized = false;
  cacheIncludesRemote = false;
  await loadAgents(options);
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
  return createKey(entry.source, entry.name);
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
  const entries = getAgentsByCategory(category);
  const stateKey =
    category === 'toolUse'
      ? WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS
      : WorkspaceStateKey.ENABLED_AGENTS;
  const raw = platform().workspaceState.get<string[]>(stateKey);
  return filterVisible(entries, raw, category);
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
  const entries = getVisibleAgents(category);
  const name = agentName(identifier);
  // A source-qualified identifier names one specific entry, so only an exact
  // key match counts — matching its bare name could hit a different visible
  // agent that shares the legacy name (e.g. a custom `chat` shadowing the
  // renamed built-in). Bare identifiers may match any visible agent by name.
  const exact = entries.find((entry) =>
    identifier === name
      ? entry.name === name
      : createKey(entry.source, entry.name) === identifier,
  );
  if (exact) return exact;

  const entry = getAgent(identifier, category);
  if (!entry) return undefined;
  return entries.find((visible) => visible.name === entry.name);
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

function filterVisible(
  entries: AgentEntry[],
  configured: string[] | undefined,
  category: AgentCategory,
): AgentEntry[] {
  // undefined = never configured → show all; [] = explicitly empty → show none
  if (configured === undefined) return entries;
  // Match by name so visibility survives when dedup changes the winning source.
  // A persisted legacy name also enables its canonical replacement, so agent
  // renames don't silently hide an agent the user opted into.
  const enabledNames = new Set(
    configured.flatMap((value) => {
      const name = agentName(value);
      if (entries.some((entry) => entry.name === name)) return [name];
      return [getAgent(value, category)?.name ?? name];
    }),
  );
  return entries.filter((entry) => enabledNames.has(entry.name));
}

// =============================================================================
// TYPED OPTIONS BUILDER (Lit-native)
// =============================================================================

/**
 * Compute typed agent options data for Lit-native rendering.
 * Ensures cache is loaded first.
 */
export async function computeAgentOptionsData(): Promise<AgentOptionsDataPayload> {
  if (!initialized) {
    await (initPromise ?? loadAgents());
  }

  return {
    workflow: entriesToOptionData(
      sortAgentEntries(getVisibleAgents('workflow'), [DEFAULT_WORKFLOW_AGENT]),
    ),
    toolUse: entriesToOptionData(
      sortAgentEntries(getVisibleAgents('toolUse'), PREFERRED_TOOL_USE_AGENTS),
    ),
  };
}
