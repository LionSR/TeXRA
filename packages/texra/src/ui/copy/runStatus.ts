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
} from '@texra-ai/worldline/schemas';
import type {
  CompactionActivityStatus,
  ToolRowModel,
  ToolRowStatus,
} from '@texra-ai/worldline/transcript';
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
  starting: Object.freeze({ word: 'Initializing', tone: 'running' }),
  resuming: Object.freeze({ word: 'Resuming', tone: 'running' }),
  running: Object.freeze({ word: 'Running', tone: 'running' }),
  waiting: Object.freeze({ word: 'Idle', tone: 'neutral' }),
  ready: Object.freeze({ word: 'Ready', tone: 'neutral' }),
  completed: Object.freeze({ word: 'Completed', tone: 'success' }),
  cancelled: Object.freeze({ word: 'Stopped', tone: 'neutral' }),
  failed: Object.freeze({ word: 'Error', tone: 'danger' }),
  interrupted: Object.freeze({ word: 'Interrupted', tone: 'warning' }),
  waitingOnUser: Object.freeze({ word: 'Waiting on you', tone: 'warning' }),
});

/** How each section reads, in the order the sections are painted: its
 *  label, and the tone of a count of its runs, the tone of the status that
 *  puts a run there. */
const RUN_SECTIONS: Readonly<Record<RunSection, StatusWord>> = Object.freeze({
  running: RUN_STATUS.running,
  waiting: RUN_STATUS.waitingOnUser,
  interrupted: RUN_STATUS.interrupted,
  recent: Object.freeze({ word: 'Recent', tone: 'neutral' }),
});

/** A count of runs in one section, as a rollup reads it: `2 waiting on you`. */
export function sectionCountLabel(section: RunSection, count: string): string {
  return `${count} ${RUN_SECTIONS[section].word.toLowerCase()}`;
}

/** The tone a count of a section's runs paints with. */
export function runSectionTone(section: RunSection): RunTone {
  return RUN_SECTIONS[section].tone;
}

/** Section order, in the table's own order. */
const RUN_SECTION_ORDER: readonly RunSection[] = Object.freeze(
  Object.keys(RUN_SECTIONS).filter((key): key is RunSection =>
    Object.hasOwn(RUN_SECTIONS, key),
  ),
);

/** One section of a grouped run list: its key, its label and its runs. */
interface RunListSection<R> {
  readonly section: RunSection;
  readonly label: string;
  readonly runs: readonly R[];
}

/** `runs` grouped by section in paint order, each section keeping the
 *  order it was given; an empty section is left out. The one grouping the
 *  webview tab strip and the TUI's run tree both paint. */
export function runListSections<R extends RunStatusFacts>(
  runs: readonly R[],
): readonly RunListSection<R>[] {
  return RUN_SECTION_ORDER.flatMap((section) => {
    const members = runs.filter((run) => runSection(run) === section);
    return members.length === 0
      ? []
      : [{ section, label: RUN_SECTIONS[section].word, runs: members }];
  });
}

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

/** The tone of a file the run tried to read: loaded, or not. */
export function fileLoadTone(ok: boolean): RunTone {
  return ok ? 'success' : 'danger';
}

/** How a tool call's status reads: in a card's status section, and as the
 *  card's own state, where an open call of an interrupted run reads as its
 *  run does. */
export const TOOL_STATUS: Readonly<Record<ToolRowStatus, StatusWord>> =
  Object.freeze({
    in_progress: Object.freeze({ word: 'Running', tone: 'running' }),
    completed: Object.freeze({ word: 'Completed', tone: 'success' }),
    failed: Object.freeze({ word: 'Failed', tone: 'danger' }),
    interrupted: RUN_STATUS.interrupted,
  });

/** The label of what the user told the model when deciding a tool call. */
export const TOOL_USER_FEEDBACK_LABEL = 'Feedback:';

/** The look of a call the user answered with an instruction: their word,
 *  neither a success nor a failure of the tool. */
const TOOL_USER_FEEDBACK_LOOK: StatusLook = Object.freeze({
  tone: 'neutral',
  glyph: 'comment',
});

/**
 * How a tool card paints its state, in every host: the user's feedback
 * outranks the call's status (a rejection is their decision, not an error),
 * and a call whose status was never recorded has no look. A card reads as
 * an error exactly when this tone is `danger`.
 */
export function toolRowLook(
  model: Pick<ToolRowModel, 'status' | 'isUserFeedback'>,
): StatusLook | undefined {
  if (model.isUserFeedback) return TOOL_USER_FEEDBACK_LOOK;
  return model.status && TOOL_STATUS[model.status];
}

/** How an auto-approval grant on a run paints, in every host: a caution
 *  while it is on, whichever kind of work it approves. */
export const RUN_GRANT_TONE = 'warning' satisfies RunTone;

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

/** How a status key is painted, for a row that reads as that status
 *  without being a run in it (a call or a parent a request waits under). */
export function runStatusLook(key: RunStatusKey): StatusLook {
  return RUN_STATUS[key];
}

/** A run's news as a notification says it, in the status's word:
 *  `Draft review: Waiting on you.` Every host that announces a run reads
 *  it, whatever event it announces on. */
export function runAttentionLine(
  run: Pick<RunView, 'title'>,
  key: RunStatusKey,
): string {
  return `${run.title}: ${RUN_STATUS[key].word}.`;
}

/** How a stage reads: the outcome it closed with, or, while it is open, as
 *  its run reads: interrupted when nobody drives the run any more (its
 *  process died before the run's end closed the stage), else running. A
 *  transcript shown without its run (null) reads an open stage as running. */
export function stageStatus(
  stage: Pick<Stage, 'end'>,
  run: Pick<RunView, 'holder' | 'outcome' | 'position'> | null,
): Pick<RunStatus, 'word' | 'tone' | 'glyph'> & {
  readonly key: RunOutcome | 'running' | 'interrupted';
} {
  const key =
    stage.end?.outcome ??
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
  run: Pick<RunView, 'statusNotice' | 'holder' | 'outcome' | 'position'>,
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
