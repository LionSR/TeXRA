// Shared utility functions for the progress view frontend.

import type { StreamTabInfo } from '@shared/schemas';

/**
 * The single accessor for a stream's user-facing display label. Every
 * `StreamTabInfo.label` is guaranteed non-empty by `buildStreamTabInfo()`
 * (`src/controllers/session/streamTabInfo.ts`) — this function exists so no
 * call site is tempted to add its own `?? info.name` / `?? streamId`
 * fallback on top of it. `.label` itself may still equal the stream's own
 * opaque id for a stream whose identity hasn't resolved yet — deliberately:
 * that id's prefix already is the clean agent name (`getStreamTabId()`,
 * `src/agent/runtime/streamTab.ts`), so it's the best available label, not a
 * fallback to avoid. Returns undefined only when there's no entry to read
 * from at all (e.g. a lookup by id came back empty because that stream's
 * tab was evicted) — callers decide their own placeholder or omit the label
 * entirely.
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
