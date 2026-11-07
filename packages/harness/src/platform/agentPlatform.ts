/**
 * What an embedder hands the package to compose its process from: the host
 * ports behind the process services, and the workspace roots its runs work
 * in. `nodePlatform()` builds one; a host composing its own process supplies
 * the same ports to `processLayer` one by one.
 */
import type { AgentDirectoriesPort } from './interfaces';
import type { PlatformSecrets } from './secrets';
import type { WorkspaceRoots } from './workspaceRoots';

/**
 * The process services the package composes, together with the workspace
 * roots the package's runs work in. `nodePlatform()` builds all of them; an
 * embedder supplying its own names its workspace roots beside them.
 */
export interface AgentPlatform {
  /** The agent directories this process's `AgentDirectories` service serves. */
  readonly agentDirectories: AgentDirectoriesPort;
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
}
