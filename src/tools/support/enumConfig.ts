/**
 * Shared helper for tools that persist an enum-valued setting in workspace
 * state. The schemas own parse/default semantics; tool runtimes only adapt
 * those parsers to the workspace state of the session the call works on.
 */

import { Effect } from 'effect';

import type { StateStore, StateReadFailed } from '@platform/interfaces';

/**
 * Build a workspace-state accessor for an enum setting: reads the persisted
 * string under `key` from the given store (defaulting to `fallback`) and runs
 * it through `parse`. The caller passes its session's `workspaceState`
 * (`ToolCall.roots.workspaceState`), so the read never depends on an ambient
 * session scope.
 */
export function createEnumStateGetter<T extends string>(
  key: string,
  fallback: T,
  parse: (raw: string) => T,
): (workspaceState: StateStore) => Effect.Effect<T, StateReadFailed> {
  return (workspaceState) =>
    workspaceState.get<string>(key, fallback).pipe(Effect.map(parse));
}
