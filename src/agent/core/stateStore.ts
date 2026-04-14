/**
 * State store facade — convenience wrapper over platform().globalState / workspaceState.
 */
import { platform } from '@platform/platform';

export function getGlobalState() {
  return platform().globalState;
}

export function getWorkspaceState() {
  return platform().workspaceState;
}
