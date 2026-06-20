/**
 * Shared helper for tools that persist an enum-valued setting in workspace
 * state. The schemas own parse/default semantics; tool runtimes only adapt
 * those parsers to the active workspace state.
 */

import { platform } from '@platform/platform';

/**
 * Build a workspace-state accessor for an enum setting: reads the persisted
 * string under `key` (defaulting to `fallback`) and runs it through `parse`.
 */
export function createEnumStateGetter<T extends string>(
  key: string,
  fallback: T,
  parse: (raw: string) => T,
): () => T {
  return (): T => {
    const raw = platform().workspaceState.get<string>(key, fallback);
    return parse(raw);
  };
}
