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
const BACKGROUND_TASK_INLINE = 'background task';
const BACKGROUND_TASK_INLINE_PLURAL = 'background tasks';

export const BACKGROUND_TASK = {
  /** Standalone display name, e.g. a section heading. */
  label: 'Background task',
  /** Same name inside a sentence. */
  inline: BACKGROUND_TASK_INLINE,
  /** Plural inside a sentence. */
  inlinePlural: BACKGROUND_TASK_INLINE_PLURAL,
  /** Compact status-bar / aria count noun (singular; pair with a formatter). */
  countNoun: BACKGROUND_TASK_INLINE,
  /** Expand-toggle aria when the tree is open. */
  collapseAction: `Collapse ${BACKGROUND_TASK_INLINE_PLURAL}`,
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

/** Status-bar count for child sessions still in flight, e.g. `3 running
 *  sessions`. */
export const RUNNING_SESSION = {
  countNoun: 'running session',
  /** Compact status-bar chip suffix, e.g. `3 run`. */
  compactCountSuffix: 'run',
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
  /**
   * Input-bar placeholder while the list owns keys. Esc here only returns
   * typing to this view — it does not walk to the parent session.
   */
  choosing:
    'Session list. Enter opens a session. Esc stays here and returns to typing.',
  /** Status-bar Esc action while a nested session is focused: walk to its parent. */
  parentAction: 'parent',
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
  selectedNoLongerAccepting: `The selected ${BACKGROUND_TASK_INLINE} is no longer accepting follow-ups.`,
} as const;
