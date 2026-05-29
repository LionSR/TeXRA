/**
 * Shared helpers for tools that persist an enum-valued setting in workspace
 * state. Both the Codex and Claude Code tools follow the same pattern:
 *
 *   1. A `parse(raw)` that maps an arbitrary string onto a known enum value,
 *      falling back to a default when the string isn't recognised.
 *   2. A `get()` that reads the persisted string from workspace state and runs
 *      it through `parse`.
 *
 * Centralising the pattern keeps the parse-with-default + read-from-state
 * semantics identical across both tools.
 */

import { getWorkspaceState } from '@agent/core/stateStore';

/**
 * Build a parser that maps an arbitrary string onto a member of `values`,
 * returning `fallback` for anything not in the set. An optional `aliases` map
 * redirects retired/renamed values onto a current member before the fallback.
 */
export function createEnumParser<T extends string>(
  values: readonly T[],
  fallback: T,
  aliases?: Readonly<Record<string, T>>,
): (raw: string) => T {
  const known = values as readonly string[];
  return (raw: string): T => {
    if (known.includes(raw)) return raw as T;
    return aliases?.[raw] ?? fallback;
  };
}

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
    const raw = getWorkspaceState().get<string>(key, fallback);
    return parse(raw);
  };
}
