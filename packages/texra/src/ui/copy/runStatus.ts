/**
 * How a run's place reads in every renderer: its loop position, and the
 * sections a run list is grouped into. English copy over the view's facts
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
 * One section per `group` case, and the order the sections are painted in.
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

type RunNotice = NonNullable<RunView['statusNotice']>;

/** What a resume found blocking a run: it can continue once that is back
 *  (by itself under `resumeOnOpen: auto`, else when resumed). */
function resumeBlockedText({
  reason,
}: Extract<RunNotice, { kind: 'resumeBlocked' }>): string {
  switch (reason.kind) {
    case 'agentMissing':
      return `This task's agent, ${reason.name}, is no longer installed. It can continue once the agent is back.`;
    case 'pluginOff':
      return `This task's agent comes from the ${reason.name} plugin, which is off. It can continue once the plugin is on.`;
    case 'pluginUntrusted':
      return `This task's agent comes from the ${reason.name} plugin, which is not trusted as it is now. It can continue once you trust it.`;
  }
}

/**
 * The banner a run's notice (`RunView.statusNotice`) reads as, in every
 * host: its banner, tooltip and copied diagnostics. Null when the view
 * gave it none.
 */
export function runNoticeText(notice: RunNotice | null): string | null {
  switch (notice?.kind) {
    case undefined:
      return null;
    case 'damaged':
      return "Part of this task's saved history is damaged, so it cannot be opened or resumed.";
    case 'earlierBuild':
      return "This task was written by an earlier build of TeXRA; it can't be opened by this one.";
    case 'resumeBlocked':
      return resumeBlockedText(notice);
    case 'interrupted':
      return 'The process running this task stopped before it finished. Resume it to continue.';
    case 'held':
      return `Held by another TeXRA process (pid ${notice.pid}). Let it finish or close it; if it is gone, Delete removes the task.`;
    case 'lost':
      return notice.message;
  }
}
