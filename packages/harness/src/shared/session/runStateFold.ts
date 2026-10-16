/**
 * Pure run-state replay for run history load, appendBatch, and the trace stepper:
 * state at a commit is exactly the state resume continues from, without IO,
 * clocks, platform reads, synthetic ids, or output-order dependence on Maps.
 * sessionFold produces the view; this fold produces the loop's continuation.
 *
 * The run's row grammar has one owner, `GRAMMAR`: a row commits above the
 * last, its kind's line admits it (on any state, a held one, an opened run,
 * an unopened one, or skipped), and the line's pure move refuses only what
 * its own transition rules out. `RunCell.append` folds every batch through
 * it before publishing, so the writer checks only what a batch alone shows.
 */
import { Data, Result } from 'effect';

import { type Continuation, type TurnResult } from '@texra-ai/llm';
import {
  addTurnUsage,
  EMPTY_RUN_USAGE_TOTALS,
  requestParksItsCaller,
  type CommitOrdinal,
  type HookOutcomes,
  type JsonValue,
  type ModelBackend,
  type DeclinableUsageRoute,
  type OfferedTool,
  type RetryErrorInfo,
  type RunUsageTotals,
  type SessionEvent,
  type SessionEventDraft,
} from '@shared/schemas';
import { foldRunFacts, NO_FACTS, type RunFacts } from './runFacts';
import {
  applyRunRow,
  freshRunPosition,
  type FOLLOW_UP_TYPES,
  phaseAfter,
  type RunLoopPhase,
  type FoldPass,
  type RunPosition,
  type SharedRunRow,
  writable,
} from './runRows';
import {
  attemptRequests,
  resumedAttempt,
  type Invocation,
  type PendingResponse,
} from './inFlight';
import { appended, outOfOrder, TURN_GRAMMAR } from './turnMoves';
import type { HistoryMessage, Live, RunHistoryRow } from './historyTurns';

/**
 * The rows `RunCell.append` commits: the run history arms plus the display
 * arms a batch commits atomically with them (a card with its `tool.result`,
 * a child's settlement with its boundary): published apart, each is a crash
 * window. Narrowed from the drafts. */
export type RunHistoryDraft = Live<
  Extract<SessionEventDraft, { type: RunHistoryDraftType }>
>;
type RunHistoryDraftType =
  | 'run.position'
  | 'model.message'
  | 'context.edit'
  | 'tool.intent'
  | 'script.call'
  | 'tool.result'
  | 'run.config'
  | 'tools.offered'
  | 'context.blob'
  | 'hook.outcome'
  | 'request.opened'
  | 'request.decided'
  | 'followup.queued'
  | 'followup.consumed'
  | CardRowType;

export class RunHistoryInconsistent extends Data.TaggedError(
  'RunHistoryInconsistent',
)<{
  readonly reason:
    | 'out-of-order' // commits not strictly increasing, or a row before the row it presupposes
    | 'orphan-settlement' // a tool.result under no pending response
    | 'unknown-run-row' // an unrecognized type on the run aggregate
    | 'mismatched-delivery' // a delivering append does not settle its response
    | 'unreadable-turn'; // a stored turn this build of the package cannot parse
  readonly detail: string;
  readonly commit: CommitOrdinal | null;
}> {}

/**
 * What the loop continues from. A plain type with no schema of its own,
 * because giving it one invites persisting it (C10). Every field is derived
 * from the row that produced it.
 */
