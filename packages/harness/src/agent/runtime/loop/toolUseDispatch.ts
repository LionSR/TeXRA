/**
 * Dispatch of one committed response's tool calls, from the run's state and
 * back into it. What it guarantees, by construction: contiguous parallel
 * calls run concurrently under a small window while every other call is a
 * barrier that runs alone and in order; a call repeating an earlier call's
 * name and arguments never executes and derives its primary's result; a
 * result that ends the turn stops dispatch after its group; one interrupt
 * cancels the whole in-flight batch through the fiber; an ordinary tool
 * failure becomes a model-visible error result; and a durable write failure
 * halts dispatch, so an unfinished call is never recorded as done.
 *
 * One per-call program (`finishCall`) over one record per call
 * (`PendingCall`), whichever issued it: the response, whose calls are
 * partitioned into their groups up front, or a guest of one of its `script`
 * calls, whose calls take their lanes as the guest issues them. A call's rows
 * are its only facts: the `script.call` that issues a script's call commits
 * with the call's first row; its requests, under ids the attempt derives
 * (`callRequestId`); `tool.intent` as the body starts, after the PreToolUse
 * hooks, the guard and its approval, with a slow tool's card; `tool.result`
 * with its card's close; and the delivering `append` with the complete tool
 * group once, when every call of the response has its result.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberMap,
  FileSystem,
  Schema,
  Scope,
  Semaphore,
  SynchronizedRef,
} from 'effect';

import { normalizeToolCallError } from '@agent/core/tools/toolCallParsing';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import { ChildRuns, childRuns } from '@agent/runtime/ToolServices';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  RunCall,
  ScriptDiverged,
  type RunCallShape,
  type ScriptDoor,
  type ScriptScope,
  type ScriptSource,
} from '@agent/runtime/RunCall';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  qualifyAggregateId,
  SettledToolResultSchema,
  toJsonValue,
  type AggregateId,
  type DispatchFacts,
  type FileListEntry,
  type ScriptCallPayload,
  type ToolCallStatus,
  type StoredMediaPart,
  type ToolResult,
  type ToolResultPayload,
} from '@shared/schemas';
import type { DraftBlob } from '@shared/session/historyTurns';
import {
  findStorageRefusal,
  runRefusal,
  type RunCell,
} from '@shared/session/runHistory';
import { consumedRow } from '@shared/session/runFacts';
import { type RunHistoryDraft, type RunState } from '@shared/session/runState';
import {
  attemptOf,
  callSettlementOf,
  resumedAttempt,
  type CallResult,
  type CallStatus,
} from '@shared/session/inFlight';
import type { QueuedFollowUp } from '@shared/session/runRows';
import { checkOwnFacts, factRows } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';
import { getBasename } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import {
  captureAttachments,
  storedMediaPart,
  type InputPart,
} from '../run/mediaInput';
import { stored } from '../run/requestContext';
import {
  localCallsOf,
  parseCallArguments,
  replayable,
  SKIPPED_AFTER_END_TURN,
  SKIPPED_NOT_STARTED,
  skippedByScriptEnd,
  unknownOutcome,
} from '../run/tools';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '../run/toolResultText';
import { callRequests, guardedToolCall } from './toolGuard';
import { callHookText, preToolUse } from './hooks';
import { appendRow, displayRow, positionRow } from './rows';
import { Runs } from '../runRegistry';
import type { StepTools } from './step';
import type { InvokeError } from '../ModelInvoker';

/** Max concurrently executing parallel tool calls. */
const MAX_PARALLEL_TOOL_CALLS = 4;

/** How much of a running tool's output streams to its card as transient
 *  text; the result carries the bounded capture whatever streamed. */
const STREAMED_OUTPUT_MAX = 50_000;

/** One response's dispatch: what every call of it runs under, the response's
 *  own and its scripts' guests' alike, read once from the opening state. */
interface Dispatch {
  readonly run: AgentRunShape;
  readonly cell: RunCell;
  readonly step: StepTools;
  readonly responseId: string;
  readonly aggregateId: AggregateId;
  /** The user instruction the response answers. */
  readonly instruction: string | undefined;
  /** The response was pending when the cell opened and has a model to
   *  report to: a call nothing of which ran is reported, not run. */
  readonly recovered: boolean;
  /** Each offered tool's plugin, by tool name. */
  readonly pluginOf: ReadonlyMap<string, string>;
}

/** One call as the per-call program takes it: its facts (a response's
 *  dispatch fact, or a script's `script.call`), its input and its dispatch. */
interface Call {
  readonly dispatch: Dispatch;
  readonly fact: DispatchFacts | ScriptCallPayload;
  readonly input: unknown;
}

/** The `script.call` a call carries, or null for a response's own. */
const scriptOf = (fact: Call['fact']): ScriptCallPayload | null =>
  'scriptCallId' in fact ? fact : null;

