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
  AgentType,
  AgentCategory,
  AgentSource,
  AgentDefinitionSchema,
} from '@agent/core/AgentDataclass';
import { RemoteAgentLoader } from '@agent/remote/RemoteAgentLoader';
import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import * as logger from '@logger/logUtils';
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
  agentType: AgentType;
  description?: string;
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

/**
 * Get an agent by identifier.
 * Supports "source:name" format or just "name" (finds first match).
 */
export function getAgent(identifier: string): AgentEntry | undefined {
  // Try direct lookup (source:name format)
  const direct = cache.get(identifier);
  if (direct) return direct;

  // Parse source:name format
  const colonIdx = identifier.indexOf(':');
  if (colonIdx > 0) {
    const source = identifier.slice(0, colonIdx);
    const name = identifier.slice(colonIdx + 1);
    return cache.get(`${source}:${name}`);
  }

  // Legacy: find first match by name (priority: custom > builtIn > builtInToolUse > remote)
  const priorities: AgentSource[] = [
    'custom',
    'builtIn',
    'builtInToolUse',
    'remote',
  ];
  for (const source of priorities) {
    const entry = cache.get(`${source}:${identifier}`);
    if (entry) return entry;
  }

  return undefined;
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

/** Check if cache is loaded. */
export function isLoaded(): boolean {
  return initialized;
}

/** Wait for loading to complete. */
export async function waitForLoad(): Promise<void> {
  if (initPromise) await initPromise;
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

function groupByBaseName(
  files: string[],
): Map<string, { base?: string; multiple?: string }> {
  const groups = new Map<string, { base?: string; multiple?: string }>();

  for (const file of files) {
    const name = path.basename(file, '.yaml');
    const isMultiple = name.endsWith(MULTIPLE_SUFFIX);
    const baseName = isMultiple ? name.slice(0, -MULTIPLE_SUFFIX.length) : name;

    const group = groups.get(baseName) || {};
    if (isMultiple) {
      group.multiple = file;
    } else {
      group.base = file;
    }
    groups.set(baseName, group);
  }

  // Filter: must have base, or promote _multiple-only to base
  const result = new Map<string, { base?: string; multiple?: string }>();
  for (const [name, paths] of groups) {
    if (paths.base) {
      result.set(name, paths);
    } else if (paths.multiple) {
      // Only _multiple exists, use it as base
      result.set(`${name}${MULTIPLE_SUFFIX}`, { base: paths.multiple });
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
    const rawSettings = (validated.settings || {}) as Record<string, unknown>;
    const agentType = mapAgentType(rawSettings.agentType as string | undefined);
    const defaultOutputFiles = rawSettings.defaultOutputFiles as
      | string[]
      | undefined;

    // Determine category
    const category =
      source === 'builtInToolUse' || agentType === AgentType.ToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    return {
      name,
      source,
      path: yamlPath,
      multiplePath,
      category,
      agentType,
      description: validated.description,
      defaultOutputFiles:
        defaultOutputFiles && defaultOutputFiles.length > 0
          ? defaultOutputFiles
          : undefined,
    };
  } catch (err) {
    logger.warn(CHANNEL, `Failed to scan ${yamlPath}: ${err}`);
    return null;
  }
}

function mapAgentType(value: string | undefined): AgentType {
  if (value === 'toolUse' || value === AgentType.ToolUse)
    return AgentType.ToolUse;
  if (value === 'direct' || value === AgentType.Direct) return AgentType.Direct;
  return AgentType.CoT;
}

async function loadRemoteAgents(): Promise<AgentEntry[]> {
  const enabled = getConfig<boolean>('texra.remoteAgents.enabled', true);
  if (!enabled) return [];

  try {
    const remotes = await RemoteAgentLoader.listRemoteAgents();

    // Group remote agents by base name (same pattern as local agents)
    // This ensures consistency: both "criticize" and "criticize_multiple" from
    // the database become a single entry with multiplePath set
    const grouped = new Map<
      string,
      { base?: (typeof remotes)[0]; multiple?: (typeof remotes)[0] }
    >();

    for (const r of remotes) {
      const isMultiple = isMultipleVariant(r.name);
      const baseName = isMultiple ? getBaseName(r.name) : r.name;

      const group = grouped.get(baseName) || {};
      if (isMultiple) {
        group.multiple = r;
      } else {
        group.base = r;
      }
      grouped.set(baseName, group);
    }

    // Build entries from grouped agents
    const entries: AgentEntry[] = [];
    for (const [baseName, { base, multiple }] of grouped) {
      // Use base agent's metadata, or fall back to multiple if only _multiple exists
      const primary = base || multiple;
      if (!primary) continue;

      // If only _multiple exists without a base, use full name as the entry name
      const entryName = base ? baseName : primary.name;

      // Determine category from agentCategory (new) or agentType (legacy)
      const isToolUse = primary.agentCategory === AgentCategory.ToolUse;
      const category = isToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;
      // Derive agentType from category (toolUse category -> ToolUse type, otherwise CoT)
      const agentType = isToolUse ? AgentType.ToolUse : AgentType.CoT;

      entries.push({
        name: entryName,
        source: 'remote' as AgentSource,
        path: '',
        // Set multiplePath to indicate multiple output support (for UI indicator)
        // True if _multiple variant exists, or if this IS a _multiple-only agent
        multiplePath: multiple ? multiple.name : undefined,
        category,
        agentType,
        description: primary.description,
        visibility: primary.visibility,
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
  const parsed = parseKey(agentIdentifier);
  return parsed ? parsed.name : agentIdentifier;
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
  return isMultipleVariant(name)
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
 */
export function buildAgentOptions(): AgentOptionsPayload {
  const workflowEntries = getWorkflowAgents();
  const toolUseEntries = getToolUseAgents();

  // Get configured agent filters
  const configuredWorkflow = new Set(getConfig<string[]>('texra.agents', []));
  const configuredToolUse = new Set(
    getConfig<string[]>('texra.toolUseAgents', []),
  );

  // Filter visible entries and deduplicate by name (priority: custom > builtIn > remote)
  const visibleWorkflow = deduplicateByName(
    filterVisible(workflowEntries, configuredWorkflow),
  );
  const visibleToolUse = deduplicateByName(
    filterVisible(toolUseEntries, configuredToolUse),
  );

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

/** Source priority for deduplication (lower index = higher priority). */
const SOURCE_PRIORITY: AgentSource[] = [
  'custom',
  'builtIn',
  'builtInToolUse',
  'remote',
];

/**
 * Deduplicate agents by name, keeping only the highest priority source.
 * Custom agents override built-in agents with the same name.
 * Remote agents are NEVER deduplicated - they always show separately.
 */
function deduplicateByName(entries: AgentEntry[]): AgentEntry[] {
  const byName = new Map<string, AgentEntry>();
  const remoteEntries: AgentEntry[] = [];

  for (const entry of entries) {
    // Remote agents never get deduplicated - always show them
    if (entry.source === 'remote') {
      remoteEntries.push(entry);
      continue;
    }

    const existing = byName.get(entry.name);
    if (!existing) {
      byName.set(entry.name, entry);
      continue;
    }

    // Keep the one with higher priority (lower index in SOURCE_PRIORITY)
    const existingPriority = SOURCE_PRIORITY.indexOf(existing.source);
    const entryPriority = SOURCE_PRIORITY.indexOf(entry.source);
    if (entryPriority < existingPriority) {
      byName.set(entry.name, entry);
    }
  }

  return [...byName.values(), ...remoteEntries];
}

function filterVisible(
  entries: AgentEntry[],
  configured: Set<string>,
): AgentEntry[] {
  if (configured.size === 0) return entries;

  // Check if remote agents should auto-show (default: true)
  const autoShowRemote = getConfig<boolean>(
    'texra.remoteAgents.autoShow',
    true,
  );

  return entries.filter((e) => {
    // Auto-include remote agents if enabled (they don't need to be in texra.agents)
    if (autoShowRemote && e.source === 'remote') return true;

    const key = createKey(e.source, e.name);
    // Match by full key (e.g., "custom:correct") OR by name only (e.g., "correct")
    return configured.has(key) || configured.has(e.name);
  });
}

function renderOptions(
  entries: AgentEntry[],
  defaultName: string,
  emptyMsg: string,
): string {
  if (entries.length === 0) {
    return `<vscode-option value="">${emptyMsg}</vscode-option>`;
  }

  // After deduplication, each name appears only once - simple name match
  const defaultEntry = entries.find((e) => e.name === defaultName);

  // Sort: selected first, then alphabetically by name
  const sorted = [...entries].sort((a, b) => {
    if (a.name === defaultName) return -1;
    if (b.name === defaultName) return 1;
    return a.name.localeCompare(b.name);
  });

  return sorted
    .map((entry) => renderOption(entry, entry === defaultEntry))
    .join('\n');
}

function renderOption(entry: AgentEntry, selected: boolean): string {
  const key = `${entry.source}:${entry.name}`;
  const attrs: string[] = [
    `value="${encodeHtml(key)}"`,
    `data-label="${encodeHtml(entry.name)}"`,
    `data-source="${encodeHtml(entry.source)}"`,
  ];

  if (entry.multiplePath) attrs.push('data-multiple="true"');
  if (entry.category === AgentCategory.ToolUse)
    attrs.push('data-tool-use="true"');
  if (shouldShowSourceIndicator(entry.source)) {
    if (entry.source === 'remote') attrs.push('data-remote="true"');
    if (entry.source === 'custom') attrs.push('data-custom="true"');
  }
  if (entry.description)
    attrs.push(`data-description="${encodeHtml(entry.description)}"`);
  if (entry.agentType)
    attrs.push(`data-agent-type="${encodeHtml(entry.agentType)}"`);
  if (selected) attrs.push('selected');

  return `<vscode-option ${attrs.join(' ')}>${encodeHtml(entry.name)}</vscode-option>`;
}

/**
 * Async version - ensures cache is loaded first.
 */
export async function computeAgentOptions(): Promise<AgentOptionsPayload> {
  if (!initialized) {
    await loadAgents();
  } else if (initPromise) {
    await initPromise;
  }
  return buildAgentOptions();
}

/**
 * Build placeholder options from config when cache isn't ready.
 * Only uses default when no agents are configured.
 */
function buildPlaceholderOptions(
  configKey: string,
  defaultAgent: string,
): string {
  const configured = getConfig<string[]>(configKey, []);
  // Only use default if nothing is configured
  const agents = configured.length > 0 ? configured : [defaultAgent];

  return agents
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
  if (!initialized) {
    return {
      workflow: buildPlaceholderOptions('texra.agents', DEFAULT_WORKFLOW_AGENT),
      toolUse: buildPlaceholderOptions(
        'texra.toolUseAgents',
        DEFAULT_TOOL_USE_AGENT,
      ),
    };
  }
  return buildAgentOptions();
}

/**
 * Refresh and rebuild options.
 */
export async function refreshAgentOptions(): Promise<AgentOptionsPayload> {
  await refresh();
  return buildAgentOptions();
}
