/** Agent registry value objects (canonical AgentSource: @shared/schemas/agent). */

import type { AgentCategory, AgentDefinition } from '@agent/core/definition/AgentDataclass';
import type { AgentSource } from '@shared/schemas/agent';

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
  rounds?: number; // workflow round count
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
  /**
   * When `entry.source === 'inline'`, the validated definition that was
   * registered — carried here so the loader uses the exact definition the
   * resolver selected, not whatever a concurrent re-registration may have
   * replaced (Fix #9).
   */
  inlineDefinition?: AgentDefinition;
}
