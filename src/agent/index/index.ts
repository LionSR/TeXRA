/**
 * Agent index module - exports from the simplified agent registry.
 */

// New clean API
export {
  // Types
  type AgentEntry,
  type AgentSource,
  type RemoteVisibility,
  type AgentOptionsPayload,
  // Core functions
  loadAgents,
  getAgent,
  resolveAgent,
  getWorkflowAgents,
  getToolUseAgents,
  getAgentsBySource,
  isLoaded,
  waitForLoad,
  refresh,
  // HTML options
  buildAgentOptions,
  computeAgentOptions,
  computeAgentOptionsSync,
  refreshAgentOptions,
  DEFAULT_WORKFLOW_AGENT,
  DEFAULT_TOOL_USE_AGENT,
  // Compatibility helpers
  isRemoteAgent,
  shouldShowSourceIndicator,
  createKey,
  parseKey,
} from './agentRegistry';

// =============================================================================
// BACKWARD COMPATIBILITY LAYER
// These exports maintain API compatibility during migration.
// TODO: Remove once all callers are updated to use new API.
// =============================================================================

import * as path from 'path';
import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import {
  loadAgents,
  getAgent,
  resolveAgent,
  getWorkflowAgents,
  getToolUseAgents,
  getAgentsBySource,
  isLoaded,
  waitForLoad,
  refresh,
  isRemoteAgent as _isRemoteAgent,
  shouldShowSourceIndicator as _shouldShowSourceIndicator,
  createKey,
  parseKey,
  type AgentEntry,
  type AgentSource,
} from './agentRegistry';

/** @deprecated Use AgentEntry instead */
export type AgentIndexEntry = AgentEntry & {
  /** @deprecated Use path instead */
  definitionPath: string;
  /** @deprecated Use multiplePath instead */
  multipleVariantPath?: string;
  /** @deprecated Always true */
  hasDefinition: boolean;
  /** @deprecated Check multiplePath !== undefined */
  hasMultipleSibling: boolean;
  /** @deprecated Not needed for dropdown */
  isMultipleOutput: boolean;
};

/** @deprecated Use string directly */
export type AgentIndexKey = string;

/** @deprecated Use RemoteVisibility instead */
export type RemoteAgentVisibility = 'public' | 'researcher' | 'whitelist';

/** @deprecated Use createKey instead */
export function createAgentIndexKey(
  source: AgentDirectorySource,
  name: string,
): string {
  return createKey(source as unknown as AgentSource, name);
}

/** @deprecated Use parseKey instead */
export function parseAgentIndexKey(
  key: string,
): { source: AgentDirectorySource; name: string } | undefined {
  const parsed = parseKey(key);
  if (!parsed) return undefined;
  return {
    source: parsed.source as unknown as AgentDirectorySource,
    name: parsed.name,
  };
}

/**
 * @deprecated Use the function exports directly
 *
 * Compatibility shim for AgentIndex singleton.
 * Wraps the new functional API.
 */
export const AgentIndex = {
  isInitialized: isLoaded,
  waitForInitialization: waitForLoad,

  resolve(
    identifier: string,
    options?: { preferMultiple?: boolean },
  ): import('@agent/runtime/AgentPathTypes').AgentPathResolution | undefined {
    const result = resolveAgent(identifier, options?.preferMultiple);
    if (!result) return undefined;

    const { entry, resolvedPath, resolvedName } = result;
    return {
      directory: resolvedPath ? path.dirname(resolvedPath) : '',
      source: entry.source as unknown as AgentDirectorySource,
      definitionPath: resolvedPath,
      resolvedName,
      usedFallback: options?.preferMultiple === true && !entry.multiplePath,
    };
  },

  getEntryByIdentifier(identifier: string): AgentEntry | undefined {
    return getAgent(identifier);
  },

  getEntry(source: AgentDirectorySource, name: string): AgentEntry | undefined {
    return getAgent(`${source}:${name}`);
  },

  getEntriesByName(name: string): AgentEntry[] {
    const entries: AgentEntry[] = [];
    const sources: AgentSource[] = [
      'custom',
      'builtIn',
      'builtInToolUse',
      'remote',
    ];
    for (const source of sources) {
      const entry = getAgent(`${source}:${name}`);
      if (entry) entries.push(entry);
    }
    return entries;
  },

  getWorkflowEntries: getWorkflowAgents,
  getToolUseEntries: getToolUseAgents,

  getBySource(source: AgentDirectorySource): AgentEntry[] {
    return getAgentsBySource(source as unknown as AgentSource);
  },
};

/**
 * @deprecated Use loadAgents() directly
 */
export const AgentIndexLoader = {
  initialize: loadAgents,
  refreshAll: refresh,
  refreshSource: async (_source: AgentDirectorySource) => {
    // For simplicity, just refresh everything
    await refresh();
  },
};

