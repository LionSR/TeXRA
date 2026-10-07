/**
 * Canonical user-facing vocabulary for a task and the work nested under it
 * (GUI design 2026-10-02, ruling GQ4: "task" and "agent" are the only nouns).
 *
 * | Concept | Term | Never say |
 * | --- | --- | --- |
 * | What the user started | task | run, session |
 * | Anything a task started (an agent, a background script or command) | agent | subagent, background task, child run |
 * | The internal run-tree relationship | child run — code only | in any UI string |
 *
 * The CLI's Tab list of those rows is the **agent list**: Tab opens it,
 * Enter focuses an agent, Esc returns to the prompt.
 *
 * Hosts import these strings instead of paraphrasing run-tree or agent list
 * vocabulary. Wire identifiers (`childRunId`, `parentRun`, …) stay
 * internal and never reach the screen; a raw run id appears only in
 * "Copy diagnostics" output, which is for bug reports.
 */

/** Anything a task started. */
export const NESTED_AGENT = {
  /** Count noun (singular; pair with a formatter): "3 agents". */
  countNoun: 'agent',
  /** The CLI status bar's narrow count suffix: "3 agt". */
  compactCountSuffix: 'agt',
  /** The CLI status bar's narrow suffix for agents still working: "2 live". */
  compactLiveSuffix: 'live',
  /** Expand-toggle aria when the tree is open. */
  collapseAction: 'Collapse agents',
  /** The dispatch card's heading while any of them is still working. */
  workingSummary: (count: string) => `${count} working in the background`,
  /** The same heading once all of them have settled. */
  settledSummary: (count: string) => `${count} in the background`,
} as const;

/**
 * CLI agent-list navigation. The list shows the task and the agents it
 * started.
 */
export const AGENT_LIST = {
  /** Status-bar Tab action: `Tab agents`. */
  openAction: 'agents',
  /** Help / prose for the same Tab binding. */
  openHelp: 'lists the agents of this task',
  /**
   * Input-bar placeholder while the list owns keys. Esc here only returns
   * typing to this view — it does not walk to the parent.
   */
  choosing:
    'Agent list. Enter opens an agent. Esc stays here and returns to typing.',
  /** Status-bar Esc action while a nested agent is focused: walk to its parent. */
  parentAction: 'parent',
} as const;

/** Follow-up rejection copy when the focused agent has already finished. */
export const FOCUSED_AGENT = {
  selectedNoLongerAccepting:
    'The selected agent has finished and no longer takes messages.',
} as const;

/** The task-level actions every host names the same way. */
export const TASK_ACTIONS = {
  /** The header menu's destructive item and the desktop rail's ×. */
  delete: 'Delete task',
  /** The same on an agent's row or header. */
  deleteAgent: 'Delete agent',
  /** The header menu's clipboard item: the task's facts for a bug report. */
  copyDiagnostics: 'Copy diagnostics',
  /** A new task holding this conversation: the ended line and the header
   *  menu (the TUI's `/fork`). */
  fork: 'Fork',
  /** The same, cut before one of the user's messages, which returns to the
   *  new task's composer. */
  forkFromHere: 'Fork from here',
  /** The header menu's fresh-context item (the TUI's `/handoff`). */
  handOff: 'Hand off…',
  /** A forked task's header line and its empty transcript's first line. */
  forkedFrom: (title: string) => `Forked from ${title}`,
  /** The source's header menu item for each of its forks. */
  openFork: (title: string) => `Open fork: ${title}`,
  /** The header menu's title item (the TUI's `/rename`). */
  rename: 'Rename…',
  /** The header menu's folder item. */
  openFolder: 'Open task folder',
  /** The header's breadcrumb of the tasks above an agent. */
  ancestors: 'Started by',
  /** The CLI's exit line before the `texra resume …` command. */
  resumeHint: 'Resume this task with:',
} as const;
