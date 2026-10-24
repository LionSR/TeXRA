/**
 * A run's state rebuilt from its rows: what the loop continues from, for
 * `RunHistory.load`, every `RunCell.append`, and the trace stepper. Pure (no
 * IO, clocks, platform reads, synthetic ids, or Map-order dependence), so
 * the state at a commit is exactly the state a resume continues from.
 *
 * Look up a handler by row type in `ROW_HANDLERS`. Commits must strictly
 * increase. Each handler states what it requires and returns the new state
 * or a rejection. `RunCell.append` applies every batch here before
 * publishing it, so the writer checks only what a batch alone shows.
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
import { phaseAfter, type RunLoopPhase } from '@shared/runs/runStatus';
import { NO_FACTS, withInput, type RunFacts } from './runFacts';
import {
  applyRunRow,
  type BatchCopies,
  freshRunPosition,
  type FOLLOW_UP_TYPES,
  ownCopy,
  type RunPosition,
  type SharedRunRow,
} from './runRows';
import {
  attemptRequests,
  resumedAttempt,
  type Invocation,
  type PendingResponse,
} from './inFlight';
import { outOfOrder, TURN_ROW_HANDLERS } from './turnRowHandlers';
import type { HistoryMessage, Live, RunHistoryRow } from './historyTurns';

/** The rows `RunCell.append` commits: the run history rows, and the display
 *  rows a batch commits with them (a tool's card with its `tool.result`, a
 *  child's result with its boundary), which apart would be crash windows. */
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
  | 'response.finalized'
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
    | 'out-of-order' // commits not strictly increasing, or a row before the row it needs
    | 'orphan-settlement' // a tool.result for no pending call
    | 'unknown-run-row' // an unrecognized type on the run aggregate
    | 'mismatched-delivery' // a delivering append does not match its response's results
    | 'unreadable-turn'; // a stored turn this build of the package cannot parse
  readonly detail: string;
  readonly commit: CommitOrdinal | null;
}> {}

/**
 * What the loop continues from. A plain type with no schema of its own,
 * because giving it one invites persisting it. Every field is derived
 * from the row that produced it.
 */
export type RunState = RunPosition &
  RunFacts & {
    /** The last applied row. */
    readonly commit: CommitOrdinal;
    /** Whether a run history row was applied: rows that only update an
     *  existing state (requests, config, activation) do not count. */
    readonly hasHistoryRows: boolean;
    /** `null` until the opening `run.position` (then set by
     *  {@link phaseAfter}): no row that needs an opened run comes before it. */
    readonly phase: RunLoopPhase | null;
    /** The model the run is on: its newest `run.config`'s. */
    readonly modelId: string | null;
    /** The backend that config's `binding` names; null before the run binds. */
    readonly backend: ModelBackend | null;
    /** The failure that stopped the turn's invocation or that a person was
     *  asked about, until a response or the input of a new turn clears it. */
    readonly lastError: RetryErrorInfo | null;
    /** Subscription routes this run declines: its `run.config` binding's, and
     *  each retry answered with the user's own API key. */
    readonly declinedRoutes: readonly DeclinableUsageRoute[];
    /** Canonical provider history, in order. The pending response's assistant
     *  message enters only with the `append` that delivers its results. */
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
    /** Request ids answered since the latest `run.activate`, when this
     *  process took over the run; nothing waiting has seen them yet. */
    readonly decidedSinceActivation: ReadonlySet<string>;
    /** The priced usage summed from its `response` and `context.edit` rows. */
    readonly usage: RunUsageTotals;
    /** The latest `context.edit`'s `seq`: the next edit's `base`. */
    readonly lastEdit: number | null;
    /** The latest `tools.offered` row's set; `null` before the first. */
    readonly offeredTools: readonly OfferedTool[] | null;
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

/** Display rows a batch commits together with run history rows; the run
 *  state ignores them. */
type CardRowType = CardType | ResultType | EndType | 'plugin.fact';
type CardType = 'tool.start' | 'tool.end' | 'stream.end';
type ResultType = 'run.report' | 'run.result' | 'child.turn' | 'child.park';
type EndType = 'run.end' | 'stage.end' | 'followup.closed'; // and what it closes
/** The row types the run state reads, each with a handler in
 *  `ROW_HANDLERS`. A run's input is not among them: the inbox reads it. */
export type RunStateRowType = Exclude<
  SharedRunRow['type'] | RunHistoryDraft['type'] | 'run.activate',
  CardRowType | (typeof FOLLOW_UP_TYPES)[number]
>;
/** The drafts the run state does not read (a run's input and the display
 *  rows above): any job may commit them without the run's cell. */
export type RunInputDraft = Exclude<RunHistoryDraft, { type: RunStateRowType }>;

/**
 * Display rows the run state ignores, by name: any other row type without
 * a handler is `unknown-run-row`, never a silent default. The record covers
 * every row type, so a new one fails to compile here until it gets a
 * handler or is listed.
 */
const IGNORED_ROW_TYPES: Readonly<
  Record<Exclude<SessionEvent['type'], RunStateRowType>, true>
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
  'run.report': true,
  'run.result': true,
  'followup.closed': true,
  'followup.queued': true,
  'followup.consumed': true,
  // The child loop's own bookkeeping: its readers use it, not this loop.
  'child.turn': true,
};
/** The state a run starts from: every field at its zero, no family bound
 *  yet. The run program opens from this and stamps its family. */
