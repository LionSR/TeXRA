/**
 * How a run's place reads in every renderer: its word, tone and glyph, the
 * label of the section a run list groups it into, and its loop position.
 * English copy over the classification in `shared/session/runStatusKey.ts`,
 * so the dock, the TUI and the trace viewer cannot word one thing two ways.
 */
import {
  isInterrupted,
  type RunOutcome,
  type RunView,
  type Stage,
  type ToolCallStatus,
} from '@texra-ai/harness/schemas';
import type { CompactionActivityStatus } from '@texra-ai/harness/transcript';
import {
  runSection,
  runStatusKey,
  type RunSection,
  type RunStatusFacts,
  type RunStatusKey,
} from '@texra/shared/session/runStatusKey';
import type { IconName } from '@ui/wa/iconNames';

/** Compact position label: `t2` for a run's second turn. */
export function formatLoopPositionLabel(
  turn: number | null | undefined,
): string | undefined {
  return turn == null ? undefined : `t${turn}`;
}

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

/** A status's word and tone. */
interface StatusWord {
  readonly word: string;
  readonly tone: RunTone;
}

/**
 * The word and tone of each status key (`runStatusKey`).
 * `packages/cli/scripts/validate-run.mjs` pins the completed and stopped
 * words against the real headless run.
 */
const RUN_STATUS: Readonly<Record<RunStatusKey, StatusWord>> = Object.freeze({
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
});

/** Shape cue per tone, the one glyph table every web painter reads. */
const TONE_GLYPH: Readonly<Record<RunTone, IconName>> = Object.freeze({
  running: 'circle',
  success: 'circle-check',
  danger: 'circle-exclamation',
  warning: 'triangle-exclamation',
  neutral: 'circle',
});

/** How a status of any kind is painted: its tone, and a glyph of its own
 *  only where the tone's glyph would say the wrong thing. */
export interface StatusLook {
  readonly tone: RunTone;
  readonly glyph?: IconName;
}

/** The web glyph a status shows: its own, else its tone's. */
export function statusGlyph(look: StatusLook): IconName {
  return look.glyph ?? TONE_GLYPH[look.tone];
}

/** How a tool card's status section reads. */
export const TOOL_STATUS: Readonly<Record<ToolCallStatus, StatusWord>> =
  Object.freeze({
    in_progress: Object.freeze({ word: 'Running', tone: 'running' }),
    completed: Object.freeze({ word: 'Completed', tone: 'success' }),
    failed: Object.freeze({ word: 'Failed', tone: 'danger' }),
  });

/** The tone of a context compaction's activity row; its words are the
 *  row's label (`COMPACTION_ACTIVITY_LABEL`). */
export const COMPACTION_ACTIVITY_TONE: Readonly<
  Record<CompactionActivityStatus, RunTone>
> = Object.freeze({
  running: 'running',
  completed: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  skipped: 'neutral',
  interrupted: 'warning',
});

/** How one run reads, in every renderer. */
interface RunStatus {
  readonly key: RunStatusKey;
  readonly word: string;
  readonly tone: RunTone;
  readonly glyph: IconName;
  readonly section: RunSection;
}

/** How one run reads in every renderer: its status key and section
 *  (`shared/session/runStatusKey.ts`), worded. */
export function runStatus(run: RunStatusFacts): RunStatus {
  const key = runStatusKey(run);
  const { word, tone } = RUN_STATUS[key];
  return { key, word, tone, glyph: TONE_GLYPH[tone], section: runSection(run) };
}

/** The word a status key reads as. */
export function runStatusLabel(key: RunStatusKey): string {
  return RUN_STATUS[key].word;
}

/** How a stage reads: the outcome it closed with, or, while it is open, as
 *  its run reads: interrupted when nobody drives the run any more (its
 *  process died before the run's end closed the stage), else running. A
 *  transcript shown without its run (null) reads an open stage as running. */
export function stageStatus(
  stage: Pick<Stage, 'outcome'>,
  run: Pick<RunView, 'holder' | 'outcome'> | null,
): Pick<RunStatus, 'word' | 'tone' | 'glyph'> & {
  readonly key: RunOutcome | 'running' | 'interrupted';
} {
  const key =
    stage.outcome ??
    (run !== null && isInterrupted(run) ? 'interrupted' : 'running');
  const { word, tone } = RUN_STATUS[key];
  return { key, word, tone, glyph: TONE_GLYPH[tone] };
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
