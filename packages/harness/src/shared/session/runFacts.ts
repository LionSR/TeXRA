/**
 * What a run answers and what it produced, read from the rows that record
 * them: its input (system text, instruction, activated skills, memory
 * misses), the files its calls edited and how many ran, its structured
 * output, and where its turn policy stands (the final-tool nudge, the
 * finalized answer); and the rules for reading its pending input (the
 * `followup.queued` rows), stated once for the loop, the inbox and the view. The row handlers in `runState.ts` and
 * `turnRowHandlers.ts` set these fields, so the loop reads them off the
 * same state on the live path and on resume. The lifecycle rows a run is
 * registered, activated and ended with are built here too, beside the
 * readers of their facts; `agent/storage/runLifecycle.ts` commits them.
 */
import {
  NO_APPROVAL_GRANTS,
  type ApprovalGrants,
} from '@shared/approvalBypassKind';
import {
  type DispatchFacts,
  emptyRunEndOutput,
  type FollowUpContent,
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

import {
  byId,
  isMessage,
  isSharedRunRow,
  isStaleNotice,
  type QueuedFollowUp,
  type RunLookup,
} from './runRows';
import { runRowsFrom } from './runRowReads';
import type { RunHistoryDraft, RunInputDraft } from './runState';
import type { RunRows } from './runRowsShape';
import type { Invocation, PendingResponse } from './inFlight';

/** What a run answers and produced, as its rows record it. */
export type RunFacts = {
  /** The latest value of each field an `append` or a fork's edit recorded;
   *  an instruction absent is the launch's. */
  readonly input: Omit<RunInput, 'instruction'> & {
    readonly instruction?: string;
  };
  /** The workspace files the run's calls edited, first edit first. */
  readonly edited: readonly string[];
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
  input: {},
  edited: [],
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

/** The facts one `tool.result` changes: the files it edited, whether it
 *  ran, and, when it is the run's output, its value (and a handed-down
 *  call's result). `pending` is the response the call belongs to. */
export function resultFacts(
  facts: RunFacts,
  p: ToolResultPayload,
  pending: PendingResponse,
): Partial<RunFacts> {
  const ran = p.disposition === 'executed' || p.disposition === 'failed';
  const edits = p.result.status === 'executed' ? (p.result.edits ?? []) : [];
  const fresh = [
    ...new Set(edits.map(({ path }) => path).filter(Boolean)),
  ].filter((path) => !facts.edited.includes(path));
  const output = outputOf(pending, p.callId);
  const value = p.result.status === 'executed' ? p.result.value : undefined;
  return {
    edited: fresh.length === 0 ? facts.edited : [...facts.edited, ...fresh],
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

// ---------------------------------------------------- pending input

/** Input that asks the run to do something: its user's and its parent's.
 *  A child's report, any other run's message and a host notice inform the
 *  run and never instruct it. */
export const isInstruction = ({ from }: FollowUpContent): boolean =>
  from.kind === 'user' || (from.kind === 'run' && from.relation === 'parent');

/** Where in its loop a run reads its input: before a model request inside
 *  a turn, at the turn's end, or while it waits for input. */
export type InputPoint = 'request' | 'turn' | 'idle';

/** The pending messages a run reads at `at`, in commit order. A row held
 *  until an instruction (a child's pause or stop notice) is read only beside
 *  one. A row held until the turn ends, or one for a running generation only
 *  (a progress notice, a host notification), is not read before a request
 *  inside the turn. A notice from a child run that has ended is stale: it is
 *  consumed unread (`staleNotices`). */
export function readableMessages(
  rows: readonly QueuedFollowUp[],
  at: InputPoint,
  run: RunLookup,
): QueuedFollowUp[] {
  const messages = rows.filter(isMessage);
  const asked = messages.some(
    (f) => f.holdUntil === undefined && isInstruction(f.content),
  );
  return messages.filter((f) => {
    switch (f.holdUntil) {
      case 'instruction':
        return asked;
      case 'turn':
        return at !== 'request';
      case 'generation':
        return at !== 'request' && !isStaleNotice(f, run);
      case undefined:
        return true;
    }
  });
}

/** The stale notices among the pending rows: consumed unread by the next
 *  batch the run takes. */
export const staleNotices = (
  rows: readonly QueuedFollowUp[],
  run: RunLookup,
): QueuedFollowUp[] => rows.filter((f) => isStaleNotice(f, run));

/** The row that consumes one follow-up: committed with the message it became,
 *  or with the end of a run that never read it. */
export const consumedRow = (
  runId: RunId,
  followUpId: string,
): Extract<RunInputDraft, { readonly type: 'followup.consumed' }> => ({
  type: 'followup.consumed',
  aggregateId: qualifyAggregateId('run', runId),
  followUpId,
});

/** Run `runId`'s rows among `rows`, folded (a shared row left out, so a
 *  partial read, a listing's, folds too). */
export const recordsOf = (
  rows: readonly SessionEvent[],
  runId: RunId,
): RunRows => {
  const id = qualifyAggregateId('run', runId);
  return runRowsFrom(
    rows.filter((row) => row.aggregateId === id && !isSharedRunRow(row)),
  );
};

/** The row that bounds run `runId`'s current lifecycle in `rows`: its last
 *  `run.end` or `run.activate`, since an activate after an end starts a new
 *  lifecycle, so a resumed run never carries the end of one it left. */
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

/**
 * Whether a run's pending input obliges a resume of it when no generation
 * holds it, from its input rows (`followup.queued`, `followup.consumed`,
 * `run.activate`, `run.end`), over the messages readable at idle. While the
 * run's current lifecycle has not ended (it waits on a child, or its
 * generation left without an end), any run's message wakes it, as the
 * user's does. Once it ended, only the user's message or a child's delivery
 * does, and after a user's Stop (that lifecycle's `run.end` is cancelled)
 * only the user's message committed after that end: a run's message never
 * revives a run that ended. A row for a running generation only (a progress
 * notice, a host notification) wakes nothing.
 */
export function needsWake(input: RunRows, run: RunLookup): boolean {
  // A resumed run that crashed carries no end, so no earlier Stop of it
  // holds a message back.
  const end = input.end;
  const stopped = end?.outcome === 'cancelled';
  return readableMessages(input.followUps, 'idle', run).some(
    ({ commit, holdUntil, content: { from } }) => {
      if (holdUntil === 'generation') return false;
      if (from.kind === 'user') return !stopped || commit > end.commit;
      if (from.kind === 'run' && from.relation === 'child') return !stopped;
      return end === null;
    },
  );
}

/** `invocation` once a clean close stopped its open attempt (a `run.position`
 *  halt with reason `closed`): none, or one whose outcome a row recorded, is
 *  as it was. */
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
  /** Who wrote it: the model, unless a fork copies its user's title. */
  readonly descriptionBy?: 'model' | 'user';
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

/** The rows that register a run, in commit order: a new run's (`born`)
 *  `run.start`, its configuration, its `run.activate` (a re-registration's
 *  with the grants it ends, `ended`), and the description it is born with. */
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
    rows.push({
      type: 'run.description',
      aggregateId: target,
      description: options.description,
      by: options.descriptionBy ?? 'model',
    });
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
 *  turn whose delivery failed (`note`), and what it produced, or nothing. */
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
  const message = error && [error.message, note].filter(Boolean).join('; ');
  return {
    type: 'run.end',
    aggregateId: qualifyAggregateId('run', runId),
    outcome,
    ...(error && { error: { ...error, message } }),
    output: end.output ?? emptyRunEndOutput(),
  };
}
