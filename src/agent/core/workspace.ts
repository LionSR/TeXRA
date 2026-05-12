/**
 * Workspace facade — convenience wrapper over platform().workspace.
 */
import { platform } from '@platform/platform';

export function getWorkspaceProvider() {
  return platform().workspace;
}
