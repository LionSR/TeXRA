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

// Third-party imports
import { Record } from 'effect';

// Local imports
import type { RunView } from '@texra-ai/worldline/schemas';
import {
  formatResultCount,
  joinFacts,
  NESTED_NOUNS,
  runNoun,
} from '@texra-ai/worldline/schemas';
import { sectionCountLabel } from '@ui/copy/runStatus';

/** The agents a task started. */
export const NESTED_AGENT = Object.freeze({
  /** The CLI status bar's narrow suffix for agents still working: "2 live". */
  compactLiveSuffix: 'live',
  /** Expand-toggle aria when the tree is open. */
  collapseAction: 'Collapse agents',
} as const);

type NestedKinds = RunView['rollup']['kinds'];

/** The CLI status bar's narrow count suffix for each kind: "3 agt". */
const COMPACT_COUNT_SUFFIX = {
  agent: 'agt',
  process: 'cmd',
  script: 'scr',
} as const satisfies Record<keyof NestedKinds, string>;

/** What a task started, each kind counted by its own noun and none called
 *  an agent that is not one: "2 agents, 1 command". */
export const nestedCountsLabel = (kinds: NestedKinds): string =>
  Record.toEntries(NESTED_NOUNS)
    .flatMap(([kind, noun]) =>
      kinds[kind] > 0 ? [formatResultCount(kinds[kind], noun)] : [],
    )
    .join(', ');

/** The same counts for the CLI status bar's narrow form: "2 agt 1 cmd". */
export const nestedCountsCompact = (kinds: NestedKinds): string =>
  Record.toEntries(COMPACT_COUNT_SUFFIX)
    .flatMap(([kind, suffix]) =>
      kinds[kind] > 0 ? [`${kinds[kind]} ${suffix}`] : [],
    )
    .join(' ');

/** A collapsed parent's descendants in words: "2 agents, 1 command ·
 *  1 running". */
export function nestedRollupLabel(rollup: RunView['rollup']): string {
  return joinFacts([
    nestedCountsLabel(rollup.kinds),
    rollup.running > 0 && sectionCountLabel('running', String(rollup.running)),
  ]);
}

/** The dispatch card's heading over the counts of what it lists ("3 agents,
 *  4 commands"); how many of them still run is its badge. */
export const dispatchSummary = (counts: string): string =>
  `${counts} in the background`;

/**
 * CLI agent-list navigation. The list shows the task and the agents it
 * started.
 */
export const AGENT_LIST = Object.freeze({
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
} as const);

/** The task-level actions every host names the same way. */
export const TASK_ACTIONS = Object.freeze({
  /** The header and row menus' destructive item, named for what it
   *  deletes: "Delete task", "Delete agent". */
  delete: (run: Pick<RunView, 'parentId' | 'identity'>) =>
    `Delete ${runNoun(run)}`,
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
  /** The same for a source the view may no longer hold. */
  forkedFromRun: (source: Pick<RunView, 'title'> | undefined) =>
    `Forked from ${source ? source.title : 'a deleted task'}`,
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
} as const);

/** A task list with nothing in it, in every host: its heading, and what
 *  fills it. A host that starts tasks by command adds that command. */
const EMPTY_TASK_TITLE = 'No tasks yet';
const EMPTY_TASK_BODY = 'Tasks you start appear here.';
export const EMPTY_TASK_LIST = Object.freeze({
  title: EMPTY_TASK_TITLE,
  body: EMPTY_TASK_BODY,
  /** Both, as one line where there is no heading. */
  line: `${EMPTY_TASK_TITLE}. ${EMPTY_TASK_BODY}`,
});

/** An agent row's one action: open its agent's conversation, the composer
 *  addressed to it, to steer it while it runs or keep talking after. */
export const TALK_TO_AGENT = 'Talk to this agent';