export const freshRunState = (commit: CommitOrdinal): RunState => ({
  ...freshRunPosition(),
  commit,
  hasHistoryRows: false,
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
  offeredSkills: [],
  offeredSystem: null,
  offeredContext: null,
  offeredHooks: [],
  contents: {},
  hookOutcomes: {},
});

/**
 * The undecided requests no resume can answer: all but the turn's retry
 * ask and, for each pending call, the request its `resumedAttempt`
 * re-enters and the one its script's calls share (attempt 0). Each of the
 * rest keeps a call waiting that a new process will not wait on, so a
 * resume cancels them before it continues the run (`RunHistory.activate`).
 * An `externalInquiry` is the exception by contract: its tool returns at
 * once and its answer arrives as a follow-up, to whichever process is
 * running the run by then, so it stays open across every batch.
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

/** Why a row cannot be applied; `applyRow` adds the row's commit. */
export type RowRejection = Pick<RunHistoryInconsistent, 'reason' | 'detail'>;
/** A handler's result: the state after its row, or why it is rejected. */
export type RowOutcome = Result.Result<RunState, RowRejection>;

/** The row of type `K`. */
type RowOf<K extends RunStateRowType> = Extract<RunHistoryRow, { type: K }>;

/** The state a row requires: any (a fresh one if there is none yet), an
 *  existing one (the row is skipped without), or an opened run, after the
 *  opening `run.position` (the row is rejected before it). */
type Requirement = 'any' | 'existing' | 'opened';

/** How the run state handles one row type. */
export type RowHandler<K extends RunStateRowType> = {
  /** The state it requires, or a function that reads that off the row. */
  readonly requires: Requirement | ((row: RowOf<K>) => Requirement);
  /** The state after the row, given one that meets the requirement and
   *  already carries the row's commit; `null` ignores the row. */
  readonly apply: (
    state: RunState,
    row: RowOf<K>,
    copies: BatchCopies,
  ) => RowOutcome | null;
};

