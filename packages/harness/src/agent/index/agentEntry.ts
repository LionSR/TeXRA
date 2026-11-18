/** Agent registry value objects, and what a catalog load reads them through. */

import type { AgentDirectories, AppState } from '@platform/interfaces';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { Persona, CatalogAgentSource } from '@shared/schemas';
import type { ToolRegistry } from '@tools/toolTable';
import type { FileSystem } from 'effect';

/**
 * The services an agent catalog load reads: the global and filesystem views
 * the local agent directories are scanned through, the app state the
 * disabled-plugin switch is read from, and the plugin table whose switched
 * plugins' bundled agent directories are scanned.
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
 * an entry that exists can launch. Every entry is a persona.
 */
export interface AgentEntry {
  name: string;
  source: CatalogAgentSource;
  path: string; // absolute path to the definition file
  description?: string;
  /** Digest of the definition file; absent on a plugin agent. */
  digest?: string;
  /** A customized copy's `basedOn`: the bundled file's digest it began from. */
  basedOn?: string;
  /** The model agent the entry names. */
  persona: Persona;
}

/** The names of the tools `entry`'s persona is offered. */
export const agentToolNames = (
  entry: Pick<AgentEntry, 'persona'>,
): readonly string[] => entry.persona.tools.map((tool) => tool.name);
