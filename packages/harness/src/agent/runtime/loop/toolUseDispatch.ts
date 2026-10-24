/**
 * Dispatch of one committed response's tool calls, from the run's state and
 * back into it. What it guarantees, by construction: contiguous parallel
 * calls run concurrently under a small window while every other call is a
 * barrier that runs alone and in order; a call repeating an earlier call's
 * name and arguments never executes and derives its primary's result; a
 * result that ends the turn stops dispatch after its partition; one
 * interrupt cancels the whole in-flight batch through the fiber; an ordinary
 * tool failure becomes a model-visible error result; and a durable write
 * failure halts dispatch, so an unfinished call is never recorded as done.
 *
 * One record per call (`PendingCall`), whichever issued it: the response, or
 * a guest of one of its `script` calls. Its rows are its only facts: the
 * `script.call` that issues a script's call commits with the call's first
 * row; its requests, under ids the attempt derives (`callRequestId`);
 * `tool.intent` as the body starts, after the PreToolUse hooks, the
 * guard and its approval, with a slow tool's card; `tool.result` with its
 * card's close; and the delivering `append` with the complete tool group
 * once, when every call of the response has its result. One scheduler
 * places both origins' calls.
 *
 * Resume reads only row data: a call with a result keeps it; a duplicate
 * derives its primary; a call whose body never started re-enters what it
 * asked (untouched in a recovered response: reported not started); one whose
 * body started re-runs when `replayable` says so, else "outcome unknown".
 */
import { isDeepStrictEqual } from 'node:util';

import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Ref,
  type Scope,
  Semaphore,
  SynchronizedRef,
} from 'effect';
import { z } from 'zod';

import { normalizeToolCallError } from '@agent/core/tools/toolCallParsing';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import {
  ChildRuns,
  childRuns,
  type RuntimeTool as ITool,
} from '@agent/runtime/ToolServices';
import { ToolContext } from '@agent/core/tools/ToolTypes';
import {
  RunCall,
  ScriptDiverged,
  type RunCallShape,
  type ScriptDoor,
  type ScriptScope,
  type ScriptSource,
} from '@agent/runtime/RunCall';
import type { AgentTrace } from '@agent/trace';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import {
  type DispatchFacts,
  type FileListEntry,
  type ScriptCallPayload,
  type ToolCallStatus,
  type StoredMediaPart,
  type ToolResult,
  type ToolResultPayload,
} from '@shared/schemas';
import type { DraftBlob } from '@shared/session/historyTurns';
import { JsonValueSchema, toJsonValue } from '@shared/schemas';
import { findStorageRefusal, runRefusal } from '@shared/session/runHistory';
import { type RunHistoryDraft, type RunState } from '@shared/session/runState';
import {
  attemptOf,
  callSettlementOf,
  resumedAttempt,
  type CallResult,
  type ResumedAttempt,
  type CallStatus,
  type PendingCall,
} from '@shared/session/inFlight';
import type { RunCell } from '@shared/session/runHistory';
import { checkOwnFacts, factRows } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';
import { generateShortId, getBasename } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

import { AgentRun } from '../run/AgentRun';
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
  SKIPPED_OUTCOME_UNKNOWN,
  SKIPPED_SCRIPT_ENDED,
} from '../run/tools';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '../run/toolResultText';
import { callRequests, guardedToolCall } from './toolGuard';
import { callHookText, preToolUse } from './hooks';
import {
  appendRow,
  displayRow,
  rowAggregate,
  positionRow,
  type Message,
} from './rows';
import { Runs } from '../runRegistry';
import type { StepTools } from './step';
import type { JoinedFollowUps } from '../FollowUps';
import type { InvokeError } from '../ModelInvoker';

/** Max concurrently executing parallel tool calls. */
const MAX_PARALLEL_TOOL_CALLS = 4;

/** How much of a running tool's output streams to its card as transient
 *  text; the result carries the bounded capture whatever streamed. */
const STREAMED_OUTPUT_MAX = 50_000;

/** What the per-call program needs of a call, whichever origin issued it:
 *  a response's dispatch fact, or a script's `script.call`, which commits
 *  with the call's first row. */
type CallFacts =
  | Pick<DispatchFacts, 'callId' | 'toolName' | 'replay' | 'logId'>
  | ScriptCallPayload;

