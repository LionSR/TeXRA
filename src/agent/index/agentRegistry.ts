/** Agent Registry - Flat agent metadata cache with source-priority lookup. */

import * as path from 'path';
import { glob } from 'glob';
import * as yaml from 'yaml';

import {
  AgentCategory,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import { AgentSource } from '@shared/schemas/agent';
import * as logger from '@agent/core/logger';
import { getGlobalState, getWorkspaceState } from '@agent/core/stateStore';
import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import type { AgentOptionData } from '@shared/schemas';
import { agentKey as createKey, agentName } from '@shared/schemas/agent';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { AbsoluteFS } from '@utils/files';
import {
  getAgentDirectories,
  type AgentDirectories,
} from './agentDirectoriesRegistry';

const CHANNEL = 'agentRegistry';
logger.initialize(CHANNEL);

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
    const stored = getWorkspaceState().get<string[]>(stateKey, []);
    if (!stored?.length) continue;
    if (!stored.some(isLegacyBuiltInKey)) continue;

    const migrated = stored.map((k) =>
      isLegacyBuiltInKey(k)
        ? NEW_BUILTIN_PREFIX + k.slice(LEGACY_BUILTIN_PREFIX.length)
        : k,
    );
    void getWorkspaceState().update(stateKey, migrated);
    logger.info(CHANNEL, `Migrated legacy builtIn keys in ${stateKey}`);
  }
}

// =============================================================================
// TYPES (AgentSource canonical source: @shared/schemas/agent)
// =============================================================================

/**
 * Minimal agent metadata for dropdown display and path resolution.
 * No redundant fields - derive what you need.
 */
export interface AgentEntry {
  name: string;
  source: AgentSource;
  path: string; // absolute path to YAML (empty for remote)
  category: AgentCategory;
  description?: string;
  tools?: string[]; // tool names for tool-use agents
  defaultOutputFiles?: string[];
  visibility?: string[]; // remote only: group names that can access the agent
  internal?: boolean; // internal agents are hidden from dropdowns but launchable by commands
}

/**
 * Result of resolving an agent. Replaces the old AgentPathResolution interface.
 * Simple, flat, no redundant fields.
 */
