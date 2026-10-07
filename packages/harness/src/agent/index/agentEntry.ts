/** Agent registry value objects (canonical AgentSource: @shared/schemas/agent). */

import type { DocumentTask, Persona } from '@shared/schemas';
import type { AgentSource } from '@shared/schemas';

/**
 * An agent as the catalog lists it, and as a launch runs it: the scan
 * validated the whole definition (defaults applied), so
 * an entry that exists can launch. Every entry is a persona; one with a
 * `task` is also launchable as a document task.
 */
export interface AgentEntry {
  name: string;
  source: AgentSource;
  path: string; // absolute path to the definition file
  description?: string;
  tools?: string[]; // tool names, for display
  /** A task's revision count, for display. */
  rounds?: number;
  /** Digest of the definition file; absent on a plugin agent. */
  digest?: string;
  /** A customized copy's `basedOn`: the bundled file's digest it began from. */
  basedOn?: string;
  /** The model agent the entry names. */
  persona: Persona;
  /** The document task the file defines, or null for a chat agent. */
  task: DocumentTask | null;
}
