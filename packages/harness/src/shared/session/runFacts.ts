/**
 * What a run answers and what it produced, read from the rows that record
 * them: its input (system text, instruction, activated skills, memory misses),
 * the files its calls read and edited and how many ran, its structured output,
 * and where its turn policy stands (the final-tool nudge, the finalized
 * answer). The row handlers in `runState.ts` and `turnRowHandlers.ts` set these
 * fields, so the loop reads them off the same state on the live path and on
 * resume. The consumed follow-up is here too, as its writers commit it (its
 * receipt is `followUpReceipt`, in `runRowReads.ts`); the rules for which
 * pending rows a run reads are the reader's (`agent/followUp/RunInput.ts`).
 * The lifecycle rows a run is registered, activated and ended with are
 * built here, beside the readers of their facts;
 * `agent/storage/runLifecycle.ts` commits them.
 */
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import {
  type DispatchFacts,
  emptyRunEndOutput,
  type FollowUpContent,
  type FollowUpDisposition,
  type JsonValue,
  qualifyAggregateId,
  type RunEnd,
  type RunEndOutput,
  type RunBinding,
  type RunId,
  type RunIdentity,
  type RunInput,
  type RunOutcome,
  type RunParent,
  type RunProvenance,
  type SessionEvent,
  type SessionEventDraft,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type ToolResultPayload,
  USER_FOLLOW_UP_SUPPORT,
  type UserFollowUpSupport,
} from '@shared/schemas';

import { byId } from './runRows';
import { runRowsFrom } from './runRowReads';
import type { TurnResult } from '@texra-ai/llm';
import type { RunHistoryDraft, RunInputDraft } from './runState';
import type { RunRows } from './runRowsShape';
import type { Invocation, PendingResponse } from './inFlight';

/** The text a completed model turn or assistant message contains, in order. */
export const turnText = (turn: Pick<TurnResult, 'content'>): string =>
  turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');

/** What a run answers and produced, as its rows record it. */
export type RunFacts = {
  /** The latest nonempty text from this turn's response rows. A new turn
   *  clears it; tool-only responses, nudges and context edits keep it. */
  readonly answer: string;
  /** The latest value of each field an `append` or a fork's edit recorded;
   *  an instruction absent is the launch's. */
  readonly input: Omit<RunInput, 'instruction'> & {
    readonly instruction?: string;
  };
  /** The workspace files the run's calls edited, first edit first. */
  readonly edited: readonly string[];
  /** The files the run's calls read (an edited file counts), first read first,
   *  as the results spell them: what editing an existing file requires. */
  readonly read: readonly string[];
  /** Results `executed` or `failed`: tool bodies and script host answers. */
  readonly toolCalls: number;
  /** The result value of a `submit_output` call, whether the response or
   *  one of its scripts issued it, or of a script run's handed-down call. */
  readonly structured: { readonly value: JsonValue } | null;
  /** The result a script run's handed-down call finished with: no model
   *  answers it, so its turn ends there, and an error fails it. */
  readonly handedDown: ToolResultPayload['result'] | null;
  /** The turn whose final-tool nudge was appended, so it is asked once. */
  readonly finalToolTurn: number | null;
  /** The final-tool nudge stands unanswered: the next response is forced. */
  readonly forceFinalTool: boolean;
  /** The latest response's answer was finalized for display. */
  readonly answerFinalized: boolean;
  /** Each call a response issued, and each call a script of it issued, by
   *  `responseId/callId`: its tool and card, and the response that issued
   *  it (a script's call: its script's) with that row's commit and seq. */
  readonly calls: Readonly<
    Record<
      string,
      Pick<DispatchFacts, 'toolName' | 'logId'> &
        Pick<SessionEvent, 'commit' | 'seq'> & { readonly responseId: string }
    >
  >;
};

/** A run's facts before any row. */
export const NO_FACTS: RunFacts = {
  answer: '',
  input: {},
  edited: [],
  read: [],
  toolCalls: 0,
  structured: null,
  handedDown: null,
  finalToolTurn: null,
  forceFinalTool: false,
  answerFinalized: false,
  calls: byId([]),
};

/** `input` with what a row recorded: each field it names replaces the
 *  last, and a `null` instruction returns to the launch's. */
export function withInput(
  input: RunFacts['input'],
  recorded: RunInput | null | undefined,
): RunFacts['input'] {
  if (recorded == null) return input;
  const { instruction: was, ...kept } = input;
  const { instruction, system, activated, memoryMisses } = recorded;
  const next = instruction === undefined ? was : (instruction ?? undefined);
  return {
    ...kept,
    ...(system !== undefined && { system }),
    ...(activated !== undefined && { activated }),
    ...(memoryMisses !== undefined && { memoryMisses }),
    ...(next !== undefined && { instruction: next }),
  };
}