/** The rows `applyRunRow` handles for both readers, copied onto the state. */
const applySharedRow = (
  state: RunState,
  row: RowOf<'run.position' | 'request.opened' | 'request.decided'>,
  copies: BatchCopies,
): RowOutcome | null => {
  // `unresolved` means corrupt history here: this reader has every row of
  // the run, so a decision always follows the request it answers.
  const verdict = applyRunRow(state, row, copies);
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

/** One handler per row type the run state reads. `applyRow` checks each
 *  handler's requirement, so no handler checks it again. */
const ROW_HANDLERS: { readonly [K in RunStateRowType]: RowHandler<K> } = {
  ...TURN_ROW_HANDLERS,
  // The loop's own position may start a run's state; a request needs an
  // existing one, since the requests a session opens do not start a run.
  'run.position': { requires: 'any', apply: applySharedRow },
  'request.opened': { requires: 'existing', apply: applySharedRow },
  'request.decided': { requires: 'existing', apply: applySharedRow },
  'run.activate': {
    // A new process takes over the run: nothing waiting has read the
    // decisions from here on.
    requires: 'existing',
    apply: (state) =>
      Result.succeed({ ...state, decidedSinceActivation: new Set() }),
  },
  'run.config': {
    // What the run runs on: its model, and once it binds, its backend and
    // the routes its launch declined. The opening batch writes the first
    // one the loop reads (a registration's, before any history, is
    // skipped). A new model drops the old one's continuation, and the next
    // step renders the system text again.
    requires: 'existing',
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
  'response.finalized': {
    requires: 'existing',
    apply: (state) => Result.succeed({ ...state, answerFinalized: true }),
  },
  'context.edit': {
    // A fork's seed is its run's first view: it comes before the opening
    // position and replaces nothing, like an input that opens nothing.
    // Every other edit changes a view an opened run already holds.
    requires: ({ payload }) => (payload.cause === 'fork' ? 'any' : 'opened'),
    apply: (state, row, copies) => {
      const p = row.payload;
      const input = withInput(state.input, p.input);
      if (p.cause === 'fork') {
        const first = state.phase === null && state.messages.length === 0;
        if (!first || p.base !== null || p.range.to !== 0)
          return outOfOrder('a fork edit must be the first view of its run');
        return Result.succeed({
          ...state,
          messages: p.messages,
          lastEdit: row.seq,
          input,
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
      copies.add(messages);
      return Result.succeed({
        ...state,
        messages,
        continuation: null,
        // The next step renders the system text again, every change in it.
        offeredSystem: null,
        offeredContext: null,
        usage: addTurnUsage(state.usage, p.usage),
        countStale:
          state.countStale ||
          p.range.from !== p.range.to ||
          p.messages.length > 0,
        lastEdit: row.seq,
        input,
      });
    },
  },
  // A new run's comes in its opening batch.
  'tools.offered': {
    requires: 'any',
    apply: (state, { payload }) =>
      Result.succeed({
        ...state,
        offeredTools: payload.tools,
        offeredSkills: payload.skills,
        offeredSystem: payload.system,
        offeredContext: payload.context,
        offeredHooks: payload.hooks,
      }),
  },
  'context.blob': {
    requires: 'any',
    apply: (state, { payload }, copies) => {
      // A digest is 64 hex characters, never `__proto__`: plain assignment.
      const contents = ownCopy(copies, state.contents, (c) => ({ ...c }));
      contents[payload.digest] = payload.value;
      return Result.succeed({ ...state, contents });
    },
  },
  // An opening batch carries its opening hooks: no opened run needed.
  'hook.outcome': {
    requires: 'any',
    apply: (state, { payload }, copies) => {
      const byPoint = ownCopy(copies, state.hookOutcomes, (h) => ({ ...h }));
      byPoint[payload.point] = [...(byPoint[payload.point] ?? []), payload];
      return Result.succeed({ ...state, hookOutcomes: byPoint });
    },
  },
};

/** Whether the row's type has a handler. */
const hasHandler = (row: RunHistoryRow): row is RowOf<RunStateRowType> =>
  Object.hasOwn(ROW_HANDLERS, row.type);

/** The handler for `type`. */
const handlerOf = <K extends RunStateRowType>(type: K): RowHandler<K> =>
  ROW_HANDLERS[type];

/** One row applied to `current`: rejected, applied, or (`null`) ignored. */
function applyRow(
  current: RunState | null,
  row: RunHistoryRow,
  copies: BatchCopies,
): Result.Result<RunState, RunHistoryInconsistent> | null {
  const { commit } = row;
  const rejected = (reason: RowRejection['reason'], detail: string) =>
    Result.fail(new RunHistoryInconsistent({ reason, detail, commit }));
  if (current !== null && commit <= current.commit)
    return rejected(
      'out-of-order',
      `commit ${commit} is not above ${current.commit}`,
    );
  if (!hasHandler(row))
    return Object.hasOwn(IGNORED_ROW_TYPES, row.type)
      ? null
      : rejected('unknown-run-row', row.type);
  const handler = handlerOf(row.type);
  const requires =
    typeof handler.requires === 'function'
      ? handler.requires(row)
      : handler.requires;
  if (requires === 'existing' && current === null) return null;
  if (requires === 'opened' && current?.phase == null)
    return rejected(
      'out-of-order',
      `${row.type} before the opening run.position`,
    );
  // A row that only updates an existing state is not a run history row;
  // every other row is one.
  const state = current ?? freshRunState(commit);
  const hasHistoryRows = state.hasHistoryRows || requires !== 'existing';
  const next = handler.apply({ ...state, commit, hasHistoryRows }, row, copies);
  return next === null
    ? null
    : Result.mapError(
        next,
        ({ reason, detail }) =>
          new RunHistoryInconsistent({ reason, detail, commit }),
      );
}

/**
 * Apply `rows` to `state`. The rows must be strictly increasing in
 * `commit`; they are not reordered. `state` is `null` to rebuild a run from
 * nothing, or an earlier result to continue from it, and both give the
 * same state: the run history test checks that. `null` out means no run
 * history row was applied.
 *
 * Returns a typed inconsistency rather than throwing or defaulting: a row
 * that cannot be applied is corrupt history, not a state to degrade into.
 */
export function applyRunRows(
  state: RunState | null,
  rows: readonly RunHistoryRow[],
): Result.Result<RunState | null, RunHistoryInconsistent> {
  let current = state;
  const copies: BatchCopies = new WeakSet();
  for (const row of rows) {
    const next = applyRow(current, row, copies);
    if (next === null) continue;
    if (Result.isFailure(next)) return next;
    current = next.success;
  }
  return Result.succeed(current);
}
