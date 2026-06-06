/**
 * Bootstrap-tolerant workspace-state accessor.
 *
 * For initialized code paths, reach state directly via `platform().globalState`
 * / `platform().workspaceState` (the documented `@platform` accessor). This
 * module exists only for the pre-initialization escape hatch below.
 */
import { tryPlatform } from '@platform/platform';

/**
 * Workspace-state accessor that tolerates pre-initialization.
 *
 * Returns `null` if `initPlatform()` hasn't run yet — useful in module-level
 * constants or class constructors that may be evaluated by the require graph
 * before `activate()` finishes wiring the platform. Callers must apply their
 * own default when null is returned. For runtime code paths that fire only
 * after activation, use `platform().workspaceState` instead.
 */
export function tryGetWorkspaceState() {
  return tryPlatform()?.workspaceState ?? null;
}