export type RunState = RunPosition &
  RunFacts & {
    /** The last folded row. */
    readonly commit: CommitOrdinal;
    /** Run history rows folded: zero is an unopened run. */
    readonly runHistoryRows: number;
    /** `null` until the opening `run.position` (then moved by
     *  {@link phaseAfter}): no row that presupposes an opened run precedes it. */
    readonly phase: RunLoopPhase | null;
    /** The model the run is on: its newest `run.config`'s. */
    readonly modelId: string | null;
    /** The backend that config's `binding` names; null before the run binds. */
    readonly backend: ModelBackend | null;
    /** The failure that stopped the turn's invocation or that a person was
     *  asked about, until a response or the input of a new turn retires it. */
    readonly lastError: RetryErrorInfo | null;
    /** Subscription routes this run declines: its `run.config` binding's, and
     *  each retry answered with the user's own API key. */
    readonly declinedRoutes: readonly DeclinableUsageRoute[];
    /** Canonical provider history, in order. The pending response's assistant
     *  message enters only with its delivering `append`. */
    readonly messages: readonly HistoryMessage[];
    readonly continuation: Continuation | null;
    /** The turn's model invocation, from its first attempt until its response
     *  or the next turn's input. */
    readonly invocation: Invocation | null;
    /** The last completed turn, from its `response` row: the finish reason a
     *  loop reads when it processes a response it did not just receive. */
    readonly lastTurn: TurnResult | null;
    /** An edit (not an empty one: a model switch) changed the view since
     *  `lastTurn`, whose count measures a history it no longer holds. */
    readonly countStale: boolean;
    readonly pendingResponse: PendingResponse | null;
    /** The requests decided since the run's latest `run.activate`: answers
     *  this owner landed before its loop reached the call waiting on them, so
     *  no waiter has read them. A decision from before the activation was
     *  read by the process that asked, whose body went on with it. */
    readonly decidedSinceActivation: ReadonlySet<string>;
    /** Derived (D12): the priced usage on its `response`/`context.edit` rows. */
    readonly usage: RunUsageTotals;
    /** The latest `context.edit`'s `seq`: the next edit's `base`. */
    readonly lastEdit: number | null;
    /** The latest `tools.offered` row's set; `null` before the first. */
    readonly offeredTools: readonly OfferedTool[] | null;
    /** The plugin whose continuation the latest `tools.offered` row pinned. */
    readonly offeredContinuation: string | null;
    /** The names of the skills it listed. */
    readonly offeredSkills: readonly string[];
    /** The address of the system text the run's context froze. */
    readonly offeredSystem: string | null;
    /** The address of the context its model was told; `null` until a step
     *  opens it (the first, and after a view edit). */
    readonly offeredContext: string | null;
    readonly offeredHooks: readonly string[]; // the hooks it pinned
    /** The run's `context.blob` rows: model-facing content by address. */
    readonly contents: Readonly<Record<string, JsonValue>>;
    /** The `hook.outcome` rows by point: a recorded point never runs again. */
    readonly hookOutcomes: HookOutcomes;
  };

/** Companions committed beside a history fact, which the loop ignores. */
type CardRowType = CardType | SettlementType | EndType | 'plugin.fact';
type CardType = 'tool.start' | 'tool.end' | 'stream.end' | 'response.finalized';
type SettlementType = 'run.report' | 'run.result' | 'child.turn' | 'child.park';
type EndType = 'run.end' | 'stage.end' | 'followup.closed'; // and what it closes
/** The rows `foldRow` applies (never a run's input, the inbox's). */
type FoldedRowType = Exclude<
  SharedRunRow['type'] | RunHistoryDraft['type'] | 'run.activate',
  CardRowType | (typeof FOLLOW_UP_TYPES)[number]
>;
/** Every kind the run's state reads: its cell and the requests write them. */
export type RunStateRowType = FoldedRowType | 'response.finalized';
/** A run's input and turn companions: any job commits them, no cell. */
export type RunInputDraft = Exclude<RunHistoryDraft, { type: RunStateRowType }>;

/**
 * Display rows ignored by name: any other unfolded row on the run aggregate
 * is `unknown-run-row`, never a quiet `default`. The record is total over the
 * vocabulary, so a new display arm is a compile error here until classified.
 */
const IGNORED_ROW_TYPES: Readonly<
  Record<Exclude<SessionEvent['type'], FoldedRowType>, true>
> = {
  'tool.start': true,
  'tool.end': true,
  'stream.end': true,
  'run.start': true,
  'run.model': true,
  'run.detach': true,
  'run.end': true,
  'run.removed': true,
  'run.description': true,
  'conversation.progress': true,
  'run.fact': true,
  'child.park': true,
  'plugin.fact': true,
  'approval.policy': true,
  log: true,
  'stage.start': true,
  'stage.end': true,
  usage: true,
  'context.state': true,
  'stream.start': true,
  'response.finalized': true,
  'run.report': true,
  'run.result': true,
  'followup.closed': true,
  'followup.queued': true,
  'followup.consumed': true,
  // The child loop's own bookkeeping: folded by its readers, not the loop.
  'child.turn': true,
};
const IGNORED = new Set<string>(Object.keys(IGNORED_ROW_TYPES));
/** The state a run starts from: every field at its zero, no family bound
 *  yet. The run program opens from this and stamps its family. */
