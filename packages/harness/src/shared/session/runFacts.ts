/**
 * What a run answers and what it produced, read from the rows that record
 * them: its input (system text, instruction, activated skills, memory misses),
 * the files its calls read and edited and how many ran, its structured output,
 * and where its turn policy stands (the final-tool nudge, the finalized
 * answer). The row handlers in `runState.ts` and `turnRowHandlers.ts` set these
 * fields, so the loop reads them off the same state on the live path and on
 * resume. The consumed follow-up is here too, as its writers commit it; the
 * rules for which pending rows a run reads are the reader's
 * (`agent/followUp/FollowUpReader.ts`).
 */
import { truncateWithEllipsis } from '@utils/text/stringUtils';
import { Predicate, Result, Schema } from 'effect';
import { type ApprovalGrants } from '@shared/approvalBypassKind';
import {
  CONTEXT_TOOL_NAME,
  ContextReplaceSchema,
  type DispatchFacts,
  type FollowUpContent,
  type FollowUpDisposition,
  type FollowUpMessage,
  type RunBinding,
  type RunId,
  type RunIdentity,
  type RunInput,
  type RunParent,
  type RunProvenance,
  type SessionRow,
  type SessionRowDraft,
  STRUCTURED_OUTPUT_TOOL_NAME,
  type ToolResultPayload,
} from '@shared/schemas';

import { byId } from './runRows';
import type { TurnResult } from '@texra-ai/llm';
import type { RowRejection, RunHistoryDraft, RunInputDraft } from './runState';
import type { PendingResponse } from './inFlight';

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
  readonly structured: { readonly value: Schema.Json } | null;
  /** The result a script run's handed-down call finished with: no model
   *  answers it, so its turn ends there, and an error fails it. */
  readonly handedDown: ToolResultPayload['result'] | null;
  /** The final-tool nudge: the turn it was appended in, so a turn is asked
   *  once, and whether the response it forces is still `owed`. A nudge of
   *  an earlier turn forces nothing. */
  readonly finalTool: {
    readonly turn: number;
    readonly owed: boolean;
  } | null;
  /** The latest response's answer was finalized for display. */
  readonly answerFinalized: boolean;
  /** The replacements the agent asked for with its `context` tool, each
   *  waiting for the next request boundary, where its `context.edit`
   *  (cause `edit`) takes it off: highest range first, so none applied
   *  shifts the indices of one still waiting. */
  readonly contextEdits: readonly ContextReplace[];
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
export const NO_FACTS: RunFacts = Object.freeze({
  answer: '',
  input: Object.freeze({}),
  edited: Object.freeze([]),
  read: Object.freeze([]),
  toolCalls: 0,
  structured: null,
  handedDown: null,
  finalTool: null,
  answerFinalized: false,
  contextEdits: Object.freeze([]),
  calls: Object.freeze<RunFacts['calls']>(byId([])),
});

/** `input` with what a row recorded: each field it names replaces the
 *  last, and a `null` instruction returns to the launch's. */
export function withInput(
  input: RunFacts['input'],
  recorded: RunInput | undefined,
): RunFacts['input'] {
  if (recorded === undefined) return input;
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

/** A replacement the agent asked for (`ContextReplaceSchema`). */
export type ContextReplace = typeof ContextReplaceSchema.Type;

/** The tool `callId` of `pending` names: its `script.call`'s for a call a
 *  script issued, else the response's own call's. */
const toolOf = (pending: PendingResponse, callId: string): string | undefined =>
  pending.records[callId]?.script?.toolName ??
  pending.calls.find((call) => call.callId === callId)?.toolName;

/**
 * The replacements waiting once `p` finished its call of `pending`: an
 * executed `replace` of the `context` tool adds its own, in range order,
 * highest first. A duplicate copies its primary's result, not its request.
 */
export function requestedEdits(
  facts: RunFacts,
  p: ToolResultPayload,
  pending: PendingResponse,
): Result.Result<RunFacts['contextEdits'], RowRejection> {
  const value = p.result.status === 'executed' ? p.result.value : undefined;
  if (
    p.disposition !== 'executed' ||
    toolOf(pending, p.callId) !== CONTEXT_TOOL_NAME ||
    !Predicate.isObject(value) ||
    value.action !== 'replace'
  )
    return Result.succeed(facts.contextEdits);
  return Result.mapBoth(
    Schema.decodeUnknownResult(ContextReplaceSchema)(value),
    {
      onFailure: (issue): RowRejection => ({
        reason: 'unreadable-turn',
        detail: `${p.callId} records a context replacement this build cannot read: ${issue.message}`,
      }),
      onSuccess: (edit) =>
        [...facts.contextEdits, edit].toSorted((a, b) => b.from - a.from),
    },
  );
}

/** What `callId` is to the run's output: a script run's handed-down call,
 *  the one call of a response no model produced; a `submit_output` call,
 *  the response's or one of its scripts' (a script's call names its tool on
 *  its `script.call`); or neither. */
function outputOf(
  pending: PendingResponse,
  callId: string,
): 'handed-down' | 'submitted' | null {
  const own = pending.calls.some((call) => call.callId === callId);
  if (own && pending.assistant.origin === null) return 'handed-down';
  return toolOf(pending, callId) === STRUCTURED_OUTPUT_TOOL_NAME
    ? 'submitted'
    : null;
}

/** Input that asks the run to do something: a message from its user or
 *  from any run. A run's report at its end and a host notice only inform
 *  it. */
export const isInstruction = (
  content: FollowUpContent,
): content is FollowUpMessage =>
  !('delivery' in content) && content.from.kind !== 'notification';

/** The row that consumes one follow-up, committed beside the rows that took
 *  it; its writer states why (`disposition`). */
export const consumedRow = (
  runId: RunId,
  followUpId: string,
  disposition: FollowUpDisposition,
): Extract<RunInputDraft, { readonly type: 'followup.consumed' }> => ({
  type: 'followup.consumed',
  aggregateId: runId,
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
  row.aggregateId === runId &&
  (row.type === 'run.activate' || row.type === 'run.end');

/** What a run is registered with: the facts its `run.start` carries. */
export interface RegisterRunOptions {
  /** The parent edge `run.start` records: the launching run, and its call
   *  that launched this one (null: no call did). The database stamps the
   *  parent's `uid`. */
  readonly parent?: Omit<RunParent, 'uid'>;
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

/** The row that titles `runId`: the model's summary, a child's label, or
 *  the user's rename, each cut to the length a run list shows. */
export const descriptionRow = (
  runId: RunId,
  description: string,
  by: 'model' | 'user',
): Extract<SessionRowDraft, { type: 'run.description' }> => ({
  type: 'run.description',
  aggregateId: runId,
  description: truncateWithEllipsis(description, 80),
  by,
});
