/** Agent registry value objects. */

import type { Persona, AgentSource } from '@shared/schemas';

/**
 * An agent as the catalog lists it, and as a launch runs it: the scan
 * validated the whole definition (defaults applied), so
 * an entry that exists can launch. Every entry is a persona; one holding a
 * plugin's block (`AgentBlock`) is also launchable as that plugin's task.
 */
export interface AgentEntry {
  name: string;
  source: AgentSource;
  path: string; // absolute path to the definition file
  description?: string;
  tools?: string[]; // tool names, for display
  /** Digest of the definition file; absent on a plugin agent. */
  digest?: string;
  /** A customized copy's `basedOn`: the bundled file's digest it began from. */
  basedOn?: string;
  /** The model agent the entry names. */
  persona: Persona;
  /** The plugins' blocks the file holds, by key, as their schemas parsed
   *  them (`agentBlockOf` reads one); empty for a chat agent. */
  blocks: Readonly<Record<string, unknown>>;
}