export const freshRunState = (commit: CommitOrdinal): RunState => ({
  ...freshRunPosition(),
  commit,
  runHistoryRows: 0,
  phase: null,
  modelId: null,
  backend: null,
  lastError: null,
  declinedRoutes: [],
  messages: [],
  continuation: null,
  invocation: null,
  lastTurn: null,
  countStale: false,
  pendingResponse: null,
  decidedSinceActivation: new Set(),
  usage: EMPTY_RUN_USAGE_TOTALS,
  ...NO_FACTS,
  lastEdit: null,
  offeredTools: null,
  offeredContinuation: null,
  offeredSkills: [],
  offeredSystem: null,
  offeredContext: null,
  offeredHooks: [],
  contents: {},
  hookOutcomes: {},
});

/**
 * The undecided requests nothing can recover: any but the turn's retry
 * ask and, per pending call, the request its `resumedAttempt` re-enters and
 * the one its script's calls share (attempt 0). The rest park a body past
 * its own answer, so a resume retires them as cancelled before it continues
 * the run (`RunHistory.activate`). An `externalInquiry` is the exception by
 * contract: its tool returns at once and its answer arrives as a follow-up,
 * whichever process is running the run by then, so it stands across every
 * batch its run writes.
 */
export function unboundRequests(state: RunState): readonly string[] {
  const { pendingResponse: pending, requests } = state;
  const own = new Set<string | undefined>(
    Object.entries(pending?.records ?? {}).flatMap(([callId, { status }]) => {
      if (pending === null || status.kind === 'settled') return [];
      const at = { responseId: pending.responseId, callId };
      return [
        attemptRequests(requests, { ...at, attempt: 0 }).own?.requestId,
        resumedAttempt(state, at, status).own?.requestId,
      ];
    }),
  );
  const asked = state.invocation?.current.failed?.next;
  if (asked?.kind === 'ask') own.add(asked.requestId);
  return Object.entries(requests).flatMap(([requestId, request]) =>
    request.decision !== null ||
    own.has(requestId) ||
    !requestParksItsCaller(request.payload)
      ? []
      : [requestId],
  );
}

/**
 * The routes the run declines once `decided` lands: a retry answered with
 * the user's own API key declines the route its offer named, on this run's
 * history only, so no concurrent run or stored preference changes.
 */
function declinedBy(
  state: RunState,
  decided: Extract<RunHistoryRow, { type: 'request.decided' }>,
): RunState['declinedRoutes'] {
  const opened = state.requests[decided.requestId]?.payload;
  const offer = opened?.kind === 'retry' ? opened.data.credentialSwitch : null;
  const { decision } = decided;
  return decision.action === 'retry' &&
    decision.credentials === 'personal' &&
    offer?.kind === 'decline-route' &&
    !state.declinedRoutes.includes(offer.route)
    ? [...state.declinedRoutes, offer.route]
    : state.declinedRoutes;
}

/** Why a row cannot fold: `foldRow` stamps it with the row's commit. */
export type Refusal = Pick<RunHistoryInconsistent, 'reason' | 'detail'>;
/** A line's move: the state after its row, or why the row cannot fold. */
export type Move = Result.Result<RunState, Refusal>;

const opened = (state: RunState | null): state is RunState =>
  state !== null && state.phase !== null;

/** The row of kind `K`, as the fold reads it. */
type RowOf<K extends FoldedRowType> = Extract<RunHistoryRow, { type: K }>;

/** Where a row may fold: on any state (a fresh one if none), on one an
 *  earlier row folded, after the opening `run.position`, before it (a
 *  fork's seed), or nowhere. */
type Admission = 'any' | 'held' | 'opened' | 'unopened' | 'skip';

/** One row kind's line of the run's grammar. */
export type Transition<K extends FoldedRowType> = {
  /** Where it may fold, or the classifier that reads that off the row. */
  readonly admits: Admission | ((row: RowOf<K>) => Admission);
  /** Its move from an admitted state with its commit and count in; `null`
   *  moves nothing. */
  readonly apply: (
    state: RunState,
    row: RowOf<K>,
    pass: FoldPass,
  ) => Move | null;
};

