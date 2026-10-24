/**
 * Helpers for Web Awesome select and dropdown events.
 */

import type WaDropdownItem from '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import type WaSelect from '@awesome.me/webawesome/dist/components/select/select.js';
import type { WaSelectEvent } from '@awesome.me/webawesome/dist/events/events.js';

/**
 * Read the current value from a `wa-select` change event, defaulting to ''.
 * Reads from `currentTarget` (the wa-select host) instead of `target` — wa-
 * select can retarget events from internal elements, and
 * `HTMLSelectElement` is the wrong type for this Web Component anyway.
 */
export function readSelectValue(event: Event): string {
  const select = event.currentTarget as WaSelect | null;
  return typeof select?.value === 'string' ? select.value : '';
}

/** The chosen item's `value` from a `wa-dropdown`'s `wa-select` event; ''
 *  when the item is not a `wa-dropdown-item`. */
export function selectedItemValue(event: WaSelectEvent): string {
  const { item } = event.detail;
  return item.localName === 'wa-dropdown-item'
    ? (item as WaDropdownItem).value
    : '';
}

/**
 * Runs `then` once the dropdown that fired `event` has finished hiding.
 * Until then the dropdown still moves focus: to its trigger on select, and
 * to its first item when the pick cut its opening animation short. An action
 * that focuses something of its own (an inline rename input that commits on
 * blur) starts here, or those moves blur it shut.
 */
export function afterDropdownHides(event: Event, then: () => void): void {
  const dropdown = event.currentTarget;
  if (!(dropdown instanceof HTMLElement)) return then();
  const onHidden = (hidden: Event): void => {
    // A tooltip inside the dropdown bubbles its own `wa-after-hide`.
    if (hidden.target !== dropdown) return;
    dropdown.removeEventListener('wa-after-hide', onHidden);
    then();
  };
  dropdown.addEventListener('wa-after-hide', onHidden);
}