/** The facts one `tool.result` of `pending` changes: the files it read and
 *  edited, whether it ran, and, as the run's output, its value or result. */
export function resultFacts(
  facts: RunFacts,
  p: ToolResultPayload,
  pending: PendingResponse,
): Partial<RunFacts> {
  const ran = p.disposition === 'executed' || p.disposition === 'failed';
  const executed = p.result.status === 'executed' ? p.result : null;
  const edits = (executed?.edits ?? []).map(({ path }) => path);
  const fresh = (paths: readonly string[], known: readonly string[]) =>
    [...new Set(paths)].filter((path) => path !== '' && !known.includes(path));
  const edited = fresh(edits, facts.edited);
  const read = fresh([...(executed?.reads ?? []), ...edits], facts.read);
  const output = outputOf(pending, p.callId);
  const value = executed?.value;
  return {
    edited: edited.length === 0 ? facts.edited : [...facts.edited, ...edited],
    read: read.length === 0 ? facts.read : [...facts.read, ...read],
    toolCalls: facts.toolCalls + (ran ? 1 : 0),
    structured:
      output !== null && value !== undefined ? { value } : facts.structured,
    ...(output === 'handed-down' && { handedDown: p.result }),
  };
}

/** What `callId` is to the run's output: a script run's handed-down call,
 *  the one call of a response no model produced; a `submit_output` call,
 *  the response's or one of its scripts' (a script's call names its tool on
 *  its `script.call`); or neither. */
function outputOf(
  pending: PendingResponse,
  callId: string,
): 'handed-down' | 'submitted' | null {
  const own = pending.calls.find((call) => call.callId === callId);
  if (own !== undefined && pending.assistant.origin === null)
    return 'handed-down';
  const tool = pending.records[callId]?.script?.toolName ?? own?.toolName;
  return tool === STRUCTURED_OUTPUT_TOOL_NAME ? 'submitted' : null;
}

/** Input that asks the run to do something: its user's and its parent's. A
 *  child's report, another run's message and a host notice only inform it. */
export const isInstruction = ({ from }: FollowUpContent): boolean =>
  from.kind === 'user' || (from.kind === 'run' && from.relation === 'parent');

/** The row that consumes one follow-up, committed beside the rows that took
 *  it; its writer states why (`disposition`). */
export const consumedRow = (
  runId: RunId,
  followUpId: string,
  disposition: FollowUpDisposition,
): Extract<RunInputDraft, { readonly type: 'followup.consumed' }> => ({
  type: 'followup.consumed',
  aggregateId: qualifyAggregateId('run', runId),
  followUpId,
  disposition,
});

/** Run `runId`'s record rows among `rows`, folded (`runRowsFrom`). */
export const recordsOf = (
  rows: readonly SessionEvent[],
  runId: RunId,
): RunRows => {
  const id = qualifyAggregateId('run', runId);
  return runRowsFrom(rows.filter((row) => row.aggregateId === id));
};

/** The row that bounds run `runId`'s current lifecycle in `rows`: its last
 *  `run.end` or `run.activate` (an activate after an end starts a new
 *  lifecycle, so a resumed run never carries the end of one it left). */
export function lastLifecycleRow(
  rows: readonly SessionEvent[],
  runId: RunId,
): Extract<SessionEvent, { type: 'run.end' | 'run.activate' }> | undefined {
  const { end, activation } = recordsOf(rows, runId);
  return end ?? activation ?? undefined;
}

/** The run's terminal fact for its current lifecycle, or null: the scope
 *  `finalizeRun`, the row's one writer, and every reader share. */
export function runEndFromEvents(
  rows: readonly SessionEvent[],
  runId: RunId,
): Extract<SessionEvent, { type: 'run.end' }> | null {
  return recordsOf(rows, runId).end;
}

/** `invocation` once a shutdown stopped its open attempt (a `run.stop` whose
 *  `reason` is `shutdown`): none, or one with a recorded outcome, is as it was. */
export function closedBy(invocation: Invocation | null): Invocation | null {
  if (invocation === null || invocation.current.failed !== null)
    return invocation;
  return { ...invocation, current: { ...invocation.current, closed: true } };
}

