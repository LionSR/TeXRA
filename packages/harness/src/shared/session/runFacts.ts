/**
 * What a run answers and what it produced, read from the rows that record
 * them: its input (system text, instruction, activated skills, memory misses),
 * the files its calls read and edited and how many ran, its structured output,
 * and where its turn policy stands (the final-tool nudge, the finalized
 * answer). The row handlers in `runState.ts` and `turnRowHandlers.ts` set these
 * fields, so the loop reads them off the same state on the live path and on
 * resume. The consumed follow-up is here too, as its writers commit it (its
 * receipt is `followUpReceipt`, in `runRowReads.ts`); the rules for which
 * pending rows a run reads are the reader's (`agent/followUp/FollowUpReader.ts`).
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
  type FollowUpMessage,
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
  type SessionRow,
  type SessionRowDraft,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type ToolResultPayload,
} from '@shared/schemas';

import { byId } from './runRows';
import type { TurnResult } from '@texra-ai/llm';
import type { RunHistoryDraft, RunInputDraft } from './runState';
import type { Invocation, PendingResponse } from './inFlight';

/** The text a completed model turn or assistant message contains, in order. */
export const turnText = (turn: Pick<TurnResult, 'content'>): string =>
  turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');

/** The key of a call among a run's calls: its id within the response that
 *  issued it, as a provider reuses call ids across responses. */
export const callKey = (responseId: string, callId: string): string =>
  `${responseId}/${callId}`;

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
   *  {@link callKey}: its tool and card, and the response that issued it (a
   *  script's call: its script's) with that row's commit and seq. */
  readonly calls: Readonly<
    Record<
      string,
      Pick<DispatchFacts, 'toolName' | 'logId'> &
        Pick<SessionRow, 'commit' | 'seq'> & { readonly responseId: string }
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

/** Input that asks the run to do something: its user's and its parent's
 *  messages. A child's report, another run's message and a host notice only
 *  inform it. */
export const isInstruction = (
  content: FollowUpContent,
): content is FollowUpMessage =>
  !('delivery' in content) &&
  (content.from.kind === 'user' ||
    (content.from.kind === 'run' && content.from.relation === 'parent'));

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

/** Whether `row` bounds a lifecycle of run `runId`: its `run.activate`
 *  starts one, its `run.end` ends it. The pair a lifecycle's rows lie
 *  between is its latest `run.activate` and the `run.end` after it. */
export const boundsLifecycle = (
  row: Pick<SessionRow, 'aggregateId' | 'type'>,
  runId: RunId,
): boolean =>
  row.aggregateId === qualifyAggregateId('run', runId) &&
  (row.type === 'run.activate' || row.type === 'run.end');

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
  readonly takesFollowUps?: boolean;
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

type RunConfigRow = Extract<SessionRowDraft, { readonly type: 'run.config' }>;

/** The rows that register a run, and the `run.start` among them of a run
 *  they give birth to (null: the run exists, and they re-register it). */
export interface Registration {
  readonly rows: readonly SessionRowDraft[];
  readonly start: Extract<SessionRowDraft, { type: 'run.start' }> | null;
  /** Its configuration as a `run.config`, apart from `rows`, so the batch
   *  that commits them records one: a run whose loop is not this
   *  process's records this one (`registerRun`), as does a fork of a run
   *  that never bound (`forkRun`); a launch that binds a model records its
   *  own, with the binding (`openToolUse`). */
  readonly config: RunConfigRow;
}

/** The row that titles `runId`: the model's summary, or the user's rename. */
export const descriptionRow = (
  runId: RunId,
  description: string,
  by: 'model' | 'user',
): Extract<SessionRowDraft, { type: 'run.description' }> => ({
  type: 'run.description',
  aggregateId: qualifyAggregateId('run', runId),
  description,
  by,
});

/** The rows that register a run, in commit order: a new run's (`born`)
 *  `run.start`, its `run.activate` (a re-registration's with the grants it
 *  ends, `ended`), and the description it is born with; and its
 *  configuration, for its first batch to record ({@link Registration}). */
export function registrationDrafts(
  runId: RunId,
  config: RunConfigRow['config'],
  options: RegisterRunOptions,
  born: boolean,
  ended: readonly SessionRowDraft[],
): Registration {
  const target = qualifyAggregateId('run', runId);
  const worktree = config.workingDirectory?.trim();
  const start: NonNullable<Registration['start']> = {
    type: 'run.start',
    aggregateId: target,
    identity: options.identity,
    takesFollowUps: options.takesFollowUps ?? false,
    worktree: worktree ? { workingDirectory: worktree } : undefined,
    parent:
      options.parentRunId === undefined
        ? null
        : { id: options.parentRunId, call: options.parentCall ?? null },
    provenance: options.provenance ?? null,
    approvalPolicy: options.grants ?? NO_APPROVAL_GRANTS,
  };
  const rows: SessionRowDraft[] = [
    ...(born ? [start] : []),
    { type: 'run.activate', aggregateId: target },
    ...(born ? [] : ended),
  ];
  if (options.description !== undefined)
    rows.push(descriptionRow(runId, options.description, 'model'));
  return {
    rows,
    start: born ? start : null,
    config: { type: 'run.config', aggregateId: target, config },
  };
}

/** A resume's activation rows: its `run.activate`, the grants it ends
 *  (`ended`), and its configuration when that changed (`config`). */
export function activationDrafts(
  runId: RunId,
  ended: readonly SessionRowDraft[],
  config: RunConfigRow['config'] | null,
): SessionRowDraft[] {
  const target = qualifyAggregateId('run', runId);
  const changed: RunConfigRow[] =
    config === null
      ? []
      : [{ type: 'run.config', aggregateId: target, config }];
  return [{ type: 'run.activate', aggregateId: target }, ...ended, ...changed];
}

/** The `run.end` row: the run's outcome, its error, and what it produced,
 *  or nothing. Why a cancelled run stopped is its `run.stop` row. */
export function runEndDraft(
  runId: RunId,
  end: {
    readonly outcome: RunOutcome;
    readonly error?: RunEnd['error'];
    readonly output?: RunEndOutput;
  },
): Extract<RunInputDraft, { readonly type: 'run.end' }> {
  const { outcome, error } = end;
  return {
    type: 'run.end',
    aggregateId: qualifyAggregateId('run', runId),
    outcome,
    ...(error && { error }),
    output: end.output ?? emptyRunEndOutput(),
  };
}