interface DispatchOutcome {
  readonly state: RunState;
  /** A call's result asked to end the turn. */
  readonly endTurn: boolean;
}

/** The record of `callId` under the dispatch's response, or null. */
const recordOf = (dispatch: Dispatch, state: RunState, callId: string) =>
  state.pendingResponse?.responseId === dispatch.responseId
    ? (state.pendingResponse.records[callId] ?? null)
    : null;

/** The result of `callId` the rows committed, or null. */
const settlementOf = (dispatch: Dispatch, state: RunState, callId: string) =>
  state.pendingResponse?.responseId === dispatch.responseId
    ? callSettlementOf(state.pendingResponse, callId)
    : null;

/** A sanitized result as the run history stores it: `consumedFollowUps`
 *  (own rows) and `facts` dropped, `files` without their bytes, `diagnostics`
 *  narrowed to JSON; a non-JSON value here is a defect, refused not stored. */
const storedResult = (result: ToolResult): CallResult['result'] =>
  Schema.decodeUnknownSync(SettledToolResultSchema)(result);

/** A duplicate's copy of its primary's result: no edits, no files. */
const withoutEffects = (result: CallResult['result']): CallResult['result'] => {
  if (result.status !== 'executed') return result;
  const { edits: _edits, files: _files, ...rest } = result;
  return rest;
};

const endsTurn = (recorded: Pick<CallResult, 'result'> | null): boolean =>
  recorded?.result.status === 'executed' && recorded.result.endTurn === true;

const dispositionOf = (
  result: Pick<ToolResult, 'status'>,
): CallResult['disposition'] =>
  result.status === 'executed' ? 'executed' : 'failed';

/** How long delivery waits on the provider to take the uploads, an
 *  optimisation for later rounds; the bytes are delivered either way. */
const UPLOAD_DEADLINE = '5 seconds';

/** The model-visible content of one call's result: text, then inline media,
 *  each with its attachment's path. The run history keeps the bytes; whether
 *  a later request sends them or a file id is the bound model's upload
 *  cache's decision. An attachment whose bytes were never captured (which
 *  its row records) or that the binding cannot carry inline reaches the
 *  model as its mention, which says why. */
function resultContent(
  recorded: Pick<CallResult, 'result' | 'attachments'>,
  capabilities: Parameters<typeof storedMediaPart>[2],
): {
  readonly text: InputPart;
  readonly media: readonly {
    readonly path: string;
    readonly part: StoredMediaPart;
  }[];
} {
  const media: { readonly path: string; readonly part: StoredMediaPart }[] = [];
  const mentions = recorded.attachments.map(({ path, mimeType, content }) => {
    if (content.kind !== 'stored')
      return {
        path,
        mimeType,
        note: `its bytes were not captured (${content.reason})`,
      };
    const part = storedMediaPart(mimeType, content.digest, capabilities);
    if (part === null)
      return { path, mimeType, note: `the model takes no ${mimeType} inline` };
    media.push({ path, part });
    return { path, mimeType };
  });
  const text = formatToolResultAsText(
    recorded.result,
    mentions.length > 0 ? formatAttachmentSummary(mentions) : undefined,
  );
  return { text: { kind: 'text', text }, media };
}

/** Commit rows of the call, its `script.call` first while the run holds no
 *  record of it: a script's call exists from its first row. Concurrent
 *  results of one group commit one at a time under the cell's lock. */
const commit = (
  { dispatch, fact }: Call,
  rows: readonly RunHistoryDraft[],
  alongside?: ReturnType<typeof factRows>['alongside'],
) =>
  dispatch.cell.append((state) => {
    const script = scriptOf(fact);
    return script !== null && recordOf(dispatch, state, fact.callId) === null
      ? [
          {
            type: 'script.call',
            aggregateId: dispatch.aggregateId,
            payload: script,
          },
          ...rows,
        ]
      : rows;
  }, alongside);

/** The call's result row at `attempt`; `blobs` are the bytes it links. */
const resultRow = (
  { dispatch, fact }: Call,
  attempt: number,
  result: Omit<CallResult, 'attempt'>,
  blobs: readonly DraftBlob[] = [],
): RunHistoryDraft => ({
  type: 'tool.result',
  aggregateId: dispatch.aggregateId,
  payload: {
    responseId: dispatch.responseId,
    callId: fact.callId,
    attempt,
    ...result,
  },
  ...(blobs.length > 0 && { blobs }),
});

/** Commit the call's result at `attempt`, its card `rows` in the batch. */
const commitResult = (
  call: Call,
  attempt: number,
  result: Omit<CallResult, 'attempt'>,
  rows: readonly RunHistoryDraft[] = [],
) => commit(call, [resultRow(call, attempt, result), ...rows]);

/** The rows of a call's card over `ran`, the input its body ran on: its
 *  `tool.start` unless the card is `opened` already, then its `tool.end` when
 *  `close` says how it ended, with the `files` it edited. A slow tool's card
 *  opens with its intent, so a resume finds the card its result closes; a fast
 *  tool's opens and closes with its result, which a read projects it from
 *  (`rowCodec.ts`): the card stores no output. */
