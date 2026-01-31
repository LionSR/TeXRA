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
  const path = event.composedPath?.() ?? [];
  const radio = path.find(
    (entry) =>
      entry instanceof HTMLElement &&
      entry.tagName.toLowerCase() === 'vscode-radio',
  ) as HTMLElement | undefined;
  const radioGroup = event.currentTarget as VSCodeValueElement | null;
  const value = radio?.getAttribute('value') || radioGroup?.value;
  return (value as T) || null;
}
