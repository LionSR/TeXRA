import type { AgentDirectoriesPort, ToolMissingHandler } from './interfaces';
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
  /** Surfaces a tool-missing error to the embedder, served as
   *  `ToolMissingReporter`; absent, a missing-tool probe answers without
   *  surfacing. */
  readonly toolMissingHandler?: ToolMissingHandler;
  /** The app's directories on every command's PATH (`CommandDirs`). */
  readonly commandDirs?: () => readonly string[];
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
}