const cardRows = (
  { dispatch, fact }: Call,
  ran: unknown,
  attempt: number,
  opened: boolean,
  close: ToolCallStatus | null,
  files: readonly FileListEntry[] = [],
): RunHistoryDraft[] => {
  const script = scriptOf(fact);
  const base = {
    logId: fact.logId,
    ...(script === null ? {} : { stageId: script.stageId }),
  };
  const { runId } = dispatch.run;
  return [
    ...(opened
      ? []
      : [
          displayRow(runId, {
            type: 'tool.start',
            ...base,
            toolName: fact.toolName,
            input: toJsonValue(ran),
            card: dispatch.step.registry
              .get(fact.toolName)
              ?.definition.card?.(ran),
            ...(script?.phase != null ? { phase: script.phase } : {}),
            ...(attempt > 1 ? { attempt } : {}),
          }),
        ]),
    ...(close === null
      ? []
      : [
          displayRow(runId, {
            type: 'tool.end',
            ...base,
            status: close,
            ...(files.length > 0 ? { files: [...files] } : {}),
          }),
        ]),
  ];
};

/** Settle a call that has no result as skipped for `reason`, closing the
 *  card its attempt opened (a slow tool's); one that never started has none. */
const skipCall = (
  call: Call,
  status: Exclude<CallStatus, { kind: 'settled' }>,
  reason: string,
) => {
  const reached = attemptOf(status);
  const slow = call.dispatch.step.registry.get(call.fact.toolName)?.slow;
  return commitResult(
    call,
    Math.max(1, reached),
    {
      disposition: 'skipped',
      duplicateOf: null,
      result: { status: 'error', error: reason },
      attachments: [],
    },
    reached === 0
      ? []
      : cardRows(call, call.input, reached, slow === true, 'failed'),
  );
};

/**
 * Finish one call from where its rows left it, under `place`: the script
 * that issued it, or the door a `script` call issues its own through. A
 * settled call keeps its result; a duplicate derives its primary, effects
 * stripped; a call after a group that `ended` the turn, one untouched in a
 * recovered response, and a started body that may have run and may not be
 * replayed are skipped, closing their cards; any other runs at the attempt
 * `resumedAttempt` continues, re-entering the request that attempt left
 * standing. A throwing tool is an error result; interruption leaves none.
 */
