/**
 * Agent Registry - Simple, flat agent metadata cache.
 *
 * This replaces the over-engineered AgentIndex/AgentIndexLoader/AgentIndexEntry
 * with ~200 lines of straightforward code.
 *
 * Design principles:
 * - Data structures, not classes
 * - Functions, not methods
 * - Zod for validation
 * - No redundant fields
 */

import * as path from 'path';
import { glob } from 'glob';
import * as yaml from 'yaml';
import { z } from 'zod';
import { encode as encodeHtml } from 'he';

import {
  AgentCategory,
  AgentSource,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import * as logger from '@logger/logUtils';
import type { AgentOptionData } from '@shared/schemas';
import { AbsoluteFS } from '@utils/files';
import { getConfig } from '@utils/config';

const CHANNEL = 'agentRegistry';
logger.initialize(CHANNEL);

// =============================================================================
// TYPES (AgentSource is now imported from @agent/core/AgentDataclass)
// =============================================================================

/**
 * Remote agent visibility levels.
 *
 * Visibility is an array of group names that can access the agent.
 * User can access the agent if their permissions overlap with visibility.
 *
 * Common values:
 * - ['public']: Available to all authenticated users
 * - ['researcher']: Requires 'researcher' in user's permissions
 * - ['math', 'cs']: Available to users with 'math' OR 'cs' permission
 *
 * New visibility levels can be added in the database without code changes.
 */
export type RemoteVisibility = string[];

/**
 * Minimal agent metadata for dropdown display and path resolution.
 * No redundant fields - derive what you need.
 */
export interface AgentEntry {
  name: string;
  source: AgentSource;
  path: string; // absolute path to YAML (empty for remote)
  multiplePath?: string; // path to _multiple variant if exists
  category: AgentCategory;
  description?: string;
  tools?: string[]; // tool names for tool-use agents
  defaultOutputFiles?: string[];
  visibility?: RemoteVisibility; // remote only
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
  /** Agent name (may include _multiple suffix if that variant was resolved). */
  resolvedName: string;
  /** True if _multiple was requested but not available. */
  usedFallback: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** Suffix for multiple-output agent variants. */
export const MULTIPLE_SUFFIX = '_multiple';

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

/**
 * Check if the agent cache has been initialized.
 * Use this to avoid redundant loadAgents() calls.
 */
export function isAgentCacheInitialized(): boolean {
  return initialized;
}

/**
 * Ensure agents are loaded, without triggering a re-scan if already loaded.
 * Prefer this over loadAgents() when you just need to access the cache.
 */
export async function ensureAgentsLoaded(): Promise<void> {
  if (initialized) {
    return;
  }
  if (initPromise) {
    return initPromise;
  }
  return loadAgents();
}

async function doLoad(): Promise<void> {
  const startTime = Date.now();
  cache.clear();

  // Load from all sources in parallel
  const [customDir, builtInDir, toolUseDir] = await Promise.all([
    agentDirectories.custom(),
    agentDirectories.builtIn(),
    agentDirectories.builtInToolUse(),
  ]);

  const [customEntries, builtInEntries, toolUseEntries, remoteEntries] =
    await Promise.all([
      scanDirectory(customDir, 'custom'),
      scanDirectory(builtInDir, 'builtIn'),
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
    getConfig<string[]>('texra.toolUseAgents', []),
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

/** Source priority for lookups (higher priority first). */
const LOOKUP_PRIORITY: AgentSource[] = [
  'custom',
  'builtIn',
  'builtInToolUse',
  'remote',
];

/**
 * Get an agent by identifier.
 * Supports "source:name" format or just "name" (finds first match by priority).
 */
export function getAgent(identifier: string): AgentEntry | undefined {
  // Direct lookup for source:name format
  if (cache.has(identifier)) return cache.get(identifier);

  // Legacy: find first match by name across sources
  for (const source of LOOKUP_PRIORITY) {
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
 * Resolve an agent to its definition path, handling _multiple variant logic.
 */
export function resolveAgent(
  identifier: string,
  preferMultiple = false,
): ResolvedAgent | undefined {
  const entry = getAgent(identifier);
  if (!entry) return undefined;

  // Remote agents have no local path - variant resolution is handled by RemoteAgentLoader.
  // The multiplePath field is only used for UI indicator (data-multiple="true").
  // RemoteAgentLoader.loadRemoteAgent() handles the preferMultiple logic internally.
  if (entry.source === 'remote') {
    return {
      entry,
      definitionPath: '',
      resolvedName: entry.name,
      usedFallback: false,
    };
  }

  // Handle _multiple variant for local agents
  if (preferMultiple && entry.multiplePath) {
    return {
      entry,
      definitionPath: entry.multiplePath,
      resolvedName: `${entry.name}${MULTIPLE_SUFFIX}`,
      usedFallback: false,
    };
  }

  // Fallback: requested _multiple but not available
  const usedFallback = preferMultiple && !entry.multiplePath;
  return {
    entry,
    definitionPath: entry.path,
    resolvedName: entry.name,
    usedFallback,
  };
}

/** Get all workflow agents. */
export function getWorkflowAgents(): AgentEntry[] {
  return [...cache.values()].filter(
    (e) => e.category === AgentCategory.Workflow,
  );
}

/** Get all tool-use agents. */
export function getToolUseAgents(): AgentEntry[] {
  return [...cache.values()].filter(
    (e) => e.category === AgentCategory.ToolUse,
  );
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
    const grouped = groupByBaseName(files);
    const entries: AgentEntry[] = [];

    for (const [name, paths] of grouped) {
      const entry = await scanYaml(name, paths.base, paths.multiple, source);
      if (entry) entries.push(entry);
    }

    logger.debug(CHANNEL, `Scanned ${entries.length} agents from ${source}`);
    return entries;
  } catch (err) {
    logger.error(CHANNEL, `Failed to scan ${dir}: ${err}`);
    return [];
  }
}

/**
 * Generic helper to group items by base name, separating base vs _multiple variants.
 */
function groupByVariants<T>(
  items: T[],
  getName: (item: T) => string,
): Map<string, { base?: T; multiple?: T }> {
  const groups = new Map<string, { base?: T; multiple?: T }>();

  for (const item of items) {
    const name = getName(item);
    const isMultiple = name.endsWith(MULTIPLE_SUFFIX);
    const baseName = isMultiple ? name.slice(0, -MULTIPLE_SUFFIX.length) : name;

    const group = groups.get(baseName) ?? {};
    group[isMultiple ? 'multiple' : 'base'] = item;
    groups.set(baseName, group);
  }

  return groups;
}

function groupByBaseName(
  files: string[],
): Map<string, { base?: string; multiple?: string }> {
  const groups = groupByVariants(files, (f) => path.basename(f, '.yaml'));

  // Filter: must have base, or promote _multiple-only to base
  const result = new Map<string, { base?: string; multiple?: string }>();
  for (const [name, { base, multiple }] of groups) {
    if (base) {
      result.set(name, { base, multiple });
    } else if (multiple) {
      // Only _multiple exists, use it as base
      result.set(`${name}${MULTIPLE_SUFFIX}`, { base: multiple });
    }
  }

  return result;
}

async function scanYaml(
  name: string,
  basePath: string | undefined,
  multiplePath: string | undefined,
  source: AgentSource,
): Promise<AgentEntry | null> {
  const yamlPath = basePath || multiplePath;
  if (!yamlPath) return null;

  try {
    const content = await AbsoluteFS.read(yamlPath);
    const parsed = yaml.parse(content);
    const validated = AgentDefinitionSchema.parse(parsed);

    // Extract lightweight metadata
    const rawSettings = (validated.settings ?? {}) as Record<string, unknown>;
    const defaultOutputFiles = rawSettings.defaultOutputFiles as
      | string[]
      | undefined;

    // Extract tool names (can be strings or objects with name field)
    const rawTools = rawSettings.tools as unknown[] | undefined;
    const tools = rawTools?.flatMap((t) => {
      if (typeof t === 'string') return t;
      const name = (t as Record<string, unknown>)?.name;
      return typeof name === 'string' ? name : [];
    });

    // Determine category from source or explicit setting
    // Backward compatibility: check both agentCategory and legacy agentType
    const rawCategory = rawSettings.agentCategory as string | undefined;
    const rawAgentType = rawSettings.agentType as string | undefined;
    const category =
      source === 'builtInToolUse' ||
      rawCategory === AgentCategory.ToolUse ||
      rawAgentType === AgentCategory.ToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    return {
      name,
      source,
      path: yamlPath,
      multiplePath,
      category,
      description: validated.description,
      tools: tools?.length ? tools : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
    };
  } catch (err) {
    logger.warn(CHANNEL, `Failed to scan ${yamlPath}: ${err}`);
    return null;
  }
}

async function loadRemoteAgents(): Promise<AgentEntry[]> {
  const enabled = getConfig<boolean>('texra.remoteAgents.enabled', true);
  if (!enabled) return [];

  try {
    const remotes = await RemoteAgentLoader.listRemoteAgents();
    const grouped = groupByVariants(remotes, (r) => r.name);

    // Build entries from grouped agents
    const entries: AgentEntry[] = [];
    for (const [baseName, { base, multiple }] of grouped) {
      const primary = base || multiple;
      if (!primary) continue;

      const isToolUse = primary.agentCategory === AgentCategory.ToolUse;
      // Description from DB is cache; updated from YAML when agent is loaded
      entries.push({
        name: base ? baseName : primary.name,
        source: 'remote' as AgentSource,
        path: '',
        multiplePath: multiple?.name,
        category: isToolUse ? AgentCategory.ToolUse : AgentCategory.Workflow,
        description: primary.description ?? undefined,
        visibility: primary.visibility ?? undefined,
      });
    }

    return entries;
  } catch (err) {
    logger.warn(CHANNEL, `Failed to load remote agents: ${err}`);
    return [];
  }
}

// =============================================================================
// KEY HELPERS
// =============================================================================

/** Create source:name key. */
export function createKey(source: AgentSource, name: string): string {
  return `${source}:${name}`;
}

/** Parse source:name key. */
export function parseKey(
  key: string,
): { source: AgentSource; name: string } | undefined {
  const colonIdx = key.indexOf(':');
  if (colonIdx === -1) return undefined;

  const source = key.slice(0, colonIdx);
  const name = key.slice(colonIdx + 1);

  if (!AgentSource.safeParse(source).success) return undefined;
  return { source: source as AgentSource, name };
}

/**
 * Extract the clean agent name from an identifier.
 * Handles source:name format (e.g., "custom:summarize" → "summarize").
 */
export function getCleanAgentName(agentIdentifier: string): string {
  return parseKey(agentIdentifier)?.name ?? agentIdentifier;
}

// =============================================================================
// _MULTIPLE VARIANT HELPERS
// =============================================================================

/** Check if agent name is a _multiple variant. */
export function isMultipleVariant(name: string): boolean {
  return name.endsWith(MULTIPLE_SUFFIX);
}

/** Get base name (strips _multiple suffix if present). */
export function getBaseName(name: string): string {
  return name.endsWith(MULTIPLE_SUFFIX)
    ? name.slice(0, -MULTIPLE_SUFFIX.length)
    : name;
}

/** Get _multiple variant name (adds suffix if not present). */
export function getMultipleName(name: string): string {
  return isMultipleVariant(name) ? name : `${name}${MULTIPLE_SUFFIX}`;
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

/** Check if source should show an indicator in UI. */
export function shouldShowSourceIndicator(source: AgentSource): boolean {
  return source === 'custom' || source === 'remote';
}

// =============================================================================
// HTML OPTIONS BUILDER (for webview dropdowns)
// =============================================================================

export const DEFAULT_WORKFLOW_AGENT = 'correct';
export const DEFAULT_TOOL_USE_AGENT = 'chat';

export interface AgentOptionsPayload {
  workflow: string;
  toolUse: string;
}

/**
 * Build dropdown HTML options from cached agents.
 *
 * Note: Selection preservation is handled client-side via _markOptionAsSelected
 * in the webview, which uses DOMParser to add the 'selected' attribute based
 * on the current dropdown value before setting innerHTML.
 */
/**
 * Get visible workflow agents (filtered and deduplicated).
 * Returns the same agents shown in the main webview dropdown.
 */
export function getVisibleWorkflowAgents(): AgentEntry[] {
  const entries = getWorkflowAgents();
  const configured = new Set(getConfig<string[]>('texra.agents', []));
  return deduplicateByName(filterVisible(entries, configured));
}

/**
 * Get visible tool-use agents (filtered and deduplicated).
 * Returns the same agents shown in the main webview dropdown.
 */
export function getVisibleToolUseAgents(): AgentEntry[] {
  const entries = getToolUseAgents();
  const configured = new Set(getConfig<string[]>('texra.toolUseAgents', []));
  return deduplicateByName(filterVisible(entries, configured));
}

export function buildAgentOptions(): AgentOptionsPayload {
  const visibleWorkflow = getVisibleWorkflowAgents();
  const visibleToolUse = getVisibleToolUseAgents();

  return {
    workflow: renderOptions(
      visibleWorkflow,
      DEFAULT_WORKFLOW_AGENT,
      'No workflow agents',
    ),
    toolUse: renderOptions(
      visibleToolUse,
      DEFAULT_TOOL_USE_AGENT,
      'No tool-use agents',
    ),
  };
}

/**
 * Deduplicate agents by name, keeping only the highest priority source.
 * Custom agents override built-in agents with the same name.
 * Remote agents use source:name keys to prevent deduplication.
 */
function deduplicateByName(entries: AgentEntry[]): AgentEntry[] {
  const byKey = new Map<string, AgentEntry>();

  for (const entry of entries) {
    // Remote agents use source:name key to preserve uniqueness
    const key =
      entry.source === 'remote'
        ? createKey(entry.source, entry.name)
        : entry.name;
    const existing = byKey.get(key);

    // Keep entry if none exists or if this one has higher priority
    const isHigherPriority =
      !existing ||
      LOOKUP_PRIORITY.indexOf(entry.source) <
        LOOKUP_PRIORITY.indexOf(existing.source);

    if (isHigherPriority) {
      byKey.set(key, entry);
    }
  }

  return [...byKey.values()];
}

function filterVisible(
  entries: AgentEntry[],
  configured: Set<string>,
): AgentEntry[] {
  if (configured.size === 0) return entries;

  const autoShowRemote = getConfig<boolean>(
    'texra.remoteAgents.autoShow',
    true,
  );

  return entries.filter(
    (entry) =>
      (entry.source === 'remote' && autoShowRemote) ||
      configured.has(createKey(entry.source, entry.name)) ||
      configured.has(entry.name),
  );
}

function renderOptions(
  entries: AgentEntry[],
  defaultName: string,
  emptyMsg: string,
): string {
  if (entries.length === 0) {
    return `<vscode-option value="">${emptyMsg}</vscode-option>`;
  }

  // Sort: default agent first (by reference), then alphabetically
  const defaultEntry = entries.find((e) => e.name === defaultName);
  const sorted = [...entries].sort((a, b) => {
    if (a === defaultEntry) return -1;
    if (b === defaultEntry) return 1;
    return a.name.localeCompare(b.name);
  });

  return sorted.map(renderOption).join('\n');
}

function renderOption(entry: AgentEntry): string {
  const key = `${entry.source}:${entry.name}`;
  const attrs = [
    `value="${encodeHtml(key)}"`,
    `data-label="${encodeHtml(entry.name)}"`,
    `data-source="${encodeHtml(entry.source)}"`,
    entry.multiplePath && 'data-multiple="true"',
    entry.category === AgentCategory.ToolUse && 'data-tool-use="true"',
    entry.source === 'remote' && 'data-remote="true"',
    entry.source === 'custom' && 'data-custom="true"',
    entry.description && `data-description="${encodeHtml(entry.description)}"`,
  ].filter(Boolean);

  return `<vscode-option ${attrs.join(' ')}>${encodeHtml(entry.name)}</vscode-option>`;
}

/**
 * Async version - ensures cache is loaded first.
 *
 * Note: Selection preservation is handled client-side via _markOptionAsSelected
 * in the webview, which uses DOMParser to add the 'selected' attribute based
 * on the current dropdown value before setting innerHTML.
 */
export async function computeAgentOptions(): Promise<AgentOptionsPayload> {
  await ensureAgentsLoaded();
  return buildAgentOptions();
}

/** Build placeholder options from config when cache isn't ready. */
function buildPlaceholderOptions(
  configKey: string,
  defaultAgent: string,
): string {
  const agents = getConfig<string[]>(configKey, []);
  const names = agents.length > 0 ? agents : [defaultAgent];
  return names
    .map(
      (name) =>
        `<vscode-option value="${encodeHtml(name)}">${encodeHtml(name)}</vscode-option>`,
    )
    .join('\n');
}

/**
 * Sync version - returns placeholders from config if not loaded.
 */
export function computeAgentOptionsSync(): AgentOptionsPayload {
  if (initialized) {
    return buildAgentOptions();
  }

  return {
    workflow: buildPlaceholderOptions('texra.agents', DEFAULT_WORKFLOW_AGENT),
    toolUse: buildPlaceholderOptions(
      'texra.toolUseAgents',
      DEFAULT_TOOL_USE_AGENT,
    ),
  };
}

// =============================================================================
// TYPED OPTIONS BUILDER (Lit-native)
// =============================================================================

// AgentOptionData type is imported from @shared/schemas (single source of truth)

export interface AgentOptionsDataPayload {
  workflow: AgentOptionData[];
  toolUse: AgentOptionData[];
}

/**
 * Convert AgentEntry to typed option data.
 */
function entryToOptionData(entry: AgentEntry): AgentOptionData {
  const key = `${entry.source}:${entry.name}`;
  return {
    value: key,
    label: entry.name,
    isMultiple: Boolean(entry.multiplePath),
    isToolUse: entry.category === AgentCategory.ToolUse,
    isRemote: entry.source === 'remote',
    isCustom: entry.source === 'custom',
    description: entry.description,
  };
}

/**
 * Sort entries: default agent first, then alphabetically.
 */
function sortAgentEntries(
  entries: AgentEntry[],
  defaultName: string,
): AgentEntry[] {
  const defaultEntry = entries.find((e) => e.name === defaultName);
  return [...entries].sort((a, b) => {
    if (a === defaultEntry) return -1;
    if (b === defaultEntry) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Build typed agent options data for Lit-native rendering.
 */
export function buildAgentOptionsData(): AgentOptionsDataPayload {
  const visibleWorkflow = getVisibleWorkflowAgents();
  const visibleToolUse = getVisibleToolUseAgents();

  return {
    workflow: sortAgentEntries(visibleWorkflow, DEFAULT_WORKFLOW_AGENT).map(
      entryToOptionData,
    ),
    toolUse: sortAgentEntries(visibleToolUse, DEFAULT_TOOL_USE_AGENT).map(
      entryToOptionData,
    ),
  };
}

/**
 * Async version - ensures cache is loaded first.
 * Returns typed data for Lit-native rendering.
 */
export async function computeAgentOptionsData(): Promise<AgentOptionsDataPayload> {
  await ensureAgentsLoaded();
  return buildAgentOptionsData();
}
