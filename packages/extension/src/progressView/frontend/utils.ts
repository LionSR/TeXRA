// Shared utility functions for the progress view frontend.

import type { StreamTabInfo } from '@shared/schemas';

/**
 * The single accessor for a stream's user-facing display label.
 * `buildStreamTabInfo()` normally supplies the cleaned identity name, and may
 * deliberately use the stream's opaque id while identity is unresolved. The
 * schema still permits an empty string, for example from a custom identity
 * with no name after its source prefix, so a surface that requires non-empty
 * copy must provide its own available fallback. Returns undefined only when
 * there's no entry to read from at all (for example, a lookup by id came back
 * empty because that stream's tab was evicted); callers decide their own
 * placeholder or omit the label entirely.
 */
export function streamDisplayLabel(info: Pick<StreamTabInfo, 'label'>): string;
export function streamDisplayLabel(
  info: Pick<StreamTabInfo, 'label'> | undefined,
): string | undefined;
export function streamDisplayLabel(
  info: Pick<StreamTabInfo, 'label'> | undefined,
): string | undefined {
  return info?.label;
}

/**
 * Find the first matching element in a composed event path.
 */
export function getComposedPathElement<T extends Element>(
  event: Event,
  selector: string,
): T | null {
  const path = event.composedPath?.() ?? [];
  for (const entry of path) {
    if (entry instanceof Element && entry.matches(selector)) {
      return entry as T;
    }
  }
  return null;
}

/** Shallow equality check — avoids triggering Lit re-renders when the
 *  derived set is the same as the previous one. */
export function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) {
    if (!b.has(v)) return false;
  }
  return true;
}