/** The rows `runRows.ts` applies for both folds, projected onto the state. */
const sharedRow = (
  state: RunState,
  row: RowOf<'run.position' | 'request.opened' | 'request.decided'>,
  pass: FoldPass,
): Move | null => {
  // `unresolved` is a malformed aggregate here: this fold reads a run's
  // whole history, so a decision always follows the opening it answers.
  const verdict = applyRunRow(state, row, pass);
  if (verdict.kind === 'unchanged') return null;
  if (verdict.kind === 'unresolved')
    return outOfOrder(`decision names no request ${verdict.requestId}`);
  if (verdict.kind === 'contradiction') return outOfOrder(verdict.detail);
  return Result.succeed({
    ...state,
    ...(row.type === 'request.decided'
      ? {
          decidedSinceActivation: new Set([
            ...state.decidedSinceActivation,
            row.requestId,
          ]),
          declinedRoutes: declinedBy(state, row),
        }
      : {}),
    ...verdict.rows,
    phase: phaseAfter(state.phase, verdict.rows.at),
  });
};

/** The run's row grammar, total over the kinds the loop continues from:
 *  `foldRow` checks each line's admission once, so no move re-asks it. */
const GRAMMAR: { readonly [K in FoldedRowType]: Transition<K> } = {
  ...TURN_GRAMMAR,
  // Only the loop's own position is a run history row; the requests a
  // session opens do not open a run.
  'run.position': { admits: 'any', apply: sharedRow },
  'request.opened': { admits: 'held', apply: sharedRow },
  'request.decided': { admits: 'held', apply: sharedRow },
  'run.activate': {
    // A new owner's lifecycle: whatever it decides from here, no earlier
    // process waited on.
    admits: 'held',
    apply: (state) =>
      Result.succeed({ ...state, decidedSinceActivation: new Set() }),
  },
  'run.config': {
    // What the run runs on: its model, and once it binds, its backend and
    // the routes its launch declined. The opening batch writes the first
    // the loop reads (a registration's, before any history, folds
    // nothing); a new model drops the old one's continuation, and the next
    // step renders the system text anew.
    admits: 'held',
    apply: (state, row) => {
      const modelId = row.config.model ?? state.modelId;
      const binding = row.binding ?? null;
      const switched = state.modelId !== null && modelId !== state.modelId;
      return Result.succeed({
        ...state,
        modelId,
        backend: binding?.backend ?? state.backend,
        declinedRoutes:
          binding === null
            ? state.declinedRoutes
            : [
                ...new Set([
                  ...state.declinedRoutes,
                  ...binding.declinedRoutes,
                ]),
              ],
        ...(switched
          ? { continuation: null, offeredSystem: null, offeredContext: null }
          : {}),
      });
    },
  },
  'context.edit': {
    // A fork's seed is its run's first view: it opens nothing, like an
    // undelivered append, and comes before the opening position. Every
    // other edit edits a view an opened run already holds.
    admits: ({ payload }) => (payload.cause === 'fork' ? 'unopened' : 'opened'),
    apply: (state, row, pass) => {
      const p = row.payload;
      if (p.cause === 'fork') {
        if (p.base !== null || p.range.to !== 0 || state.messages.length > 0)
          return outOfOrder('a fork edit replaces no earlier view');
        return Result.succeed({
          ...state,
          messages: appended(pass, state, ...p.messages),
          lastEdit: row.seq,
        });
      }
      if (p.base !== state.lastEdit)
        return outOfOrder(
          `an edit computed at ${p.base ?? 'no edit'} lands after ${state.lastEdit ?? 'no edit'}`,
        );
      if (p.range.to > state.messages.length)
        return outOfOrder(
          `an edit of messages [${p.range.from}, ${p.range.to}) over ${state.messages.length}`,
        );
      const messages = [
        ...state.messages.slice(0, p.range.from),
        ...p.messages,
        ...state.messages.slice(p.range.to),
      ];
      pass.add(messages);
      return Result.succeed({
        ...state,
        messages,
        continuation: null,
        // The next step renders the system text anew, every change in it.
        offeredSystem: null,
        offeredContext: null,
        usage: addTurnUsage(state.usage, p.usage),
        countStale:
          state.countStale ||
          p.range.from !== p.range.to ||
          p.messages.length > 0,
        lastEdit: row.seq,
      });
    },
  },
  // A fresh run's comes in its opening batch.
  'tools.offered': {
    admits: 'any',
    apply: (state, { payload }) =>
      Result.succeed({
        ...state,
        offeredTools: payload.tools,
        offeredContinuation: payload.continuation,
        offeredSkills: payload.skills,
        offeredSystem: payload.system,
        offeredContext: payload.context,
        offeredHooks: payload.hooks,
      }),
  },
  'context.blob': {
    admits: 'any',
    apply: (state, { payload }, pass) => {
      // A digest is 64 hex characters, never `__proto__`: plain assignment.
      const contents = writable(pass, state.contents, (c) => ({ ...c }));
      contents[payload.digest] = payload.value;
      return Result.succeed({ ...state, contents });
    },
  },
  // An opening batch carries its opening hooks: no opened run needed.
  'hook.outcome': {
    admits: 'any',
    apply: (state, { payload }, pass) => {
      const byPoint = writable(pass, state.hookOutcomes, (h) => ({ ...h }));
      byPoint[payload.point] = [...(byPoint[payload.point] ?? []), payload];
      return Result.succeed({ ...state, hookOutcomes: byPoint });
    },
  },
};

