// Shared utility functions for the progress view frontend.

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
