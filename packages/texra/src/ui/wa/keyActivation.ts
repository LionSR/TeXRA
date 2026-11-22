/** Whether a keydown activates a button-like control: Enter or Space, the
 *  keys a native button answers. */
export function isActivationKey(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

/** Whether a keydown is an Enter that commits a field's value. The Enter an
 *  input method takes to finish composing a character is not one. A
 *  multi-line field also checks Shift, which it keeps for a newline. */
export function isCommitEnter(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && !event.isComposing;
}

/** Whether a keydown is Ctrl+Enter or Cmd+Enter, which sends the text a
 *  multi-line field holds without leaving it. */
export function isSendChord(event: KeyboardEvent): boolean {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey);
}

/** Where a key is typing, not a shortcut: native text controls, the Web
 *  Awesome fields and select (whose keys pick an option), and editable
 *  content. */
const TEXT_ENTRY =
  'input, textarea, select, wa-input, wa-textarea, wa-select, [contenteditable]:not([contenteditable="false"])';

/** A node-type check rather than `instanceof Element`: a test DOM, or another
 *  window's document, has its own `Element` constructor. */
function isElementNode(target: EventTarget | null): target is Element {
  return target !== null && 'nodeType' in target && target.nodeType === 1;
}

function isTextEntry(target: EventTarget | null): boolean {
  return isElementNode(target) && target.closest(TEXT_ENTRY) !== null;
}

/** Whether a text field holds focus, looking through open shadow roots. */
export function textEntryHasFocus(document: Document): boolean {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) {
    active = active.shadowRoot.activeElement;
  }
  return isTextEntry(active);
}

/** Whether a keydown is typing: it travels through a text field, or one holds
 *  focus. A view's single-key shortcuts leave such a key alone. */
export function isTypingKeystroke(
  event: KeyboardEvent,
  document: Document,
): boolean {
  return event.composedPath().some(isTextEntry) || textEntryHasFocus(document);
}