/** The `script.call` a call carries, or null for a response's own. */
const scriptOf = (fact: CallFacts): ScriptCallPayload | null =>
  'scriptCallId' in fact ? fact : null;

interface DispatchOutcome {
  readonly state: RunState;
  /** A call's result asked to end the turn. */
  readonly endTurn: boolean;
}

/** A sanitized result as the run history stores it: `diagnostics` narrowed
 *  to JSON. The sanitizer left the validation-error shape or nothing, so a
 *  non-JSON value here is a defect, refused rather than stored. */
function storedResult(result: ToolResult): CallResult['result'] {
  const { diagnostics, ...rest } = result;
  if (rest.status === 'executed') delete rest.consumedFollowUps; // own rows
  if (diagnostics === undefined) return rest;
  return { ...rest, diagnostics: JsonValueSchema.parse(diagnostics) };
}

/** A duplicate's copy of its primary's result: no edits, no files. */
const withoutEffects = (result: CallResult['result']): CallResult['result'] => {
  if (result.status !== 'executed') return result;
  const { edits: _edits, files: _files, ...rest } = result;
  return rest;
};

const endsTurn = (recorded: Pick<CallResult, 'result'> | null): boolean =>
  recorded?.result.status === 'executed' && recorded.result.endTurn === true;

/** How long delivery waits on the provider to take one upload: an
 *  optimisation for later rounds, so a stalled files endpoint costs delivery
 *  no more than this; the bytes are delivered either way. */
const UPLOAD_DEADLINE = '5 seconds';

/** The model-visible content of one call's result: text, then inline media,
 *  each with its attachment's path. The run history keeps the bytes; whether
 *  a later request sends them or a file id is the bound model's upload
 *  cache's decision. An attachment the binding cannot carry inline (a PDF on
 *  a route without PDF support, an image on a text-only route) reaches the
 *  model as the text mention only, and the transcript says so. */
function resultContent(
  recorded: Pick<CallResult, 'result' | 'attachments'>,
  capabilities: Parameters<typeof storedMediaPart>[2],
  logger: AgentTrace,
): {
  readonly text: InputPart;
  readonly media: readonly {
    readonly path: string;
    readonly part: StoredMediaPart;
  }[];
} {
  const text = formatToolResultAsText(
    recorded.result,
    recorded.attachments.length > 0
      ? formatAttachmentSummary(recorded.attachments)
      : undefined,
  );
  const media = recorded.attachments.flatMap((attachment) => {
    if (attachment.content.kind !== 'stored') {
      logger.warn(
        `The model receives "${attachment.path}" as a mention only: its bytes were not captured (${attachment.content.reason}).`,
      );
      return [];
    }
    const part = storedMediaPart(
      attachment.mimeType,
      attachment.content.digest,
      capabilities,
    );
    if (part === null) {
      logger.warn(
        `The model receives "${attachment.path}" as a mention only: the bound model carries no ${attachment.mimeType} attachment inline.`,
      );
      return [];
    }
    return [{ path: attachment.path, part }];
  });
  return { text: { kind: 'text', text }, media };
}

/** A response call's lane: its tool's (`ITool.lane`) when parallel, else a
 *  barrier; a duplicate's `'own'` (it only waits for its primary). */
const responseLane = (fact: DispatchFacts): DispatchFacts['lane'] => {
  if (fact.duplicateOf !== null) return 'own';
  return fact.lane === 'parallel' ? 'parallel' : 'barrier';
};

/** The one scheduler, for a response's calls and a script's guest's alike:
 *  calls take their places in issue order (`seq`), whatever order their
 *  fibers arrive in, and a call after a partition that ended the turn sees
 *  that it did while its own partition does not. */
