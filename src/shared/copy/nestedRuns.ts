/**
 * Canonical user-facing vocabulary for nested work under a run (#9798).
 *
 * Three concepts, three names, everywhere:
 *
 * | Concept | Term | Never say |
 * | --- | --- | --- |
 * | Anything nested under a run (delegated agent, agent CLI, background command) | background task | child stream |
 * | A delegated TeXRA agent specifically | subagent | child |
 * | The internal stream-tree relationship | child stream — code only | in any UI string |
 *
 * The persistent CLI list of those rows is the **session list**: Tab opens it,
 * Enter focuses a session, Esc returns to the prompt. Do not call that list
 * "children" (stream-tree jargon) or "tasks" (collides with the todo pane).
 *
 * Status-bar count exception: the compact chip stays "N sub" / "N subagents"
 * because the rows are overwhelmingly delegated agents and "N bg" is less
 * legible in the footer. Full sentences and disabled-input copy still use
 * "background task" when the focused row might not be an agent.
 *
 * Hosts import these strings instead of paraphrasing stream-tree or roster
 * vocabulary. Wire identifiers (`childStreamId`, `parentStream`, …) stay
 * internal and never reach the screen.
 */

/** Anything nested under a run. */
export const BACKGROUND_TASK = {
  /** Standalone display name, e.g. a section heading. */
  label: 'Background task',
  /** Same name inside a sentence. */
  inline: 'background task',
  /** Plural inside a sentence. */
  inlinePlural: 'background tasks',
  /** Compact status-bar / aria count noun (singular; pair with a formatter). */
  countNoun: 'background task',
  /** Expand-toggle aria when the tree is open. */
  collapseAction: 'Collapse background tasks',
} as const;

/** A delegated TeXRA agent specifically — not a background command. */
export const SUBAGENT = {
  label: 'Subagent',
  inline: 'subagent',
  inlinePlural: 'subagents',
  /**
   * Status-bar count noun. Deliberately "subagent" rather than
   * {@link BACKGROUND_TASK.countNoun}: see the module docstring.
   */
  countNoun: 'subagent',
  /** Compact status-bar chip suffix, e.g. `3 sub`. */
  compactCountSuffix: 'sub',
} as const;

/**
 * CLI session-list navigation. The list shows background tasks (and the root);
 * the user-facing noun for "a row I can focus" is session.
 */
export const SESSION_LIST = {
  /** Status-bar Tab action: `Tab sessions`. */
  openAction: 'sessions',
  /** Help / prose for the same Tab binding. */
  openHelp: 'selects sessions',
  /** Input-bar placeholder while the list owns keys. */
  choosing: 'Choosing a session; press Esc to return to the prompt.',
  /** Recovery hint when the focused session no longer accepts follow-ups. */
  selectHint: 'press Tab to select a session',
} as const;

/**
 * Copy used when a modal/form/palette owns the keyboard and the status bar
 * should point the reader at that surface instead of inventing "foreground
 * panel" jargon.
 */
export const FOREGROUND_OWNERSHIP = {
  /** Status-bar lead-in while a modal/form owns keys. */
  keysGoAbove: 'Keys go to the panel above',
} as const;

/** Follow-up rejection copy when the focused nested run has already finished. */
export const FOCUSED_BACKGROUND_TASK = {
  noLongerAccepting: `This background task is no longer accepting follow-ups; ${SESSION_LIST.selectHint}.`,
  selectedNoLongerAccepting:
    'The selected background task is no longer accepting follow-ups.',
} as const;
