/**
 * How a run's place reads in every renderer: its loop position, and the
 * sections a run list is grouped into. English copy over the fold's facts
 * (`RunView.turn`, `RunView.group`), so the dock, the TUI and the trace
 * viewer cannot word one thing two ways.
 */
import type { RunStatusKey, RunView } from '@texra-ai/harness/schemas';

type RunGroup = RunView['group'];

/** Compact position label: `t2` for a run's second turn. */
export function formatLoopPositionLabel(
  turn: number | null | undefined,
): string | undefined {
  return turn == null ? undefined : `t${turn}`;
}

/**
 * One section per `group` arm, and the order the sections are painted in.
 * Both surfaces that group a run list — the webview tab strip and the
 * TUI's run tree — read this table rather than spelling the four labels
 * again, so a renamed section cannot say one thing in the dock and another
 * in the terminal.
 *
 * Deep-frozen: the record crosses a module boundary into two renderers, and
 * `readonly` is compile-time only.
 */
export const RUN_GROUP_LABELS: Readonly<Record<RunGroup, string>> =
  Object.freeze({
    running: 'Running',
    waiting: 'Waiting on you',
    interrupted: 'Interrupted',
    recent: 'Recent',
  });

/** Section order, in the group union's own order. */
export const RUN_GROUP_ORDER: readonly RunGroup[] = Object.freeze(
  Object.keys(RUN_GROUP_LABELS) as RunGroup[],
);

/**
 * The words for each way a run's status reads (`RunView.statusKey`), the
 * one table every renderer prints. A task group's status is a run phase,
 * which is a key too. `packages/cli/scripts/validate-run.mjs` pins the
 * completed and stopped words against the real headless run.
 */
const RUN_STATUS_LABEL = {
  starting: 'Initializing',
  running: 'Running',
  failed: 'Error',
  completed: 'Completed',
  cancelled: 'Stopped',
  ready: 'Ready',
  waiting: 'Idle',
  resuming: 'Resuming',
  paused: 'Paused',
  resultWaiting: 'Result waiting: parent is open elsewhere',
  interrupted: 'Interrupted',
  waitingOnUser: 'Waiting on you',
} as const satisfies Record<RunStatusKey, string>;

/** How a run's status reads, in words. */
export function runStatusLabel(key: RunStatusKey): string {
  return RUN_STATUS_LABEL[key];
}