const makeScheduler = Effect.gen(function* () {
  const taken = new Map<number, Deferred.Deferred<void>>();
  const finished = new Map<number, Deferred.Deferred<boolean>>();
  const slot = <A>(map: Map<number, Deferred.Deferred<A>>, seq: number) => {
    const existing = map.get(seq);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<A>();
    map.set(seq, created);
    return created;
  };
  const lanes = yield* Ref.make<{
    readonly barrier: Deferred.Deferred<boolean> | null;
    readonly since: readonly Deferred.Deferred<boolean>[];
  }>({ barrier: null, since: [] });
  const window = yield* Semaphore.make(MAX_PARALLEL_TOOL_CALLS);
  /** Until the call issued before `seq` has taken its place. */
  const turn = (seq: number): Effect.Effect<void> =>
    seq === 0 ? Effect.void : Deferred.await(slot(taken, seq - 1));
  return {
    turn,
    /** Take `seq`'s place with no lane: a call that runs nothing. */
    pass: (seq: number): Effect.Effect<void> =>
      turn(seq).pipe(
        Effect.andThen(Deferred.succeed(slot(finished, seq), false)),
        Effect.andThen(Deferred.succeed(slot(taken, seq), undefined)),
        Effect.asVoid,
      ),
    /** Whether `seq` (or a call it waited for) ended the turn, once done. */
    finished: (seq: number): Effect.Effect<boolean> =>
      Deferred.await(slot(finished, seq)),
    /** Take `seq`'s place in `lane` and run `body` once the calls it
     *  follows are done; `body` answers whether this call ended the turn. */
    run: <E, R>(
      seq: number,
      lane: DispatchFacts['lane'],
      body: (endedBefore: boolean) => Effect.Effect<boolean, E, R>,
    ): Effect.Effect<void, E, R> =>
      Effect.gen(function* () {
        yield* turn(seq);
        const done = slot(finished, seq);
        const after = yield* Ref.modify(lanes, (placed) =>
          lane === 'barrier'
            ? [[placed.barrier, ...placed.since], { barrier: done, since: [] }]
            : [[placed.barrier], { ...placed, since: [...placed.since, done] }],
        );
        yield* Deferred.succeed(slot(taken, seq), undefined);
        let endedBefore = false;
        for (const call of after)
          if (call !== null && (yield* Deferred.await(call)))
            endedBefore = true;
        const ran =
          lane === 'parallel'
            ? window.withPermits(1)(body(endedBefore))
            : body(endedBefore);
        // A call that did not finish (a stop, a durable write that failed)
        // lets nothing after it run: what follows it is interrupted too.
        yield* ran.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Deferred.succeed(done, endedBefore || exit.value)
              : Deferred.interrupt(done),
          ),
        );
      }),
  };
});

/** Dispatch the pending response's unsettled calls under `step`'s tools,
 *  then deliver, with the `joined` rows and what they record. */
