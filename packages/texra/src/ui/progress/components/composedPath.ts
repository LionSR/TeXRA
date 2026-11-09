/**
 * Find the first element of `type` matching `selector` in a composed event
 * path.
 */
export function getComposedPathElement<T extends Element>(
  event: Event,
  selector: string,
  type: abstract new (...args: never[]) => T,
): T | null {
  const path = event.composedPath?.() ?? [];
  for (const entry of path) {
    if (entry instanceof type && entry.matches(selector)) return entry;
  }
  return null;
}
