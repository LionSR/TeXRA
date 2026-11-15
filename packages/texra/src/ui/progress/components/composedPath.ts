import { isActivationKey } from '@ui/wa/keyActivation';

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

/**
 * Keyboard activation for a delegated button-like element (a clickable span
 * the view's click delegation answers): on an Enter or Space nothing has
 * handled yet, whose composed path holds an element matching `selector`,
 * cancel the key's default and activate that element.
 */
export function delegateKeyActivation(
  event: KeyboardEvent,
  selector: string,
  activate: (element: HTMLElement) => void,
): void {
  if (!isActivationKey(event) || event.defaultPrevented) return;
  const element = getComposedPathElement(event, selector, HTMLElement);
  if (!element) return;
  event.preventDefault();
  activate(element);
}
