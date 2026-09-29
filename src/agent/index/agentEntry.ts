/** Agent registry value objects (canonical AgentSource: @shared/schemas/agent). */

import type {
  AgentPrompt,
  AgentSetting,
} from '@agent/core/definition/AgentDataclass';
import type { AgentSource, AgentCategory } from '@shared/schemas';

/**
 * An agent as the catalog lists it, and as a launch runs it: the scan
 * validated the whole definition (inheritance merged, defaults applied), so
 * an entry that exists can launch.
 */
export interface AgentEntry {
  name: string;
  source: AgentSource;
  path: string; // absolute path to the definition file
  category: AgentCategory;
  description?: string;
  tools?: string[]; // tool names, for display
  rounds?: number; // workflow round count, for display
  /** The resolved settings and prompts the run starts from. */
  setting: AgentSetting;
  prompt: AgentPrompt;
}