export const dispatchPendingResponse = Effect.fn('toolUse.dispatch')(function* (
  cell: RunCell,
  step: StepTools,
  joined?: Pick<JoinedFollowUps, 'rows'> | null,
): Effect.fn.Return<
  DispatchOutcome,
  InvokeError,
  AgentRun | ProcessServices | Runs | WorkspaceFs | StorageFs
> {
  const run = yield* AgentRun;
  const { runId, logger } = run;
  const aggregateId = rowAggregate(runId);
  const initial = yield* cell.current;
  const pending = initial.pendingResponse;
  if (pending === null) return { state: initial, endTurn: false };
  const { responseId } = pending;
  // A stored call nothing of which ran is reported, not run, unless it was
  // handed down (no model to report to).
  const replan =
    cell.opened.pendingResponse?.responseId === responseId &&
    pending.assistant.origin !== null;
  const calls = localCallsOf(pending.assistant.content);
  const { entries } = yield* ToolRegistry;
  const pluginOf = new Map(step.offered.map((t) => [t.name, t.plugin]));
  // The calls answer the instruction the committed state records.
  const at = initial.input.instruction;
  const userInstruction =
    run.config.rootUserInstruction ??
    (at ? stored(initial, at, z.string()) : run.config.instruction);
  // Concurrent results of one parallel partition commit one at a time under
  // the cell's lock, each onto the latest state.
  const { append } = cell;
  const recordOf = (state: RunState, callId: string): PendingCall | null =>
    state.pendingResponse?.responseId === responseId
      ? (state.pendingResponse.records[callId] ?? null)
      : null;
  const resultOf = (state: RunState, callId: string) =>
    state.pendingResponse?.responseId === responseId
      ? callSettlementOf(state.pendingResponse, callId)
      : null;
  const startedAt = (state: RunState, callId: string, attempt: number) => {
    const status = recordOf(state, callId)?.status;
    return status?.kind === 'started' && status.attempt === attempt;
  };

  /** Commit rows of `fact`'s call, its `script.call` first while the run
   *  holds no record of the call: a script's call exists from its first
   *  row, whichever that is. */
  const commit = (
    fact: CallFacts,
    rows:
      | readonly RunHistoryDraft[]
      | ((state: RunState) => readonly RunHistoryDraft[]),
    alongside?: ReturnType<typeof factRows>['alongside'],
  ) =>
    append((state) => {
      const own = typeof rows === 'function' ? rows(state) : rows;
      const script = scriptOf(fact);
      return script !== null && recordOf(state, fact.callId) === null
        ? [{ type: 'script.call', aggregateId, payload: script }, ...own]
        : own;
    }, alongside);

  const commitResult = (
    fact: CallFacts,
    attempt: number,
    result: Omit<CallResult, 'attempt'>,
    cards: (state: RunState) => readonly RunHistoryDraft[] = () => [],
    alongside?: ReturnType<typeof factRows>['alongside'],
    /** The attachment bytes the result's row stores or links. */
    blobs: readonly DraftBlob[] = [],
  ) =>
    commit(
      fact,
      (state) => [
        {
          type: 'tool.result',
          aggregateId,
          payload: {
            responseId,
            callId: fact.callId,
            attempt,
            ...result,
          },
          ...(blobs.length > 0 && { blobs }),
        },
        ...cards(state),
      ],
      alongside,
    );

  const toolOf = (fact: CallFacts) => step.registry.get(fact.toolName);
  /** The row that opens a call's card: a slow tool's commits with the
   *  intent its body starts with, so a resume finds the card its result
   *  closes; a fast tool's rides the result's batch itself. */
  const cardStart = (
    fact: CallFacts,
    input: unknown,
    attempt: number,
  ): RunHistoryDraft => {
    const script = scriptOf(fact);
    return displayRow(runId, {
      type: 'tool.start',
      logId: fact.logId,
      toolName: fact.toolName,
      input: toJsonValue(input),
      card: toolOf(fact)?.definition.card?.(input),
      ...(script?.phase != null ? { phase: script.phase } : {}),
      ...(attempt > 1 ? { attempt } : {}),
      ...(script !== null ? { stageId: script.stageId } : {}),
    });
  };
  /** The card rows a result commits: a card its attempt's body opened
   *  only closes, any other opens and closes in the same batch. The card
   *  stores no output: a read projects it from the `tool.result` the batch
   *  commits (`rowCodec.ts`). */
  const resultCards = (
    fact: CallFacts,
    input: unknown,
    status: ToolCallStatus,
    attempt: number,
    files: readonly FileListEntry[] = [],
  ) => {
    const script = scriptOf(fact);
    return (state: RunState): RunHistoryDraft[] => [
      ...(toolOf(fact)?.slow && startedAt(state, fact.callId, attempt)
        ? []
        : [cardStart(fact, input, attempt)]),
      displayRow(runId, {
        type: 'tool.end',
        logId: fact.logId,
        status,
        ...(files.length > 0 ? { files: [...files] } : {}),
        ...(script !== null ? { stageId: script.stageId } : {}),
      }),
    ];
  };

  /** The row that says `fact`'s body starts `attempt`. */
  const intentRow = (fact: CallFacts, attempt: number): RunHistoryDraft => {
    const script = scriptOf(fact);
    return {
      type: 'tool.intent',
      aggregateId,
      payload: {
        origin:
          script === null
            ? { kind: 'response', responseId }
            : { kind: 'script', scriptCallId: script.scriptCallId },
        callId: fact.callId,
        attempt,
      },
    };
  };

  const skippedResult = (error: string): Omit<CallResult, 'attempt'> => ({
    disposition: 'skipped',
    duplicateOf: null,
    result: { status: 'error', error },
    attachments: [],
  });

  /** Settle a call that has no result as skipped for `reason`, closing the
   *  card its attempt opened; a call that never started opened none. */
  const skipCall = (
    fact: CallFacts,
    input: unknown,
    status: Exclude<CallStatus, { kind: 'settled' }>,
    reason: string,
  ) => {
    const reached = attemptOf(status);
    return commitResult(
      fact,
      Math.max(1, reached),
      skippedResult(reason),
      reached === 0 ? undefined : resultCards(fact, input, 'failed', reached),
    );
  };

  /** Execute one call at `attempt` and commit its result, re-entering the
   *  request a resumed attempt left standing (`own`); `place` is the script
   *  that issued it, or the door a `script` call issues its own through. A
   *  throwing tool is an error result; interruption leaves no result. */
  const execute = Effect.fn('toolUse.executeCall')(function* (
    fact: CallFacts,
    parsedInput: unknown,
    { attempt, raised, own: standing }: ResumedAttempt,
    place: Pick<RunCallShape, 'script' | 'scriptCalls'>,
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs | FileSystem.FileSystem
  > {
    const tool: ITool | undefined = step.registry.get(fact.toolName);
    const stageId = scriptOf(fact)?.stageId;
    // A slow tool's card opens as its body starts; what the tool prints
    // streams to it as transient text, capped, never a row, and refused once
    // the call has returned, so nothing lands after the card's close.
    let accepting = false;
    let streamed = 0;
    const onToolOutput = (chunk: string): void => {
      if (!accepting) return;
      const text = chunk.slice(0, STREAMED_OUTPUT_MAX - streamed);
      if (text.length === 0) return;
      streamed += text.length;
      run.session.log.publish(runId, {
        type: 'stream.chunk',
        id: fact.logId,
        text,
        ...(stageId !== undefined ? { stageId } : {}),
      });
    };
    const { requests, retireStanding } = callRequests(
      run,
      cell,
      (rows) => commit(fact, rows),
      { responseId, callId: fact.callId, attempt },
      raised,
      standing,
      'The resumed call no longer asks it.',
    );
    // Its step's PreToolUse hooks, recorded before the approval and the body.
    const pre =
      tool &&
      (yield* preToolUse(run, cell, step, fact, responseId, parsedInput));
    if (pre && pre.rows.length > 0) yield* commit(fact, pre.rows);
    let result: ToolResult;
    if (pre && pre.denied !== null) {
      result = pre.denied;
    } else if (!tool || !pre) {
      result = {
        status: 'error',
        error: `tool_unavailable: the tool "${fact.toolName}" is not available in this run. Continue with the tools you were offered.`,
        diagnostics: { code: 'tool_unavailable', tool: fact.toolName },
      };
    } else {
      // From here the call may have run: its intent commits now, with a slow
      // tool's card, unless this attempt's body already started (a re-entry).
      const bodyStarts = Effect.gen(function* () {
        if (!startedAt(yield* cell.current, fact.callId, attempt))
          yield* commit(fact, [
            intentRow(fact, attempt),
            ...(tool.slow ? [cardStart(fact, parsedInput, attempt)] : []),
          ]);
        accepting = tool.slow === true;
        yield* pre.bodyStarts;
      });
      // This call's place in its run, and the child door over exactly it.
      const runCall: RunCallShape = {
        run,
        responseId,
        instruction: userInstruction,
        attempt,
        logId: fact.logId,
        ...place,
      };
      // Guard first, under the step's roots and plugin services: a refused
      // path or unapproved command settles the call without the body running.
      const invoked = yield* Effect.exit(
        Effect.scoped(
          guardedToolCall(tool, parsedInput, bodyStarts).pipe(
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
        // A finalizer may also have failed while cancellation drained a write.
        // Preserve that cause instead of replacing it with a bare interrupt.
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
        if (refused) return yield* Effect.fail(runRefusal(runId, refused));
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
    const plugin = entries.get(pluginOf.get(fact.toolName) ?? '');
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
    const edited = new Set(
      result.status === 'executed'
        ? (result.edits ?? []).flatMap(({ path }) => (path ? [path] : []))
        : [],
    );
    const editedFiles = [...edited].map((path) => ({
      path,
      ok: true,
      source: 'tool',
      sourceDisplay: 'Tool use',
    }));
    const { attachments, blobs } = yield* captureAttachments(
      extracted.attachments,
      run.session.roots.workspace,
    );
    const status: ToolCallStatus =
      extracted.sanitizedResult.status === 'error' ? 'failed' : 'completed';
    // The whole card commits with the result (a slow tool's closes here,
    // a fast tool's opens and closes here): a terminal card outside the batch
    // would show the call completed while recovery sees it unfinished.
    const cards = resultCards(fact, parsedInput, status, attempt, editedFiles);
    // An executed call's PostToolUse rows, the follow-ups its result answers
    // and its facts (the run's, and its plugin's own aggregates') commit too.
    const post = pre ? yield* pre.after(extracted.sanitizedResult) : [];
    const answered =
      extracted.sanitizedResult.status === 'executed'
        ? (extracted.sanitizedResult.consumedFollowUps ?? [])
        : [];
    const facts = factRows(extracted.facts, runId, plugin, run.session.log);
    yield* retireStanding;
    yield* commitResult(
      fact,
      attempt,
      {
        disposition:
          extracted.sanitizedResult.status === 'executed'
            ? 'executed'
            : 'failed',
        duplicateOf: null,
        result: storedResult(extracted.sanitizedResult),
        attachments,
      },
      (state) => [
        ...cards(state),
        ...post,
        ...answered.map((followUpId) => ({
          type: 'followup.consumed' as const,
          aggregateId,
          followUpId,
        })),
        ...facts.run,
      ],
      facts.alongside,
      blobs,
    );
  });

  /** A call with no result yet, continued at its `resumedAttempt`: untouched
   *  in a recovered response it is reported not started; else it re-runs if
   *  its replay rule allows, or settles "outcome unknown", closing its card. */
  const resumeCall = Effect.fn('toolUse.resumeCall')(function* (
    fact: CallFacts,
    input: unknown,
    status: Exclude<CallStatus, { kind: 'settled' }>,
    place: Pick<RunCallShape, 'script' | 'scriptCalls'>,
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs
  > {
    const at = { responseId, callId: fact.callId };
    const entered = resumedAttempt(yield* cell.current, at, status);
    const untouched = status.kind === 'issued' && entered.raised === 0;
    if (untouched && replan && scriptOf(fact) === null)
      yield* skipCall(fact, input, status, SKIPPED_NOT_STARTED);
    else if (
      !entered.mayHaveRun ||
      (yield* replayable(fact, step.registry, input, logger))
    )
      yield* execute(fact, input, entered, place);
    else yield* skipCall(fact, input, status, SKIPPED_OUTCOME_UNKNOWN);
  });

  /** The door a `script` call's guest issues calls through: the same per-call
   *  program and scheduler, under the script's stage. A resumed script is
   *  handed back what its rows settled, in commit order, before any call
   *  runs again; a call at a recorded `seq` that differs is a divergence. */
  const scriptCallsOf = Effect.fn('toolUse.scriptCalls')(function* (
    script: DispatchFacts,
  ) {
    const services = yield* Effect.context<
      | ProcessServices
      | Runs
      | WorkspaceFs
      | StorageFs
      | FileSystem.FileSystem
      | Scope.Scope
    >();
    // Built on first use: a call that issues none allocates nothing.
    const door = yield* Effect.cached(
      Effect.gen(function* () {
        const stageId = `script-${script.logId}`;
        const issued = (state: RunState) =>
          Object.values(state.pendingResponse?.records ?? {}).flatMap(
            ({ script: call, status }) =>
              call?.scriptCallId === script.callId ? [{ call, status }] : [],
          );
        // The settled calls, in the order their settlements committed: each
        // is handed back once the one before it reached the guest.
        const replayOrder = issued(yield* cell.current)
          .flatMap(({ call, status }) =>
            status.kind === 'settled' ? [[status.at, call.seq] as const] : [],
          )
          .toSorted(([a], [b]) => a - b)
          .map(([, seq]) => seq);
        const delivered = new Map(
          replayOrder.map((seq) => [seq, Deferred.makeUnsafe<void>()]),
        );
        const handedBack = (seq: number | undefined) => {
          const done = seq === undefined ? undefined : delivered.get(seq);
          return done === undefined ? Effect.void : Deferred.await(done);
        };
        const lanes = yield* makeScheduler;
        const stageOpened = yield* Ref.make(false);
        // Labelled by the script's title, which its first call carries.
        const openStage = Effect.fn('toolUse.openScriptStage')(function* (
          title: string | null,
        ) {
          if (yield* Ref.getAndSet(stageOpened, true)) return;
          run.session.log.publish(runId, {
            type: 'stage.start',
            id: stageId,
            label: title ?? 'Script',
            kind: 'script',
          });
        });
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(stageOpened))) return;
            const settled = resultOf(yield* cell.current, script.callId);
            let status: 'completed' | 'failed' | 'cancelled' =
              settled?.result.status === 'executed' ? 'completed' : 'failed';
            if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
              status = 'cancelled';
            run.session.log.publish(runId, {
              type: 'stage.end',
              id: stageId,
              status,
            });
          }),
        );

        // What the script's calls share while it runs here
        // (`ScriptScope.shared`).
        const sharedValues = new Map<
          string,
          Deferred.Deferred<unknown, unknown>
        >();
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
            return make.pipe(
              Effect.onExit((exit) => Deferred.done(made, exit)),
            );
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
        const call = Effect.fn('toolUse.scriptCall')(function* (
          op: ScriptOp,
          source: ScriptSource,
          answer?: () => ToolResultPayload['result'],
        ) {
          const callId = `${script.callId}/${op.seq}`;
          yield* lanes.turn(op.seq);
          yield* openStage(source.title);
          const input = toJsonValue(op.input);
          const known = recordOf(yield* cell.current, callId);
          const recorded = known?.script ?? null;
          if (
            recorded !== null &&
            (recorded.toolName !== op.name ||
              !isDeepStrictEqual(recorded.input, input))
          ) {
            return yield* new ScriptDiverged({
              seq: op.seq,
              recorded: `${recorded.toolName}(${JSON.stringify(recorded.input)})`,
              issued: `${op.name}(${JSON.stringify(input)})`,
            });
          }
          if (known?.status.kind === 'settled') {
            // Replayed from its row: it takes no lane and does not run.
            yield* lanes.pass(op.seq);
            yield* handedBack(replayOrder[replayOrder.indexOf(op.seq) - 1]);
            return {
              result: known.status.result,
              attachments: known.status.attachments,
            };
          }
          const tool = step.registry.get(op.name);
          const fact: ScriptCallPayload = recorded ?? {
            scriptCallId: script.callId,
            seq: op.seq,
            callId,
            toolName: op.name,
            input,
            replay: answer !== undefined ? 'safe' : (tool?.replay ?? 'unsafe'),
            logId: generateShortId(),
            stageId,
            phase: op.phase,
          };
          if (answer !== undefined) {
            // It reads the pinned catalog only, and runs no tool: it takes no
            // lane, and commits whole, in one batch.
            yield* lanes.pass(op.seq);
            yield* handedBack(replayOrder.at(-1));
            const result = answer();
            yield* commitResult(fact, 1, {
              disposition: result.status === 'executed' ? 'executed' : 'failed',
              duplicateOf: null,
              result,
              attachments: [],
            });
            return { result, attachments: [] };
          }
          yield* lanes.run(op.seq, tool?.lane ?? 'barrier', () =>
            Effect.gen(function* () {
              // Nothing runs again until the guest holds everything that
              // settled.
              yield* handedBack(replayOrder.at(-1));
              const status = recordOf(yield* cell.current, callId)?.status;
              if (status?.kind !== 'settled')
                yield* resumeCall(fact, input, status ?? { kind: 'issued' }, {
                  script: scopeOf(source),
                  scriptCalls: null,
                });
              // A script's calls are not the response's: its own result
              // says whether one of them ended the turn.
              return false;
            }),
          );
          const settledNow = resultOf(yield* cell.current, callId);
          if (settledNow === null) {
            return yield* Effect.die(
              new Error(`Script call ${callId} is unsettled after its run.`),
            );
          }
          return {
            result: settledNow.result,
            attachments: settledNow.attachments,
          };
        });
        return {
          catalog: step.definitions
            .filter(({ name }) => name !== script.toolName)
            .map((definition) => ({
              definition,
              plugin: pluginOf.get(definition.name) ?? 'run',
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
          call: (op: ScriptOp, source: ScriptSource) =>
            call(op, source).pipe(Effect.provideContext(services)),
          answer: (
            op: ScriptOp,
            source: ScriptSource,
            answer: () => ToolResultPayload['result'],
          ) =>
            call(op, source, answer).pipe(
              Effect.map(({ result }) => result),
              Effect.provideContext(services),
            ),
          delivered: (seq: number) => {
            const done = delivered.get(seq);
            return done === undefined
              ? Effect.void
              : Deferred.succeed(done, undefined).pipe(Effect.asVoid);
          },
          // A call the guest never awaited to its end: skipped, card closed.
          settleAbandoned: Effect.flatMap(cell.current, (state) =>
            Effect.forEach(
              issued(state),
              ({ call: fact, status }) => {
                if (status.kind === 'settled') return Effect.void;
                const at = { responseId, callId: fact.callId };
                const entered = resumedAttempt(state, at, status);
                // A request the call was parked on is withdrawn with it.
                return callRequests(
                  run,
                  cell,
                  (rows) => commit(fact, rows),
                  { ...at, attempt: entered.attempt },
                  entered.raised,
                  entered.own,
                  'The script ended before this call settled.',
                ).retireStanding.pipe(
                  Effect.andThen(
                    skipCall(fact, fact.input, status, SKIPPED_SCRIPT_ENDED),
                  ),
                );
              },
              { discard: true },
            ),
          ).pipe(Effect.provideContext(services)),
        } satisfies ScriptDoor;
      }).pipe(Effect.provideContext(services)),
    );
    return door;
  });

  const lanes = yield* makeScheduler;
  const ordinalOf = new Map(pending.calls.map((f, i) => [f.callId, i]));

  /** One call of the response, in its place: a duplicate derives its
   *  primary, effects stripped, once the primary is done (and waits with
   *  it when it never settled); a call after one that ended the turn is
   *  skipped; any other runs, or continues as its rows left it. Answers
   *  whether its settlement ended the turn. */
  const responseCall = Effect.fn('toolUse.responseCall')(function* (
    fact: DispatchFacts,
    ordinal: number,
    endedBefore: boolean,
  ): Effect.fn.Return<
    boolean,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs | FileSystem.FileSystem
  > {
    const status = recordOf(yield* cell.current, fact.callId)?.status;
    const call = calls[ordinal];
    const primaryAt =
      fact.duplicateOf === null ? null : ordinalOf.get(fact.duplicateOf);
    if (status === undefined || call === undefined || primaryAt === undefined)
      return yield* Effect.die(
        new Error(`${fact.callId} is not a call of its response as stored`),
      );
    const attempt = Math.max(1, attemptOf(status));
    if (status.kind === 'settled') {
      // Settled before: nothing to do.
    } else if (fact.duplicateOf !== null && primaryAt !== null) {
      yield* lanes.finished(primaryAt);
      const primary = resultOf(yield* cell.current, fact.duplicateOf);
      if (primary !== null)
        yield* commitResult(fact, attempt, {
          disposition: 'duplicate',
          duplicateOf: fact.duplicateOf,
          result: withoutEffects(primary.result),
          attachments: [],
        });
    } else if (endedBefore) {
      yield* commitResult(fact, attempt, skippedResult(SKIPPED_AFTER_END_TURN));
    } else {
      const input = parseCallArguments(call, logger);
      yield* Effect.scoped(
        Effect.flatMap(scriptCallsOf(fact), (door) =>
          resumeCall(fact, input, status, { script: null, scriptCalls: door }),
        ),
      );
    }
    return endsTurn(resultOf(yield* cell.current, fact.callId));
  });

  yield* Effect.forEach(
    pending.calls,
    (fact, ordinal) =>
      lanes.run(ordinal, responseLane(fact), (endedBefore) =>
        responseCall(fact, ordinal, endedBefore),
      ),
    { concurrency: 'unbounded', discard: true },
  );

  // Delivery: the paid turn enters history once, with the complete group.
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
    const content = resultContent(recorded, bound.config.capabilities, logger);
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
  // A batch that ends the turn, or one delivered while a queued model switch
  // waits (its binding never saw these ids), keeps its documents local.
  const switching =
    !endTurn &&
    (yield* run.session.followUps.read(run.runId)).followUps.some(
      (f) => f.control?.kind === 'model',
    );
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
      // The dispatch runs inside the loop's uninterruptible handoff; the
      // aggregate deadline only bounds the uploads if it can interrupt
      // them, so say it here rather than depend on how the race forks.
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
  const group: Message = { role: 'tool', results };
  const delivered = yield* cell.append((state) => [
    appendRow(runId, [group], { sourceResponse: responseId }),
    ...(joined?.rows ?? []),
    positionRow(runId, state, 'results.ready'),
  ]);
  return { state: delivered, endTurn };
});
