/**
 * Canonical user-facing vocabulary for a task and the work nested under it.
 *
 * | Concept | Term | Never say |
 * | --- | --- | --- |
 * | What the user started | task | run, session |
 * | An agent a task started | agent | subagent, child run |
 * | A background command or script a task started | command, script | agent, background task |
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

// Local imports
import type { RunIdentity, RunView } from '@texra-ai/harness/schemas';
import { formatResultCount } from '@texra-ai/harness/schemas';

/** What a task started, by the kind of its run: the noun a count of them
 *  takes, in the order a summary lists them. */
export const NESTED_NOUNS = Object.freeze({
  agent: 'agent',
  process: 'command',
  script: 'script',
} as const satisfies Record<RunIdentity['kind'], string>);

/** The agents a task started. */
export const NESTED_AGENT = {
  /** Count noun (singular; pair with a formatter): "3 agents". */
  countNoun: 'agent',
  /** The CLI status bar's narrow count suffix: "3 agt". */
  compactCountSuffix: 'agt',
  /** The CLI status bar's narrow suffix for agents still working: "2 live". */
  compactLiveSuffix: 'live',
  /** Expand-toggle aria when the tree is open. */
  collapseAction: 'Collapse agents',
} as const;

/** A collapsed parent's descendants in words: "2 agents · 1 running". */
export function nestedRollupLabel(rollup: RunView['rollup']): string {
  const agents = formatResultCount(rollup.total, NESTED_AGENT.countNoun);
  return rollup.running > 0 ? `${agents} · ${rollup.running} running` : agents;
}

/** The dispatch card's heading over the counts of what it lists ("3 agents,
 *  4 commands"); how many of them still run is its badge. */
export const dispatchSummary = (counts: string): string =>
  `${counts} in the background`;

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
  /** A forked task's header line and its empty transcript's first line. */
  forkedFrom: (title: string) => `Forked from ${title}`,
  /** The source's header menu item for each of its forks. */
  openFork: (title: string) => `Open fork: ${title}`,
  /** The header and run-row menus' title item (the TUI's `/rename`). */
  rename: 'Rename…',
  /** The header menu's folder item. */
  openFolder: 'Open task folder',
  /** The header's breadcrumb of the tasks above an agent. */
  ancestors: 'Started by',
  /** The CLI's exit line before the `texra resume …` command. */
  resumeHint: 'Resume this task with:',
} as const;

/** An agent row's one action: open its agent's conversation, the composer
 *  addressed to it, to steer it while it runs or keep talking after. */
export const TALK_TO_AGENT = 'Talk to this agent';
