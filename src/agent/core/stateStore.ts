/**
 * Platform-agnostic state store facade for the agent core.
 *
 * Thin wrapper over `platform().globalState` and `platform().workspaceState`.
 * Consumer code imports this module for convenience; the canonical
 * definition lives in `@platform/interfaces`.
 */
import { platform } from '@platform/platform';

export interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

/** Global state (cross-workspace). */
export function getGlobalState(): StateStore {
  return platform().globalState;
}

/** Workspace-scoped state. */
export function getWorkspaceState(): StateStore {
  return platform().workspaceState;
}
