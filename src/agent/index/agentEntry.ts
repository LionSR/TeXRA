/** Agent registry value objects (canonical AgentSource: @shared/schemas/agent). */

import type { AgentSource, AgentCategory } from '@shared/schemas';

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
}