const finishCall = Effect.fn('toolUse.finishCall')(function* (
  call: Call,
  place: Pick<RunCallShape, 'script' | 'scriptCalls'>,
  ended = false,
): Effect.fn.Return<
  void,
  InvokeError,
  ProcessServices | Runs | WorkspaceFs | StorageFs | FileSystem.FileSystem
> {
  const { dispatch, fact, input } = call;
  const { run, cell, step, responseId } = dispatch;
  const { runId, logger } = run;
  const script = scriptOf(fact);
  const state = yield* cell.current;
  const status: CallStatus = recordOf(dispatch, state, fact.callId)?.status ?? {
    kind: 'issued',
  };
  if (status.kind === 'settled') return;
  if ('duplicateOf' in fact && fact.duplicateOf !== null) {
    const primary = settlementOf(dispatch, state, fact.duplicateOf);
    if (primary !== null)
      yield* commitResult(call, Math.max(1, attemptOf(status)), {
        disposition: 'duplicate',
        duplicateOf: fact.duplicateOf,
        result: withoutEffects(primary.result),
        attachments: [],
      });
    return;
  }
  if (ended) {
    yield* skipCall(call, status, SKIPPED_AFTER_END_TURN);
    return;
  }
  const at = { responseId, callId: fact.callId };
  const entered = resumedAttempt(state, at, status);
  // Untouched in a recovered response: reported, not run; a script's calls run.
  const untouched = status.kind === 'issued' && entered.raised === 0;
  if (untouched && dispatch.recovered && script === null) {
    yield* skipCall(call, status, SKIPPED_NOT_STARTED);
    return;
  }
  if (
    entered.mayHaveRun &&
    !(yield* replayable(fact, step.registry, input, logger, entered.attempt))
  ) {
    yield* skipCall(call, status, unknownOutcome(entered.attempt));
    return;
  }
  const { attempt, raised, own: standing } = entered;
  // Whether this attempt's intent is committed: a re-entered attempt's is.
  let bodyStarted = status.kind === 'started' && status.attempt === attempt;
  // A tool the step offers but did not send (script-only tools on) is
  // reached from inside a script alone: a response's call to it has no body.
  const unsent =
    script === null &&
    step.offered.some((t) => t.name === fact.toolName && !t.sent);
  const tool = unsent ? undefined : step.registry.get(fact.toolName);
  // A slow tool's card opens as its body starts; what the tool prints is
  // transient text on it, capped, never a row, refused once the call returned.
  let accepting = false;
  let streamed = 0;
  const onToolOutput = (chunk: string): void => {
    const text = accepting
      ? chunk.slice(0, STREAMED_OUTPUT_MAX - streamed)
      : '';
    if (text.length === 0) return;
    streamed += text.length;
    const { logId: id } = fact;
    run.session.log.publish(runId, { type: 'stream.chunk', id, text });
  };
  const { requests, retireStanding } = callRequests(
    run,
    cell,
    (rows) => commit(call, rows),
    { ...at, attempt },
    raised,
    standing,
    'The resumed call no longer asks it.',
  );
  // Its step's PreToolUse hooks, recorded before the chain decides.
  const pre =
    tool && (yield* preToolUse(run, cell, step, fact, responseId, input));
  if (pre && pre.rows.length > 0) yield* commit(call, pre.rows);
  let result: ToolResult;
  // What the body ran on, which the cards show; the issued input is recorded.
  let ran = input;
  if (!tool || !pre) {
    result = {
      status: 'error',
      error: unsent
        ? `tool_unavailable: "${fact.toolName}" is not a direct call in this run; call it from a script as tools.${fact.toolName}(...).`
        : `tool_unavailable: the tool "${fact.toolName}" is not available in this run. Continue with the tools you were offered.`,
      diagnostics: { code: 'tool_unavailable', tool: fact.toolName },
    };
  } else {
    // From here the call may have run: its intent commits now, with a slow
    // tool's card, unless this attempt's body already started (a re-entry).
    const bodyStarts = (on: unknown) =>
      Effect.gen(function* () {
        ran = on;
        if (!bodyStarted)
          yield* commit(call, [
            {
              type: 'tool.intent',
              aggregateId: dispatch.aggregateId,
              payload: {
                origin:
                  script === null
                    ? { kind: 'response', responseId }
                    : { kind: 'script', scriptCallId: script.scriptCallId },
                callId: fact.callId,
                attempt,
              },
            },
            ...(tool.slow ? cardRows(call, on, attempt, false, null) : []),
          ]);
        bodyStarted = true;
        accepting = tool.slow === true;
        yield* pre.bodyStarts;
      });
    // This call's place in its run, and the child door over exactly it.
    const runCall: RunCallShape = {
      run,
      responseId,
      instruction: dispatch.instruction,
      attempt,
      logId: fact.logId,
      ...place,
    };
    // The chain first, under the step's roots and plugin services: a call
    // it stops ends with an error result before the body runs.
    const invoked = yield* Effect.exit(
      Effect.scoped(
        guardedToolCall(tool, input, pre, bodyStarts).pipe(
          Effect.provideService(ToolContext, {
            callId: fact.callId,
            env: {
              roots: run.session.roots,
              workingDirectory: run.workingDirectory,
              stepRoots: step.stepRoots,
              run,
            },
            requests,
            emit: onToolOutput,
          }),
          Effect.provideService(ChildRuns, childRuns(runCall, yield* Runs)),
          Effect.provideService(RunCall, runCall),
          Effect.provide(step.services),
        ),
      ),
    );
    accepting = false;
    if (Exit.isSuccess(invoked)) {
      result = invoked.value;
    } else if (Cause.hasInterrupts(invoked.cause)) {
      // Keep a finalizer failure from the cancelled write beside the interrupt.
      return yield* Effect.failCause(
        Cause.fromReasons<never>(
          invoked.cause.reasons.map((reason) =>
            Cause.isFailReason(reason)
              ? Cause.makeDieReason(reason.error)
              : reason,
          ),
        ),
      );
    } else {
      const refused = findStorageRefusal(invoked.cause);
      if (refused) return yield* runRefusal(runId, refused);
      const { message, diagnostics } = normalizeToolCallError(
        fact.toolName,
        Cause.squash(invoked.cause),
      );
      result = {
        status: 'error',
        error: message.trim() || 'Tool run failed.',
        ...(diagnostics ? { diagnostics } : {}),
      };
    }
  }
  // A result the schema refuses becomes an error result the model can read;
  // the projection of an error result cannot itself fail.
  const plugin = (yield* ToolRegistry).entries.get(
    dispatch.pluginOf.get(fact.toolName) ?? '',
  );
  const extracted = yield* Effect.try({
    try: () =>
      extractToolAttachments(result, (facts) => checkOwnFacts(plugin, facts)),
    catch: ensureError,
  }).pipe(
    Effect.catch((error) =>
      Effect.sync(() => {
        result = {
          status: 'error',
          error: `${fact.toolName}: Tool returned an invalid result (${toErrorMessage(error)})`,
        };
        return extractToolAttachments(result);
      }),
    ),
  );
  const edited =
    result.status === 'executed'
      ? (result.edits ?? []).flatMap(({ path }) => (path ? [path] : []))
      : [];
  const editedFiles = [...new Set(edited)].map((path) => ({
    path,
    ok: true,
    source: 'tool',
    sourceDisplay: 'Tool use',
  }));
  const { attachments, blobs } = yield* captureAttachments(
    extracted.attachments,
    run.session.roots.workspace,
  );
  const sanitized = extracted.sanitizedResult;
  // The card commits with the result (a slow tool's closes, a fast tool's
  // opens and closes here); outside the batch recovery could see it undone.
  const cards = cardRows(
    call,
    ran,
    attempt,
    tool?.slow === true && bodyStarted,
    sanitized.status === 'error' ? 'failed' : 'completed',
    editedFiles,
  );
  // An executed call's PostToolUse rows, the follow-ups its result answers
  // and its facts (the run's, and its plugin's own aggregates') commit too.
  const post = pre ? yield* pre.after(sanitized) : [];
  const answered =
    sanitized.status === 'executed' ? (sanitized.consumedFollowUps ?? []) : [];
  const facts = factRows(extracted.facts, runId, plugin, run.session.log);
  // A retirement refused outside the run history is the claim's refusal,
  // worded as the cell words one of its own.
  yield* retireStanding.pipe(
    Effect.catchTag('DatabaseNotOwner', (refused) =>
      Effect.fail(runRefusal(runId, refused)),
    ),
  );
  yield* commit(
    call,
    [
      resultRow(
        call,
        attempt,
        {
          disposition: dispositionOf(sanitized),
          duplicateOf: null,
          result: storedResult(sanitized),
          attachments,
        },
        blobs,
      ),
      ...cards,
      ...post,
      ...answered.map((id) => consumedRow(runId, id, { kind: 'answered' })),
      ...facts.run,
    ],
    facts.alongside,
  );
});

