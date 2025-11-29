/**
 * Agent index entry types - the single source of truth for agent metadata.
 * These types are used throughout the codebase for agent identification and lookup.
 */

import { AgentDirectorySource } from '@agent/runtime/AgentPathTypes';
import { AgentCategory, AgentType } from '@agent/core/AgentDataclass';

/** Remote agent visibility levels. */
export type RemoteAgentVisibility = 'public' | 'researcher' | 'whitelist';

/**
 * Lightweight metadata for an agent, cached at activation.
 * Contains enough information for dropdown display and routing,
 * but NOT the full settings/prompts (those are loaded fresh at execution).
 */
export interface AgentIndexEntry {
  /** Clean agent name (no prefixes). */
  name: string;

  /** Where this agent comes from. */
  source: AgentDirectorySource;

  /** Workflow or tool-use category. */
  category: AgentCategory;

  /** Absolute path to the YAML definition (empty for remote agents). */
  definitionPath: string;

  /** Path to _multiple variant if it exists. */
  multipleVariantPath?: string;

  /** Whether the agent has a valid definition that can be loaded. */
  hasDefinition: boolean;

  /** Whether a _multiple sibling file exists. */
  hasMultipleSibling: boolean;

  /** Whether the YAML declares isMultipleOutput: true. */
  isMultipleOutput: boolean;

  /** Agent description from YAML or remote DB. */
  description?: string;

  /** Cached defaultOutputFiles from settings (avoids re-parsing). */
  defaultOutputFiles?: string[];

  /** Visibility level for remote agents (only set for Remote source). */
  visibility?: RemoteAgentVisibility;

  /** Tags for remote agents (only set for Remote source). */
  tags?: string[];

  /** Original agent type from YAML or remote DB (CoT, direct, toolUse). */
  agentType?: AgentType;
}

/**
 * Composite key for uniquely identifying an agent.
 * Format: "source:name" (e.g., "custom:summarize", "remote:summarize")
 */
export type AgentIndexKey = `${AgentDirectorySource}:${string}`;

/**
 * Create a composite key from source and name.
 */
export function createAgentIndexKey(
  source: AgentDirectorySource,
  name: string,
): AgentIndexKey {
  return `${source}:${name}` as AgentIndexKey;
}

/**
 * Parse a composite key back to source and name.
 * Returns undefined if the key is invalid.
 */
export function parseAgentIndexKey(
  key: string,
): { source: AgentDirectorySource; name: string } | undefined {
  const colonIndex = key.indexOf(':');
  if (colonIndex === -1) {
    return undefined;
  }

  const sourceStr = key.slice(0, colonIndex);
  const name = key.slice(colonIndex + 1);

  // Validate source is a valid AgentDirectorySource
  const validSources = Object.values(AgentDirectorySource);
  if (!validSources.includes(sourceStr as AgentDirectorySource)) {
    return undefined;
  }

  return {
    source: sourceStr as AgentDirectorySource,
    name,
  };
}

/**
 * Check if a string is a valid agent index key (contains source prefix).
 */
export function isAgentIndexKey(value: string): value is AgentIndexKey {
  return parseAgentIndexKey(value) !== undefined;
}

/**
 * Check if an agent identifier in source:name format refers to a remote agent.
 * Returns false for identifiers without a source prefix (use AgentIndex.isRemoteByName
 * for legacy format lookups that need to query the index).
 */
export function isRemoteAgent(agentIdentifier: string | undefined): boolean {
  if (!agentIdentifier) return false;
  const parsed = parseAgentIndexKey(agentIdentifier);
  return parsed?.source === AgentDirectorySource.Remote;
}

/**
 * Get display-friendly source label for UI.
 */
export function getSourceDisplayLabel(source: AgentDirectorySource): string {
  switch (source) {
    case AgentDirectorySource.Custom:
      return 'custom';
    case AgentDirectorySource.BuiltIn:
      return 'built-in';
    case AgentDirectorySource.BuiltInToolUse:
      return 'built-in';
    case AgentDirectorySource.Remote:
      return 'remote';
  }
}

/**
 * Check if two sources should be visually distinguished in the UI.
 * Built-in sources are considered "default" and don't need indicators.
 */
export function shouldShowSourceIndicator(
  source: AgentDirectorySource,
): boolean {
  return (
    source === AgentDirectorySource.Custom ||
    source === AgentDirectorySource.Remote
  );
}
