/**
 * The question asked before unsaved editor changes are thrown away, and its
 * two answers: the window's native dialog (closing the window or switching
 * project) and a tab's dialog in the renderer word it the same.
 */
export const DISCARD_CHANGES_COPY = Object.freeze({
  question: 'Discard unsaved changes?',
  keep: 'Keep editing',
  discard: 'Discard',
});
