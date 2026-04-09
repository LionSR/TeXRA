/**
 * State store facade — convenience wrapper over platform().globalState / workspaceState.
 */
import { platform } from '@platform/platform';
import type { StateStore } from '@platform/interfaces/state';

export type { StateStore };

export function getGlobalState(): StateStore {
  return platform().globalState;
}

export function getWorkspaceState(): StateStore {
  return platform().workspaceState;
}
