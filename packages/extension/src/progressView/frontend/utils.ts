// Shared utility functions for the progress view frontend.

/**
 * Type for radio-group-like components that expose a value property.
 * Used for wa-radio-group / vscode-radio-group.
 */
type VSCodeValueElement = HTMLElement & { value?: string };

/**
 * Extract value from a radio-group change event. Prefers the clicked
 * radio element's value, falls back to group value. Works for both
 * `wa-radio` (Web Awesome) and the legacy `vscode-radio` elements.
 */
export function getRadioValue<T extends string>(event: Event): T | null {
  const radio =
    getComposedPathElement(event, 'wa-radio') ||
    getComposedPathElement(event, 'vscode-radio');
  const radioGroup = event.currentTarget as VSCodeValueElement | null;
  const value = radio?.getAttribute('value') || radioGroup?.value;
  return (value as T) || null;
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