/**
 * The door a `script` call's guest issues calls through: the same per-call
 * program, under the script's stage, which ends with `dispatched`. A resumed
 * script is handed back what its rows settled, in commit order, before any
 * call runs again; a call at a recorded `seq` that differs is a divergence.
 * Built in the call body's scope, which owns the calls the guest issues and
 * ends them (`RunCallShape.scriptCalls`).
 */
const scriptDoor = Effect.fn('toolUse.scriptDoor')(function* (
  dispatch: Dispatch,
  script: DispatchFacts,
  dispatched: Scope.Scope,
) {
  const { run, cell, step, responseId } = dispatch;
  const { runId } = run;
  const stageId = `script-${script.logId}`;
  const issued = (state: RunState) =>
    Object.values(state.pendingResponse?.records ?? {}).flatMap(
      ({ script: call, status }) =>
        call?.scriptCallId === script.callId ? [{ call, status }] : [],
    );
  // What its rows settled reaches the guest in commit order, first: each waits
  // until the guest holds the one before it; a call that runs, until the last.
  const replay = issued(yield* cell.current)
    .flatMap(({ call, status }) =>
      status.kind === 'settled' ? [[status.at, call.seq] as const] : [],
    )
    .toSorted(([a], [b]) => a - b)
    .map(([, seq]) => seq);
  const slot = (map: Map<number, Deferred.Deferred<void>>, seq: number) => {
    const made = map.get(seq) ?? Deferred.makeUnsafe<void>();
    map.set(seq, made);
    return made;
  };
  const handed = new Map<number, Deferred.Deferred<void>>();
  const handedBack = (seq: number) => {
    const at = replay.indexOf(seq);
    const before = at === -1 ? replay.at(-1) : replay[at - 1];
    return before === undefined
      ? Effect.void
      : Deferred.await(slot(handed, before));
  };
  // The calls take their places in issue order (`seq`), whatever order their
  // fibers arrive in. A barrier then follows every call placed before it, a
  // parallel or own call the last barrier; a parallel call runs under the window.
  const places = new Map<number, Deferred.Deferred<void>>();
  let barrier: Deferred.Deferred<void> | null = null;
  let since: Deferred.Deferred<void>[] = [];
  const window = yield* Semaphore.make(MAX_PARALLEL_TOOL_CALLS);
  /** Run `body` in `seq`'s place and `lane`, or only take the place (no lane). */
  const inLane = <E, R>(
    seq: number,
    lane: DispatchFacts['lane'] | null,
    body: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, E, R> =>
    Effect.gen(function* () {
      if (seq > 0) yield* Deferred.await(slot(places, seq - 1));
      const after = lane === 'barrier' ? [barrier, ...since] : [barrier];
      const done = lane === null ? null : Deferred.makeUnsafe<void>();
      if (done !== null && lane === 'barrier') [barrier, since] = [done, []];
      else if (done !== null) since.push(done);
      yield* Deferred.succeed(slot(places, seq), undefined);
      if (done !== null)
        for (const call of after)
          if (call !== null) yield* Deferred.await(call);
      // Nothing runs again until the guest holds all that settled.
      yield* handedBack(seq);
      if (done === null) return;
      // A call that did not finish (a stop, a durable write that failed)
      // lets nothing after it run: what follows it is interrupted too.
      yield* (lane === 'parallel' ? window.withPermits(1)(body) : body).pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Deferred.succeed(done, undefined)
            : Deferred.interrupt(done),
        ),
      );
    });
  yield* Effect.addFinalizer((exit) =>
    Exit.hasInterrupts(exit)
      ? Effect.void
      : Effect.flatMap(cell.current, (state) =>
          Effect.forEach(
            issued(state),
            ({ call: fact, status }) => {
              if (status.kind === 'settled') return Effect.void;
              const call: Call = { dispatch, fact, input: fact.input };
              const at = { responseId, callId: fact.callId };
              const entered = resumedAttempt(state, at, status);
              // A request the call was parked on is withdrawn with it.
              const { retireStanding } = callRequests(
                run,
                cell,
                (rows) => commit(call, rows),
                { ...at, attempt: entered.attempt },
                entered.raised,
                entered.own,
                'The script ended before this call settled.',
              );
              const reason = skippedByScriptEnd(attemptOf(status) > 0);
              return Effect.andThen(
                retireStanding,
                skipCall(call, status, reason),
              );
            },
            { discard: true },
          ),
        ).pipe(Effect.orDie),
  );
  // Made after that finalizer, so it closes first: no call the guest
  // issued still runs when the finalizer reads what it left.
  const fork = yield* FiberMap.makeRuntime<
    ProcessServices | Runs | WorkspaceFs | StorageFs,
    string
  >();
  // Opened once, labelled by the script's title, which its first call carries.
  let stageOpened = false;
  const openStage = Effect.fn('toolUse.openScriptStage')(function* (
    title: string | null,
  ) {
    if (stageOpened) return;
    stageOpened = true;
    run.session.log.publish(runId, {
      type: 'stage.start',
      id: stageId,
      label: title ?? 'Script',
      kind: 'script',
    });
    yield* Scope.addFinalizerExit(dispatched, (exit) =>
      Effect.gen(function* () {
        const settled = settlementOf(
          dispatch,
          yield* cell.current,
          script.callId,
        );
        let status: 'completed' | 'failed' | 'cancelled' =
          settled?.result.status === 'executed' ? 'completed' : 'failed';
        if (Exit.hasInterrupts(exit)) status = 'cancelled';
        run.session.log.publish(runId, {
          type: 'stage.end',
          id: stageId,
          status,
        });
      }),
    );
  });

  // What the script's calls share while it runs (`ScriptScope.shared`).
  const sharedValues = new Map<string, Deferred.Deferred<unknown, unknown>>();
  const shared = <A, E, R>(
    key: string,
    make: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.suspend(() => {
      const existing = sharedValues.get(key) as
        Deferred.Deferred<A, E> | undefined;
      if (existing !== undefined) return Deferred.await(existing);
      const made = Deferred.makeUnsafe<A, E>();
      sharedValues.set(key, made as Deferred.Deferred<unknown, unknown>);
      return make.pipe(Effect.onExit((exit) => Deferred.done(made, exit)));
    });
  const scopeOf = (source: ScriptSource): ScriptScope => ({
    ...source,
    callId: script.callId,
    calls: Effect.map(cell.current, (state) =>
      issued(state)
        .map(({ call }) => call)
        .toSorted((a, b) => a.seq - b.seq)
        .map(({ toolName, input }) => ({ toolName, input })),
    ),
    shared,
  });

  /** Settles `op`: from its rows when they settled it; else by `answer`,
   *  one of the script's host functions, recorded with no card; else by
   *  running its tool through the per-call program. */
  const settle = Effect.fn('toolUse.scriptCall')(function* (
    op: ScriptOp,
    source: ScriptSource,
    answer?: () => ToolResultPayload['result'],
  ) {
    const callId = `${script.callId}/${op.seq}`;
    yield* openStage(source.title);
    const input = toJsonValue(op.input);
    const known = recordOf(dispatch, yield* cell.current, callId);
    const recorded = known?.script;
    if (
      recorded != null &&
      !isDeepStrictEqual([recorded.toolName, recorded.input], [op.name, input])
    ) {
      return yield* new ScriptDiverged({
        seq: op.seq,
        recorded: `${recorded.toolName}(${JSON.stringify(recorded.input)})`,
        issued: `${op.name}(${JSON.stringify(input)})`,
      });
    }
    const tool = step.registry.get(op.name);
    const fact: ScriptCallPayload = recorded ?? {
      scriptCallId: script.callId,
      seq: op.seq,
      callId,
      toolName: op.name,
      input,
      replay: answer !== undefined ? 'safe' : (tool?.replay ?? 'unsafe'),
      logId: crypto.randomUUID(),
      stageId,
      phase: op.phase,
    };
    const call: Call = { dispatch, fact, input };
    if (known?.status.kind === 'settled') {
      // Replayed from its row: it takes no lane and does not run.
      yield* inLane(op.seq, null, Effect.void);
    } else if (answer !== undefined) {
      // Reads the pinned catalog only and runs no tool: no lane, one commit.
      yield* inLane(op.seq, null, Effect.void);
      const result = answer();
      yield* commitResult(call, 1, {
        disposition: dispositionOf(result),
        duplicateOf: null,
        result,
        attachments: [],
      });
    } else
      yield* inLane(
        op.seq,
        tool?.lane ?? 'barrier',
        finishCall(call, { script: scopeOf(source), scriptCalls: null }),
      );
    const settled = settlementOf(dispatch, yield* cell.current, callId);
    if (settled === null)
      return yield* Effect.die(
        new Error(`Script call ${callId} is unsettled after its run.`),
      );
    return { result: settled.result, attachments: settled.attachments };
  });
  /** Settles `op` on its own fiber of the door's map; an await the
   *  sandbox stops stops it. */
  const call = (
    op: ScriptOp,
    source: ScriptSource,
    answer?: () => ToolResultPayload['result'],
  ) =>
    Effect.suspend(() => {
      const fiber = fork(
        `${script.callId}/${op.seq}`,
        settle(op, source, answer),
      );
      return Effect.onInterrupt(Fiber.join(fiber), () =>
        Fiber.interrupt(fiber),
      );
    });
  return {
    catalog: step.definitions
      .filter(({ name }) => name !== script.toolName)
      .map((definition) => ({
        definition,
        plugin: dispatch.pluginOf.get(definition.name) ?? 'run',
      })),
    globals: step.definitions.flatMap(({ name }) => {
      const global =
        name === script.toolName
          ? undefined
          : step.registry.get(name)?.scriptGlobal;
      return global === undefined
        ? []
        : [{ tool: name, positional: global.positional }];
    }),
    modules: step.modules,
    call,
    answer: (
      op: ScriptOp,
      source: ScriptSource,
      answer: () => ToolResultPayload['result'],
    ) => Effect.map(call(op, source, answer), ({ result }) => result),
    delivered: (seq: number): Effect.Effect<void> =>
      Effect.asVoid(Deferred.succeed(slot(handed, seq), undefined)),
  } satisfies ScriptDoor;
});

