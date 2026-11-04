/** Agent registry value objects, and what a catalog load reads them through. */

import type { AgentDirectories, AppState } from '@platform/interfaces';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { Persona, AgentSource } from '@shared/schemas';
import type { ToolRegistry } from '@tools/toolTable';
import type { FileSystem } from 'effect';

/**
 * The services an agent catalog load reads: the global and filesystem views
 * the local agent directories are scanned through, the app state the
 * disabled-plugin switch is read from, and the plugin table whose agent-file
 * blocks a scan admits.
 */
export type AgentCatalogServices =
  | GlobalStorageFs
  | FileSystem.FileSystem
  | AgentDirectories
  | AppState
  | ToolRegistry;

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
