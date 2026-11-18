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