export interface ResolvedAgent {
  /** The full agent entry from the registry. */
  entry: AgentEntry;
  /** Absolute path to the YAML definition (empty for remote). */
  definitionPath: string;
  /** Agent name as resolved. */
  resolvedName: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Source priority for lookups (higher priority first). */
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

/**
 * Preferred agents for dropdowns, in priority order.
 * Preferred agents present in the workspace are sorted to the top of the
 * dropdown (in the order listed here); all others follow alphabetically.
 * The remote orchestrators come first (they need sign-in); `research`/`review`
 * are local general-purpose fallbacks so signed-out users in presets like
 * Physicist/Mathematician don't land on task-specific agents (e.g. `presenter`)
 * by alphabetical accident.
 */
const DEFAULT_WORKFLOW_AGENT = 'correct';
const PREFERRED_TOOL_USE_AGENTS = [
  'orchestrator',
  'leanOrchestrator',
  'research',
  'review',
] as const;

// =============================================================================
// STATE
// =============================================================================

/** The cache. Just a Map. */
const cache = new Map<string, AgentEntry>();

/** Initialization state */
let initialized = false;
let initPromise: Promise<void> | null = null;

// =============================================================================
// CORE API
// =============================================================================

/**
 * Load all agents into cache. Call once at activation.
 * Thread-safe: concurrent calls share the same promise.
 */
export async function loadAgents(): Promise<void> {
  if (initPromise) {
    return initPromise;
  }

  initPromise = doLoad().then(() => {
    initialized = true;
    initPromise = null;
  });

  return initPromise;
}

async function doLoad(): Promise<void> {
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

  const [customEntries, builtInEntries, toolUseEntries, remoteEntries] =
    await Promise.all([
      scanDirectory(customDir, 'custom'),
      scanDirectory(builtInDir, 'builtInWorkflow'),
      scanDirectory(toolUseDir, 'builtInToolUse'),
      loadRemoteAgents(),
    ]);

  // Register all entries
  const allEntries = [
    ...customEntries,
    ...builtInEntries,
    ...toolUseEntries,
    ...remoteEntries,
  ];

  // Apply category overrides from config
  const toolUseOverrides = new Set(
    getWorkspaceState().get<string[]>(
      WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      [],
    ),
  );

  for (const entry of allEntries) {
    if (toolUseOverrides.has(entry.name)) {
      entry.category = AgentCategory.ToolUse;
    }
    const key = `${entry.source}:${entry.name}`;
    cache.set(key, entry);
  }

  logger.info(
    CHANNEL,
    `Loaded ${cache.size} agents in ${Date.now() - startTime}ms`,
  );
}

/**
 * Canonical agent resolver: look up an agent by identifier.
 *
 * Supports "source:name" format or just "name". Plain names are matched
 * against {@link LOOKUP_PRIORITY} (or {@link TOOL_USE_LOOKUP_PRIORITY} when
 * `preferToolUse` is true), returning the first hit. This handles name
 * collisions where, e.g., a workflow agent shadows a tool-use agent.
 *
 * All other lookups in this module (`resolveAgent`, `resolveAgentKey`,
 * `isRemoteAgent`, `updateAgent*`) delegate here.
 */
export function getAgent(
  identifier: string,
  preferToolUse = false,
): AgentEntry | undefined {
  // Direct lookup for source:name format (already resolved)
  if (cache.has(identifier)) return cache.get(identifier);

  // Find first match using session-appropriate priority
  const priority = preferToolUse ? TOOL_USE_LOOKUP_PRIORITY : LOOKUP_PRIORITY;
  for (const source of priority) {
    const entry = cache.get(`${source}:${identifier}`);
    if (entry) return entry;
  }
  return undefined;
}

/**
 * Update an agent's description in the cache.
 * Used to populate descriptions for remote agents after YAML is loaded.
 */
export function updateAgentDescription(
  identifier: string,
  description: string | undefined,
): void {
  const entry = getAgent(identifier);
  if (entry && description) {
    entry.description = description;
  }
}

/**
 * Update an agent's tool list in the cache.
 * Used to populate tools for remote agents after YAML is loaded,
 * so orchestrator agents can see what tools remote agents have.
 * Passing undefined/empty clears stale tools if the YAML removed them.
 */
export function updateAgentTools(
  identifier: string,
  tools: string[] | undefined,
): void {
  const entry = getAgent(identifier);
  if (!entry) return;
  const value = tools?.length ? tools : undefined;
  entry.tools = value;
  persistRemoteAgentMeta(entry.name, { tools: value });
}

/**
 * Update an agent's default output files in the cache.
 * Used to populate defaultOutputFiles for remote agents after YAML is loaded.
 * Passing undefined/empty clears stale values.
 */
export function updateAgentDefaultOutputFiles(
  identifier: string,
  defaultOutputFiles: string[] | undefined,
): void {
  const entry = getAgent(identifier);
  if (!entry) return;
  const value = defaultOutputFiles?.length ? defaultOutputFiles : undefined;
  entry.defaultOutputFiles = value;
  persistRemoteAgentMeta(entry.name, { defaultOutputFiles: value });
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

function getAgentsByCategory(
  category: AgentCategory,
  includeInternal: boolean,
): AgentEntry[] {
  return deduplicateByName(
    [...cache.values()].filter(
      (e) => e.category === category && (includeInternal || !e.internal),
    ),
  );
}

export function getWorkflowAgents(includeInternal = false): AgentEntry[] {
  return getAgentsByCategory(AgentCategory.Workflow, includeInternal);
}

export function getToolUseAgents(includeInternal = false): AgentEntry[] {
  return getAgentsByCategory(AgentCategory.ToolUse, includeInternal);
}

/** Get agents by source. */
export function getAgentsBySource(source: AgentSource): AgentEntry[] {
  return [...cache.values()].filter((e) => e.source === source);
}

/** Refresh the cache. */
export async function refresh(): Promise<void> {
  initialized = false;
  await loadAgents();
}

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Extract tool names from raw YAML tool configs.
 * Tools can be plain strings ("web_search") or objects ({ name: "web_search", ... }).
 */
export function extractToolNames(
  rawTools: unknown[] | undefined,
): string[] | undefined {
  return rawTools?.flatMap((t) => {
    if (typeof t === 'string') return t;
    const name = (t as Record<string, unknown>)?.name;
    return typeof name === 'string' ? name : [];
  });
}

async function scanDirectory(
  dir: string,
  source: AgentSource,
): Promise<AgentEntry[]> {
  if (!dir) return [];

  try {
    const files = await glob('**/*.yaml', {
      cwd: dir,
      absolute: true,
      nodir: true,
    });
    const entries = await Promise.all(
      files.map((f) => {
        const name = path.basename(f, '.yaml');
        return scanYaml(name, f, source);
      }),
    );

    const result = entries.filter((e): e is AgentEntry => e !== null);
    logger.debug(CHANNEL, `Scanned ${result.length} agents from ${source}`);
    return result;
  } catch (err) {
    logger.error(CHANNEL, `Failed to scan ${dir}: ${err}`);
    return [];
  }
}

async function scanYaml(
  name: string,
  yamlPath: string,
  source: AgentSource,
): Promise<AgentEntry | null> {
  try {
    const content = await AbsoluteFS.read(yamlPath);
    const parsed = yaml.parse(content);
    const validated = AgentDefinitionSchema.parse(parsed);

    // Extract lightweight metadata
    const rawSettings = (validated.settings ?? {}) as Record<string, unknown>;
    const defaultOutputFiles = rawSettings.defaultOutputFiles as
      | string[]
      | undefined;

    const tools = extractToolNames(rawSettings.tools as unknown[] | undefined);

    // Determine category from source or explicit setting
    const rawCategory = rawSettings.agentCategory as string | undefined;
    const category =
      source === 'builtInToolUse' || rawCategory === AgentCategory.ToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    const internal = rawSettings.internal === true || undefined;

    return {
      name,
      source,
      path: yamlPath,
      category,
      description: validated.description,
      tools: tools?.length ? tools : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
      internal,
    };
  } catch (err) {
    logger.warn(CHANNEL, `Failed to scan ${yamlPath}: ${err}`);
    return null;
  }
}

// =============================================================================
// REMOTE AGENT METADATA PERSISTENCE
// =============================================================================

/**
 * Cached metadata for a remote agent, persisted in globalState.
 * Populated lazily when a remote agent's YAML is first loaded.
 */
interface RemoteAgentMetaCache {
  [agentName: string]: {
    tools?: string[];
    defaultOutputFiles?: string[];
  };
}

/** Persist remote agent metadata to globalState for cross-session availability. */
function persistRemoteAgentMeta(
  agentName: string,
  meta: { tools?: string[]; defaultOutputFiles?: string[] },
): void {
  const stored =
    getGlobalState().get<RemoteAgentMetaCache>(
      GlobalStateKey.REMOTE_AGENT_META_CACHE,
      {},
    ) ?? {};
  stored[agentName] = { ...stored[agentName], ...meta };
  void getGlobalState().update(GlobalStateKey.REMOTE_AGENT_META_CACHE, stored);
}

/** Load persisted remote agent metadata from globalState. */
function getPersistedRemoteAgentMeta(): RemoteAgentMetaCache {
  return (
    getGlobalState().get<RemoteAgentMetaCache>(
      GlobalStateKey.REMOTE_AGENT_META_CACHE,
      {},
    ) ?? {}
  );
}

async function loadRemoteAgents(): Promise<AgentEntry[]> {
  try {
    const { RemoteAgentLoader } =
      await import('@agent/remote/RemoteAgentLoader');
    const remotes = await RemoteAgentLoader.listRemoteAgents();
    const metaCache = getPersistedRemoteAgentMeta();

    return remotes.map((remote) => {
      const isToolUse = remote.agentCategory === AgentCategory.ToolUse;
      const cached = metaCache[remote.name];
      const dbTools = remote.tools?.length ? remote.tools : undefined;
      return {
        name: remote.name,
        source: 'remote' as const,
        path: '',
        category: isToolUse ? AgentCategory.ToolUse : AgentCategory.Workflow,
        description: remote.description ?? undefined,
        visibility: remote.visibility ?? undefined,
        tools: dbTools ?? cached?.tools,
        defaultOutputFiles: cached?.defaultOutputFiles,
      };
    });
  } catch (err) {
    logger.warn(CHANNEL, `Failed to load remote agents: ${err}`);
    return [];
  }
}

// =============================================================================
// KEY HELPERS
// =============================================================================

export { createKey };

/**
 * Resolve an agent identifier to its full source:name key.
 * Handles both plain names ("criticize") and existing keys ("builtIn:criticize").
 * Falls back to original identifier if agent not found.
 */
export function resolveAgentKey(
  agentIdentifier: string,
  preferToolUse = false,
): string {
  if (!agentIdentifier) return agentIdentifier;
  const entry = getAgent(agentIdentifier, preferToolUse);
  if (!entry) return agentIdentifier;
  return createKey(entry.source, entry.name);
}

/**
 * Extract the clean agent name from an identifier.
 * Like agentName() but validates the prefix is a known AgentSource first,
 * so arbitrary strings with colons (e.g. URLs) pass through unchanged.
 */
export function getCleanAgentName(agentIdentifier: string): string {
  const colonIdx = agentIdentifier.indexOf(':');
  if (colonIdx === -1) return agentIdentifier;

  const source = agentIdentifier.slice(0, colonIdx);
  if (!AgentSource.safeParse(source).success) return agentIdentifier;

  return agentName(agentIdentifier);
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
export function getVisibleAgents(
  category: 'workflow' | 'toolUse',
): AgentEntry[] {
  const isToolUse = category === 'toolUse';
  const entries = isToolUse ? getToolUseAgents() : getWorkflowAgents();
  const stateKey = isToolUse
    ? WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS
    : WorkspaceStateKey.ENABLED_AGENTS;
  const raw = getWorkspaceState().get<string[]>(stateKey);
  return filterVisible(entries, raw);
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
): AgentEntry[] {
  // undefined = never configured → show all; [] = explicitly empty → show none
  if (configured === undefined) return entries;
  // Match by name so visibility survives when dedup changes the winning source.
  const enabledNames = new Set(configured.map(agentName));
  return entries.filter((entry) => enabledNames.has(entry.name));
}

// =============================================================================
// TYPED OPTIONS BUILDER (Lit-native)
// =============================================================================

// AgentOptionData type is imported from @shared/schemas (single source of truth)

interface AgentOptionsDataPayload {
  workflow: AgentOptionData[];
  toolUse: AgentOptionData[];
}

/**
 * Convert AgentEntry to typed option data.
 */
function entryToOptionData(entry: AgentEntry): AgentOptionData {
  const key = createKey(entry.source, entry.name);
  return {
    value: key,
    label: entry.name,
    isToolUse: entry.category === AgentCategory.ToolUse,
    isOrchestrator: entry.tools?.some((t) => DELEGATION_TOOLS.has(t)),
    isRemote: entry.source === 'remote',
    isCustom: entry.source === 'custom',
    description: entry.description,
  };
}

/**
 * Sort entries: preferred agents first (in priority order), then alphabetically.
 */
function sortAgentEntries(
  entries: AgentEntry[],
  preferredNames: readonly string[],
): AgentEntry[] {
  const preferredSet = new Map(
    preferredNames
      .map((name, i) => [entries.find((e) => e.name === name), i] as const)
      .filter(([entry]) => entry != null),
  );
  return [...entries].sort((a, b) => {
    const aIdx = preferredSet.get(a);
    const bIdx = preferredSet.get(b);
    if (aIdx != null && bIdx != null) return aIdx - bIdx;
    if (aIdx != null) return -1;
    if (bIdx != null) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Compute typed agent options data for Lit-native rendering.
 * Ensures cache is loaded first.
 */
export async function computeAgentOptionsData(): Promise<AgentOptionsDataPayload> {
  if (!initialized) {
    await (initPromise ?? loadAgents());
  }

  return {
    workflow: sortAgentEntries(getVisibleAgents('workflow'), [
      DEFAULT_WORKFLOW_AGENT,
    ]).map(entryToOptionData),
    toolUse: sortAgentEntries(
      getVisibleAgents('toolUse'),
      PREFERRED_TOOL_USE_AGENTS,
    ).map(entryToOptionData),
  };
}
