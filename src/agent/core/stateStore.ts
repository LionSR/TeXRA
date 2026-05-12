/**
 * State store facade — convenience wrapper over platform().globalState / workspaceState.
 */
import { platform, tryPlatform } from '@platform/platform';

export function getGlobalState() {
  return platform().globalState;
}

export function getWorkspaceState() {
  return platform().workspaceState;
}

/**
 * Workspace-state accessor that tolerates pre-initialization.
 *
 * Returns `null` if `initPlatform()` hasn't run yet — useful in module-level
 * constants or class constructors that may be evaluated by the require graph
 * before `activate()` finishes wiring the platform. Callers must apply their
 * own default when null is returned. For runtime code paths that fire only
 * after activation, use `getWorkspaceState()` instead.
 */
export function tryGetWorkspaceState() {
  return tryPlatform()?.workspaceState ?? null;
}