/** A response's calls in the order they run: contiguous parallel calls (a
 *  duplicate among them, whatever its tool's lane) form one group that runs
 *  under the window; every other call is a group of its own, a barrier that
 *  runs alone. */
const groupsOf = (calls: readonly DispatchFacts[]): DispatchFacts[][] => {
  const barrier = (fact: DispatchFacts) =>
    fact.duplicateOf === null && fact.lane !== 'parallel';
  const groups: DispatchFacts[][] = [];
  for (const fact of calls) {
    const open = groups.at(-1);
    if (open === undefined || barrier(fact) || barrier(open[0]))
      groups.push([fact]);
    else open.push(fact);
  }
  return groups;
};

/** Delivery: the paid turn enters history once, with the complete tool
 *  group, each result as the model reads it. A queued model switch among
 *  the run's pending requests (`controls`) keeps the documents local. */
const deliver = Effect.fn('toolUse.deliver')(function* (
  dispatch: Dispatch,
  controls: Effect.Effect<readonly QueuedFollowUp[]>,
) {
  const { run, cell, responseId } = dispatch;
  const { runId, logger } = run;
  const settledState = yield* cell.current;
  const settledPending = settledState.pendingResponse;
  if (settledPending === null || settledPending.responseId !== responseId) {
    return yield* Effect.die(
      new Error('The pending response changed during dispatch.'),
    );
  }
  // A handed-down call has no model to answer it, so it ends the turn; else
  // one of the response's own calls (never a script's) may, by its result.
  const endTurn =
    settledState.handedDown !== null ||
    settledPending.calls.some(({ callId }) =>
      endsTurn(callSettlementOf(settledPending, callId)),
    );
  const bound = yield* SynchronizedRef.get(run.model);
  const media: { readonly path: string; readonly part: StoredMediaPart }[] = [];
  const results = settledPending.calls.map((fact, ordinal) => {
    const recorded = callSettlementOf(settledPending, fact.callId);
    if (recorded === null) {
      throw new Error(`Call ${fact.callId} has no result at delivery.`);
    }
    const content = resultContent(recorded, bound.config.capabilities);
    media.push(...content.media);
    return {
      callOrdinal: ordinal,
      status:
        recorded.result.status === 'executed'
          ? ('success' as const)
          : ('error' as const),
      content: [
        content.text,
        ...content.media.map(({ part }) => part),
        // What the call's hooks add, after its result.
        ...callHookText(settledState, responseId, fact.callId),
      ],
    };
  });
  // Offer each delivered document to the binding's upload cache, so requests
  // replaying this history can send a file id instead of the bytes: under the
  // parallel-call bound and one deadline that warns with the unfinished paths.
  // A batch that ends the turn, or one delivered while a model switch waits
  // (its binding never saw these ids), keeps its documents local.
  const switching =
    !endTurn && (yield* controls).some((f) => f.control?.kind === 'model');
  const documents = (endTurn || switching ? [] : media).flatMap(
    ({ path, part }) => (part.kind === 'document' ? [{ path, part }] : []),
  );
  const uploadFile =
    documents.length === 0 ? undefined : bound.model.uploadFile;
  if (uploadFile !== undefined) {
    // The documents' bytes, held by address: read once for the uploads.
    const bytes = yield* run.session.log.blobs(
      documents.map(({ part }) => part.digest),
    );
    // Settled uploads leave the set; the aggregate deadline names the rest.
    const pendingUploads = new Set(documents.map(({ path }) => path));
    yield* Effect.forEach(
      documents,
      ({ path, part }) =>
        uploadFile({
          mimeType: part.mimeType,
          filename: getBasename(path) || 'attachment',
          base64: bytes.get(part.digest) ?? '',
        }).pipe(
          Effect.catchTag('ModelError', (error) =>
            Effect.sync(() =>
              logger.warn(
                `Sending "${path}" as bytes: the provider did not accept it as an upload (${error.message}).`,
              ),
            ),
          ),
          Effect.tap(Effect.sync(() => pendingUploads.delete(path))),
        ),
      { concurrency: MAX_PARALLEL_TOOL_CALLS, discard: true },
    ).pipe(
      // The dispatch runs in the loop's uninterruptible handoff; the deadline
      // bounds the uploads only if it can interrupt them, so say so here.
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: UPLOAD_DEADLINE,
        orElse: () =>
          Effect.sync(() =>
            logger.warn(
              `Sending ${[...pendingUploads].map((path) => `"${path}"`).join(', ')} as bytes: their uploads did not finish within ${UPLOAD_DEADLINE} in all.`,
            ),
          ),
      }),
    );
  }
  const delivered = yield* cell.append((state) => [
    appendRow(runId, [{ role: 'tool', results }], {
      sourceResponse: responseId,
    }),
    positionRow(runId, state, 'results.ready'),
  ]);
  return { state: delivered, endTurn } satisfies DispatchOutcome;
});

