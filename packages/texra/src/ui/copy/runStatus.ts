/**
 * How a run's place reads in every renderer: its word, tone and glyph, the
 * section a run list groups it into, and its loop position. English copy
 * over the view's facts (`position`, `outcome`, `holder`, `approval`,
 * `turn`), so the dock, the TUI and the trace viewer cannot word one thing
 * two ways.
 */
import {
  isInterrupted,
  isPlainAgentIdentity,
  type RunStanding,
  type RunView,
  type ToolCallStatus,
} from '@texra-ai/harness/schemas';
import type { IconName } from '@ui/wa/iconNames';

/** Compact position label: `t2` for a run's second turn. */
export function formatLoopPositionLabel(
  turn: number | null | undefined,
): string | undefined {
  return turn == null ? undefined : `t${turn}`;
}

/** How a tool card's status section reads. */
export const TOOL_STATUS_WORD: Readonly<Record<ToolCallStatus, string>> =
  Object.freeze({
    in_progress: 'Running',
    completed: 'Completed',
    failed: 'Failed',
  });

/** The section a run list puts a run in. */
export type RunSection = 'running' | 'waiting' | 'interrupted' | 'recent';

/**
 * One label per section, in the order the sections are painted. Both
 * surfaces that group a run list (the webview tab strip and the TUI's run
 * tree) read this table rather than spelling the four labels again.
 *
 * Deep-frozen: the record crosses a module boundary into two renderers, and
 * `readonly` is compile-time only.
 */
export const RUN_SECTION_LABELS: Readonly<Record<RunSection, string>> =
  Object.freeze({
    running: 'Running',
    waiting: 'Waiting on you',
    interrupted: 'Interrupted',
    recent: 'Recent',
  });

/** Section order, in the table's own order. */
export const RUN_SECTION_ORDER: readonly RunSection[] = Object.freeze(
  Object.keys(RUN_SECTION_LABELS).filter((key): key is RunSection =>
    Object.hasOwn(RUN_SECTION_LABELS, key),
  ),
);

/** A fact-only word every host paints in its own colour vocabulary. */
export type RunTone = 'running' | 'success' | 'danger' | 'neutral' | 'warning';

/**
 * Each way a run's status reads, with its word and tone: the outcome it
 * ended on, where its loop stands, or one of two readings that outrank
 * both: `interrupted` (nobody drives a run that has not ended) and
 * `waitingOnUser` (a request of its own waits here). `starting` and
 * `resuming` are an agent's activation before its first loop step: a first
 * one, or one after a turn has ended. `packages/cli/scripts/validate-run.mjs`
 * pins the completed and stopped words against the real headless run.
 */
const RUN_STATUS = {
  starting: { word: 'Initializing', tone: 'running' },
  resuming: { word: 'Resuming', tone: 'running' },
  running: { word: 'Running', tone: 'running' },
  waiting: { word: 'Idle', tone: 'neutral' },
  ready: { word: 'Ready', tone: 'neutral' },
  completed: { word: 'Completed', tone: 'success' },
  cancelled: { word: 'Stopped', tone: 'neutral' },
  failed: { word: 'Error', tone: 'danger' },
  interrupted: { word: 'Interrupted', tone: 'warning' },
  waitingOnUser: { word: 'Waiting on you', tone: 'warning' },
} as const satisfies Record<
  string,
  { readonly word: string; readonly tone: RunTone }
>;

/** How a run's status reads: one key of the status table. */
export type RunStatusKey = keyof typeof RUN_STATUS;
/** Every key of the status table, for a wire schema that carries one. */
// cast: `Object.keys` widens to string[]; the table's own keys are these.
export const RUN_STATUS_KEYS = Object.keys(RUN_STATUS) as [
  RunStatusKey,
  ...RunStatusKey[],
];

/** Shape cue per tone, the one glyph table every painter reads. */
const TONE_GLYPH: Readonly<Record<RunTone, IconName>> = Object.freeze({
  running: 'circle',
  success: 'circle-check',
  danger: 'circle-exclamation',
  warning: 'triangle-exclamation',
  neutral: 'circle',
});

/** How one run reads, in every renderer. */
interface RunStatus {
  readonly key: RunStatusKey;
  readonly word: string;
  readonly tone: RunTone;
  readonly glyph: IconName;
  readonly section: RunSection;
}

/** The facts a run's status is read from: where it stands, and what
 *  outranks or refines that. */
type RunStatusFacts = RunStanding &
  Pick<RunView, 'holder' | 'approval' | 'turn' | 'identity' | 'forkPoint'>;

/**
 * The one reading of a run's status: an interrupted run outranks one
 * waiting on the user, which outranks its outcome and then its position.
 */
export function runStatus(run: RunStatusFacts): RunStatus {
  const key = statusKey(run);
  const { word, tone } = RUN_STATUS[key];
  return { key, word, tone, glyph: TONE_GLYPH[tone], section: sectionOf(run) };
}

function statusKey(run: RunStatusFacts): RunStatusKey {
  if (isInterrupted(run)) return 'interrupted';
  if (run.approval === 'own') return 'waitingOnUser';
  if (run.outcome !== null) return run.outcome;
  if (
    run.position === 'running' &&
    run.turn === null &&
    isPlainAgentIdentity(run.identity)
  )
    return run.forkPoint === null ? 'starting' : 'resuming';
  return run.position;
}

function sectionOf(run: RunStatusFacts): RunSection {
  if (isInterrupted(run)) return 'interrupted';
  if (run.approval === 'own') return 'waiting';
  return run.holder === 'here' && run.position !== 'ready'
    ? 'running'
    : 'recent';
}

/** The word a status key reads as: a task group's status is a key too. */
export function runStatusLabel(key: RunStatusKey): string {
  return RUN_STATUS[key].word;
}

/**
 * The banner a run reads as, in every host: its banner, tooltip and copied
 * diagnostics. Null when it has nothing to say. Rows this build cannot read
 * outrank an interrupted run, which outranks a result its end lost.
 */
export function runNoticeText(
  run: Pick<RunView, 'statusNotice' | 'holder' | 'outcome'>,
): string | null {
  const notice = run.statusNotice;
  switch (notice?.kind) {
    case 'damaged':
      return "Part of this task's saved history is damaged, so it cannot be opened or resumed.";
    case 'earlierBuild':
      return "This task was written by an earlier build of TeXRA; it can't be opened by this one.";
    default:
      if (isInterrupted(run))
        return 'The process running this task stopped before it finished. Resume it to continue.';
      return notice?.kind === 'lost' ? notice.message : null;
  }
}
