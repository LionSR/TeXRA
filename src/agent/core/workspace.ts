/**
 * Workspace facade — convenience wrapper over platform().workspace.
 */
import { platform } from '@platform/platform';
import type { WorkspaceProvider } from '@platform/interfaces/workspace';

export type { WorkspaceProvider };

export function getWorkspaceProvider(): WorkspaceProvider {
  return platform().workspace;
}