/** Whether the grammar holds a line for the row's kind. */
const isFolded = (row: RunHistoryRow): row is RowOf<FoldedRowType> =>
  Object.hasOwn(GRAMMAR, row.type);

/** `type`'s line of {@link GRAMMAR}. */
const lineOf = <K extends FoldedRowType>(type: K): Transition<K> =>
  GRAMMAR[type];

/** One row folded onto `current`: refused, moved, or (`null`) ignored. */
function foldRow(
  current: RunState | null,
  row: RunHistoryRow,
  pass: FoldPass,
): Result.Result<RunState, RunHistoryInconsistent> | null {
  const { commit } = row;
  const refused = (reason: Refusal['reason'], detail: string) =>
    Result.fail(new RunHistoryInconsistent({ reason, detail, commit }));
  if (current !== null && commit <= current.commit)
    return refused(
      'out-of-order',
      `commit ${commit} is not above ${current.commit}`,
    );
  if (!isFolded(row))
    return IGNORED.has(row.type) ? null : refused('unknown-run-row', row.type);
  const line = lineOf(row.type);
  const admission =
    typeof line.admits === 'function' ? line.admits(row) : line.admits;
  if (admission === 'skip' || (admission === 'held' && current === null))
    return null;
  if (admission === 'opened' && !opened(current))
    return refused(
      'out-of-order',
      `${row.type} before the opening run.position`,
    );
  if (admission === 'unopened' && opened(current))
    return refused('out-of-order', `${row.type} on a run that is already open`);
  // A row that only moves a state an earlier row folded is no run history
  // row; every other admitted row is one.
  const state = current ?? freshRunState(commit);
  const runHistoryRows = state.runHistoryRows + (admission === 'held' ? 0 : 1);
  const moved = line.apply({ ...state, commit, runHistoryRows }, row, pass);
  return moved === null
    ? null
    : Result.mapError(
        moved,
        ({ reason, detail }) =>
          new RunHistoryInconsistent({ reason, detail, commit }),
      );
}

/**
 * `rows` must be strictly increasing in `commit`; the fold does not reorder
 * them. `state` is `null` for a cold fold and the previous level for an
 * incremental one, and the two are the same computation: that equality is
 * what the run history test pins. `null` out means no run history row has folded.
 *
 * Returns a typed inconsistency rather than throwing or defaulting: a row
 * the fold cannot apply is corruption, not a state to degrade into.
 */
export function foldRunState(
  state: RunState | null,
  rows: readonly RunHistoryRow[],
): Result.Result<RunState | null, RunHistoryInconsistent> {
  let current = state;
  const pass: FoldPass = new WeakSet();
  for (const row of rows) {
    const next = foldRow(current, row, pass);
    if (next !== null && Result.isFailure(next)) return next;
    const folded = next === null ? current : next.success;
    // What the run answers and produced, read off the row it just folded.
    current =
      folded === null
        ? null
        : foldRunFacts(folded, row, folded.pendingResponse, folded.turn);
  }
  return Result.succeed(current);
}
