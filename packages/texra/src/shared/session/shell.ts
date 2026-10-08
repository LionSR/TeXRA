/**
 * The Shell (PRD one-fold-three-renderers, section 9): one record per view
 * instance, above the per-session `Surface`. It is what lets a rail row
 * choose a project: a `Surface` is per session and cannot say which session,
 * a `SessionView` is a fact about one session, and the layer map is a
 * cache, not a selection. On the extension and the TUI it is degenerate,
 * one root and `open` of length one. Search has one home, the command
 * palette, so the record carries no needle of its own.
 */

export interface Shell {
  /** Which project the view is showing. */
  readonly active: string;
  /** Rail order, user-arranged. */
  readonly open: readonly string[];
  /** Rail rows the user folded shut. */
  readonly collapsed: readonly string[];
}
