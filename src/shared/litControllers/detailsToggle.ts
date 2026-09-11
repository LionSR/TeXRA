/**
 * Whether a `wa-show`/`wa-hide` event on a `<wa-details>` originated from this
 * element itself rather than bubbling up from a nested `<wa-details>` — unlike
 * the native `<details>` `toggle` event, these bubble.
 */
export function isOwnDetailsToggle(event: Event): boolean {
  return event.target === event.currentTarget;
}