/** Dispatch the pending response's unsettled calls under `step`'s tools,
 *  then deliver. `controls` are the run's pending requests (`FollowUps`):
 *  a queued model switch keeps the delivered documents local. */
export const dispatchPendingResponse = Effect.fn('toolUse.dispatch')(function* (
  cell: RunCell,
  step: StepTools,
  controls: Effect.Effect<readonly QueuedFollowUp[]>,
): Effect.fn.Return<
  DispatchOutcome,
  InvokeError,
  AgentRun | ProcessServices | Runs | WorkspaceFs | StorageFs
> {
  const run = yield* AgentRun;
  const { runId, logger } = run;
  const initial = yield* cell.current;
  const pending = initial.pendingResponse;
  if (pending === null) return { state: initial, endTurn: false };
  const { responseId } = pending;
  // The calls answer the instruction the committed state records.
  const at = initial.input.instruction;
  const dispatch: Dispatch = {
    run,
    cell,
    step,
    responseId,
    aggregateId: qualifyAggregateId('run', runId),
    instruction:
      run.config.rootUserInstruction ??
      (at ? stored(initial, at, Schema.String) : run.config.instruction),
    recovered:
      cell.opened.pendingResponse?.responseId === responseId &&
      pending.assistant.origin !== null,
    pluginOf: new Map(step.offered.map((t) => [t.name, t.plugin])),
  };
  const inputOf = new Map(
    localCallsOf(pending.assistant.content).map((call) => [
      call.callId,
      parseCallArguments(call, logger),
    ]),
  );
  // One call of the response, with the door its guest's calls go through.
  const finish = (fact: DispatchFacts, ended: boolean) =>
    Effect.scoped(
      Effect.flatMap(Scope.Scope, (dispatched) =>
        finishCall(
          { dispatch, fact, input: inputOf.get(fact.callId) },
          { script: null, scriptCalls: scriptDoor(dispatch, fact, dispatched) },
          ended,
        ),
      ),
    );
  // Each group in turn: its own calls together, under the window, then its
  // duplicates. A group after one that ended the turn sees that it did.
  let ended = false;
  for (const group of groupsOf(pending.calls)) {
    const endedBefore = ended;
    yield* Effect.forEach(
      group.filter((fact) => fact.duplicateOf === null),
      (fact) => finish(fact, endedBefore),
      { concurrency: MAX_PARALLEL_TOOL_CALLS, discard: true },
    );
    yield* Effect.forEach(
      group.filter((fact) => fact.duplicateOf !== null),
      (fact) => finish(fact, endedBefore),
      { discard: true },
    );
    const state = yield* cell.current;
    ended ||= group.some(({ callId }) =>
      endsTurn(settlementOf(dispatch, state, callId)),
    );
  }
  return yield* deliver(dispatch, controls);
});
