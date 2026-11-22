/**
 * Whether a keystroke is ordinary typing: it travels through a text-entry
 * control, or one holds focus. Every renderer that binds a bare key (a
 * shortcut, a card's default action, moving focus) reads this one rule, so a
 * field one surface treats as typing is typing in all of them.
 */

/** Native fields, a select's typeahead, and editable content. */
const TEXT_ENTRY_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

/** An element of any window. A renderer may be handed another realm's
 *  document (tests install a separate DOM), so `instanceof Element` against
 *  this module's global would miss its elements; 1 is `Node.ELEMENT_NODE`. */
const isElement = (target: EventTarget | null): target is Element =>
  target != null && 'nodeType' in target && target.nodeType === 1;

/**
 * Whether `target` is a text-entry control or sits inside one: a native
 * field, editable content, or a custom field element whose tag names one
 * (`wa-input`, `wa-textarea`), whose inner field is behind its shadow root.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!isElement(target)) return false;
  if (target.closest(TEXT_ENTRY_SELECTOR) != null) return true;
  const tag = target.tagName.toLowerCase();
  return tag.includes('input') || tag.includes('textarea');
}

/** Whether the focused element, looking through open shadow roots at each
 *  level, is a text-entry control. */
export function focusIsOnTextEntry(document: Document): boolean {
  for (
    let active = document.activeElement;
    active != null;
    active = active.shadowRoot?.activeElement ?? null
  ) {
    if (isTextEntry(active)) return true;
  }
  return false;
}

/** Whether `event` is typing: it passed through a text-entry control on its
 *  way, or focus is on one. */
export function isTypingIn(document: Document, event: Event): boolean {
  return event.composedPath().some(isTextEntry) || focusIsOnTextEntry(document);
}
