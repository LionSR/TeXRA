/**
 * How the conversation groups a run's transcript for reading: a finished
 * turn's intermediate work stands behind one "Worked for …" line, leaving
 * the message, the edits it made and its answer, and consecutive tool calls
 * read as one sentence. Both are computed from the rows; which groups are open is the
 * surface's.
 */
import {
  isEditLikeToolName,
  toolDisplayKind,
  normalizeToolName,
  type TimelineEntry,
  type TranscriptRow,
} from '@texra-ai/worldline/transcript';
import type { ToolRunClause, ToolRunCounts } from '@ui/copy/toolRun';

type Entry = TimelineEntry<TranscriptRow>;
type RowOf<K extends TranscriptRow['kind']> = TranscriptRow & { kind: K };
/** A row a tool run holds: a call, a web search, or a thought between. */
type RunRow = RowOf<'tool' | 'webSearch' | 'thinking'>;

/** Two or more consecutive finished calls, read as one sentence. */
export interface ToolRunItem {
  readonly kind: 'toolRun';
  /** The disclosure's key: its first row's id, which no later row changes. */
  readonly id: string;
  readonly rows: readonly RunRow[];
  readonly counts: ToolRunCounts;
  readonly failed: number;
}

/** A finished turn's work between its message and its answer. */
export interface WorkItem {
  readonly kind: 'work';
  /** The disclosure's key: the id of the message that opened the turn. */
  readonly id: string;
  readonly items: readonly (Entry | ToolRunItem)[];
  readonly durationMs: number;
}

export type LayoutItem = Entry | ToolRunItem | WorkItem;

/** What a call counts as in a run's sentence. */
function clauseOf(row: RowOf<'tool' | 'webSearch'>): ToolRunClause {
  if (row.kind === 'webSearch') return 'web';
  const name = normalizeToolName(row.log.toolName);
  if (name === 'grep' || name === 'glob') return 'search';
  if (name === 'agent') return 'agent';
  return toolDisplayKind(name) ?? 'other';
}

/** An edit to a file, by the rule that draws its diff: the change itself
 *  is what a person reads, so no group stands in front of it. */
const isEdit = (row: TranscriptRow): boolean =>
  row.kind === 'tool' && isEditLikeToolName(row.log.toolName);

/** A call still open keeps its own line, with its timer and live output,
 *  and an edit keeps its diff in view. */
const joinsRun = (entry: Entry): entry is { kind: 'row'; row: RunRow } =>
  entry.kind === 'row' &&
  !isEdit(entry.row) &&
  (entry.row.kind === 'webSearch' ||
    (entry.row.kind === 'thinking' && !entry.row.streaming) ||
    (entry.row.kind === 'tool' &&
      entry.row.model.status !== 'in_progress' &&
      entry.row.model.userInstruction === undefined));

/** Collapse each stretch of two or more calls into one run. */
function groupToolRuns(entries: readonly Entry[]): (Entry | ToolRunItem)[] {
  const items: (Entry | ToolRunItem)[] = [];
  let stretch: { kind: 'row'; row: RunRow }[] = [];
  const close = () => {
    const calls = stretch.flatMap(({ row }) =>
      row.kind === 'thinking' ? [] : [row],
    );
    if (calls.length < 2) items.push(...stretch);
    else {
      // A map keeps its keys in first-use order, the sentence's order.
      const counts = new Map<ToolRunClause, number>();
      for (const call of calls) {
        const clause = clauseOf(call);
        counts.set(clause, (counts.get(clause) ?? 0) + 1);
      }
      items.push({
        kind: 'toolRun',
        id: stretch[0].row.id,
        rows: stretch.map(({ row }) => row),
        counts: [...counts],
        failed: calls.filter(
          (call) => call.kind === 'tool' && call.model.status === 'failed',
        ).length,
      });
    }
    stretch = [];
  };
  for (const entry of entries) {
    if (joinsRun(entry)) stretch.push(entry);
    else {
      close();
      items.push(entry);
    }
  }
  close();
  return items;
}

const startOf = (entry: Entry): number =>
  entry.kind === 'row' ? entry.row.timestamp : entry.stage.startTime;
const endOf = (entry: Entry): number =>
  entry.kind === 'row'
    ? entry.row.timestamp
    : (entry.stage.end?.at ?? entry.stage.startTime);

const isMessage = (
  entry: Entry,
): entry is { kind: 'row'; row: RowOf<'user'> } =>
  entry.kind === 'row' && entry.row.kind === 'user';
/** What a turn ends on and keeps in view: its answer, or what stopped it. */
const isOutcome = (entry: Entry): boolean =>
  entry.kind === 'row' &&
  ((entry.row.kind === 'assistant' && !entry.row.streaming) ||
    entry.row.kind === 'error');

/**
 * The transcript as the conversation shows it. `running` is whether the run
 * is working now: its last turn then stays open, since its work is what
 * there is to read.
 */
export function turnLayout(
  timeline: readonly Entry[],
  running: boolean,
): LayoutItem[] {
  const layout: LayoutItem[] = [];
  let index = 0;
  // What precedes the first message has no turn to stand behind.
  const firstMessage = timeline.findIndex(isMessage);
  const lead = firstMessage === -1 ? timeline.length : firstMessage;
  layout.push(...groupToolRuns(timeline.slice(0, lead)));
  index = lead;
  while (index < timeline.length) {
    const message = timeline[index];
    let end = index + 1;
    while (end < timeline.length && !isMessage(timeline[end])) end += 1;
    const body = timeline.slice(index + 1, end);
    // The turn's outcome is its last answer (or error) and what runs with
    // it, and any rows after it (a Stop hook's warning): those stay in view
    // with the answer rather than folding it away.
    const lastOutcome = body.findLastIndex(isOutcome);
    let outcomeAt = lastOutcome === -1 ? body.length : lastOutcome;
    while (outcomeAt > 0 && isOutcome(body[outcomeAt - 1])) outcomeAt -= 1;
    const work = body.slice(0, outcomeAt);
    const outcome = body.slice(outcomeAt);
    const last = end === timeline.length;
    // The last turn folds once it has answered and the run has stopped
    // working; a turn cut short stays open to show where.
    const folds =
      work.length > 0 && (last ? !running && outcome.length > 0 : true);
    layout.push(message);
    // A folded turn still shows what it changed: its edits stand after the
    // fold, each with its diff.
    const edits = folds
      ? work.filter((entry) => entry.kind === 'row' && isEdit(entry.row))
      : [];
    const behind = work.filter((entry) => !edits.includes(entry));
    if (folds && isMessage(message) && behind.length > 0) {
      const closing = outcome.at(0) ?? work.at(-1);
      const finishedAt =
        closing === undefined
          ? message.row.timestamp
          : outcome.length > 0
            ? startOf(closing)
            : endOf(closing);
      layout.push({
        kind: 'work',
        id: message.row.id,
        items: groupToolRuns(behind),
        durationMs: Math.max(0, finishedAt - message.row.timestamp),
      });
      layout.push(...edits);
    } else layout.push(...groupToolRuns(work));
    layout.push(...outcome);
    index = end;
  }
  return layout;
}