/** What a run is registered with: the facts its `run.start` carries. */
export interface RegisterRunOptions {
  /** The launching run: the whole parent edge, stamped on `run.start`. */
  readonly parentRunId?: RunId;
  /** The parent's call that launched it, which owns this run until it
   *  detaches, and that call's tool card. */
  readonly parentCall?: NonNullable<RunParent['call']>;
  /** The run's identity, declared by the launch site — the durable authority. */
  readonly identity: RunIdentity;
  /** Runtime behavior declared by the launch source, not UI visibility. */
  readonly userFollowUpSupport?: UserFollowUpSupport;
  /** The run's `run.description`, durable at birth: a child's
   *  task label; a root's summary comes later as a second row. */
  readonly description?: string;
  readonly provenance?: RunProvenance; // a fork's source and cut
  readonly grants?: ApprovalGrants; // the grants it starts with
  /** A fork's history, which its opening commits in place of a prompt
   *  (`forkSeed`): the run is born on it, not resumed onto it, bound as its
   *  source was at the cut (`binding`: what its `run.config` row records). */
  readonly seed?: {
    readonly rows: readonly RunHistoryDraft[];
    readonly binding: RunBinding | null;
  };
}

type RunConfigRow = Extract<SessionEventDraft, { readonly type: 'run.config' }>;

/** The rows that register a run, and the `run.start` among them of a run
 *  they give birth to (null: the run exists, and they re-register it). */
export interface Registration {
  readonly rows: readonly SessionEventDraft[];
  readonly start: Extract<SessionEventDraft, { type: 'run.start' }> | null;
}

/** The row that titles `runId`: the model's summary, or the user's rename. */
export const descriptionRow = (
  runId: RunId,
  description: string,
  by: 'model' | 'user',
): Extract<SessionEventDraft, { type: 'run.description' }> => ({
  type: 'run.description',
  aggregateId: qualifyAggregateId('run', runId),
  description,
  by,
});

/** The rows that register a run, in commit order: a new run's (`born`)
 *  `run.start`, its configuration, its `run.activate` (a re-registration's with
 *  the grants it ends, `ended`), and the description it is born with. */
export function registrationDrafts(
  runId: RunId,
  config: RunConfigRow['config'],
  options: RegisterRunOptions,
  born: boolean,
  ended: readonly SessionEventDraft[],
): Registration {
  const target = qualifyAggregateId('run', runId);
  const worktree = config.workingDirectory?.trim();
  const start: NonNullable<Registration['start']> = {
    type: 'run.start',
    aggregateId: target,
    identity: options.identity,
    userFollowUpSupport:
      options.userFollowUpSupport ?? USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    worktree: worktree ? { workingDirectory: worktree } : undefined,
    parent:
      options.parentRunId === undefined
        ? null
        : { id: options.parentRunId, call: options.parentCall ?? null },
    provenance: options.provenance ?? null,
    approvalPolicy: options.grants ?? NO_APPROVAL_GRANTS,
  };
  const rows: SessionEventDraft[] = [
    ...(born ? [start] : []),
    { type: 'run.config', aggregateId: target, config },
    { type: 'run.activate', aggregateId: target },
    ...(born ? [] : ended),
  ];
  if (options.description !== undefined)
    rows.push(descriptionRow(runId, options.description, 'model'));
  return { rows, start: born ? start : null };
}

/** A resume's activation rows: its `run.activate`, the grants it ends
 *  (`ended`), and its configuration when that changed (`config`). */
export function activationDrafts(
  runId: RunId,
  ended: readonly SessionEventDraft[],
  config: RunConfigRow['config'] | null,
): SessionEventDraft[] {
  const target = qualifyAggregateId('run', runId);
  const changed: RunConfigRow[] =
    config === null
      ? []
      : [{ type: 'run.config', aggregateId: target, config }];
  return [{ type: 'run.activate', aggregateId: target }, ...ended, ...changed];
}

/** The `run.end` row: the run's outcome, its error with the note of a last
 *  turn whose delivery failed (`note`), and what it produced, or nothing.
 *  Why a cancelled run stopped is its `run.stop` row. */
export function runEndDraft(
  runId: RunId,
  end: {
    readonly outcome: RunOutcome;
    readonly error?: RunEnd['error'];
    readonly note?: string;
    readonly output?: RunEndOutput;
  },
): Extract<RunInputDraft, { readonly type: 'run.end' }> {
  const { outcome, error, note } = end;
  const message = [error?.message, note].filter(Boolean).join('; ');
  return {
    type: 'run.end',
    aggregateId: qualifyAggregateId('run', runId),
    outcome,
    ...(error && { error: { ...error, message } }),
    output: end.output ?? emptyRunEndOutput(),
  };
}
