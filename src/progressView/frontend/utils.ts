// Shared utility functions for the progress view frontend.

/**
 * Type for VSCode web components that expose a value property.
 * Used for vscode-radio-group, vscode-single-select, etc.
 */
export type VSCodeValueElement = HTMLElement & { value?: string };

/**
 * Extract value from a VSCode radio group change event.
 * Works around vscode-radio-group not updating .value synchronously on change.
 * Prefers the clicked radio element's value, falls back to group value.
 */
export function getRadioValue<T extends string>(event: Event): T | null {
  const radio = findClosestInComposedPath(event, 'vscode-radio');
  const radioGroup = event.currentTarget as VSCodeValueElement | null;
  const value = radio?.getAttribute('value') || radioGroup?.value;
  return (value as T) || null;
}

/**
 * Find the closest element matching selector in the composed event path.
 * This works across shadow DOM boundaries (vscode-* components).
 */
export function findClosestInComposedPath<T extends Element>(
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
