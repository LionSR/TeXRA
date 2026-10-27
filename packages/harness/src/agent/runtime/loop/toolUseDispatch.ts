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
 * One record per call (`PendingCall`), whichever issued it: the response, or a
 * guest of one of its `script` calls. Its rows are its only facts: the
 * `script.call` that issues a script's call commits with the call's first row;
 * its requests, under ids the attempt derives (`callRequestId`); `tool.intent`
 * as the body starts, after the PreToolUse hooks, the guard and its approval,
 * with a slow tool's card; `tool.result` with its card's close; and the
 * delivering `append` with the complete tool group once, when every call of the
 * response has its result. One scheduler places both origins' calls.
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
  Schema,
  type Scope,
  Semaphore,
  SynchronizedRef,
} from 'effect';

import { normalizeToolCallError } from '@agent/core/tools/toolCallParsing';
import { extractToolAttachments } from '@agent/core/tools/toolAttachmentExtraction';
import type { ScriptOp } from '@agent/codeSandbox/codeSandbox';
import {
  ChildRuns,
  childRuns,
  type RuntimeTool,
} from '@agent/runtime/ToolServices';
import { ToolContext, type CallRequests } from '@agent/core/tools/ToolTypes';
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
import { SettledToolResultSchema, toJsonValue } from '@shared/schemas';
import { findStorageRefusal, runRefusal } from '@shared/session/runHistory';
import { consumedRow } from '@shared/session/runFacts';
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
import type { QueuedFollowUp } from '@shared/session/runRows';
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
  skippedByScriptEnd,
} from '../run/tools';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '../run/toolResultText';
import { callRequests, guardedToolCall } from './toolGuard';
import { callHookText, preToolUse } from './hooks';
import {
  appendRow,
  cardEndRow,
  cardStartRow,
  intentRow,
  positionRow,
  scriptCallRow,
  scriptOf,
  toolResultRow,
  type CallFacts,
  type Message,
} from './rows';
import { Runs } from '../runRegistry';
import type { StepTools } from './step';
import type { InvokeError } from '../ModelInvoker';

/** Max concurrently executing parallel tool calls. */
const MAX_PARALLEL_TOOL_CALLS = 4;

/** How much of a running tool's output streams to its card as transient
 *  text; the result carries the bounded capture whatever streamed. */
const STREAMED_OUTPUT_MAX = 50_000;

interface DispatchOutcome {
  readonly state: RunState;
  /** A call's result asked to end the turn. */
  readonly endTurn: boolean;
}

/** A sanitized result as the run history stores it: `consumedFollowUps`
 *  (own rows) and `facts` dropped, `files` without their bytes and
 *  `diagnostics` narrowed to JSON. The sanitizer left the validation-error
 *  shape or nothing, so a non-JSON value here is a defect, refused rather
 *  than stored. */
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

/** A resumed script's divergence at `op`: a call other than the one its
 *  rows record at that seq; null when it issued what they record, or they
 *  record none there. */
const divergence = (
  recorded: ScriptCallPayload | null,
  op: ScriptOp,
  input: unknown,
): ScriptDiverged | null =>
  recorded === null ||
  (recorded.toolName === op.name && isDeepStrictEqual(recorded.input, input))
    ? null
    : new ScriptDiverged({
        seq: op.seq,
        recorded: `${recorded.toolName}(${JSON.stringify(recorded.input)})`,
        issued: `${op.name}(${JSON.stringify(input)})`,
      });

/** The calls script `scriptCallId` has issued, as the run records them. */
const issuedBy = (state: RunState, scriptCallId: string) =>
  Object.values(state.pendingResponse?.records ?? {}).flatMap(
    ({ script: call, status }) =>
      call?.scriptCallId === scriptCallId ? [{ call, status }] : [],
  );

/** What one script's calls share while it runs (`ScriptScope.shared`). */
const sharedValues = (): ScriptScope['shared'] => {
  const values = new Map<string, Deferred.Deferred<unknown, unknown>>();
  return <A, E, R>(key: string, make: Effect.Effect<A, E, R>) =>
    Effect.suspend((): Effect.Effect<A, E, R> => {
      // One map holds every key's value; each key is asked for at the type
      // its first caller made it at (the `ScriptScope.shared` contract).
      // cast: no map type carries a value type per key.
      const existing = values.get(key) as Deferred.Deferred<A, E> | undefined;
      if (existing !== undefined) return Deferred.await(existing);
      const made = Deferred.makeUnsafe<A, E>();
      values.set(key, made as Deferred.Deferred<unknown, unknown>); // cast: erased the same way
      return make.pipe(Effect.onExit((exit) => Deferred.done(made, exit)));
    });
};

/** The tools a script's guest may call (`ScriptDoor`): the step's, less
 *  the `script` tool itself, each with its plugin, the script globals among
 *  them, and the step's modules. */
const scriptCatalog = (
  step: StepTools,
  scriptTool: string,
  pluginOf: ReadonlyMap<string, string>,
): Pick<ScriptDoor, 'catalog' | 'globals' | 'modules'> => ({
  catalog: step.definitions
    .filter(({ name }) => name !== scriptTool)
    .map((definition) => ({
      definition,
      plugin: pluginOf.get(definition.name) ?? 'run',
    })),
  globals: step.definitions.flatMap(({ name }) => {
    const global =
      name === scriptTool ? undefined : step.registry.get(name)?.scriptGlobal;
    return global === undefined
      ? []
      : [{ tool: name, positional: global.positional }];
  }),
  modules: step.modules,
});

/** The result of a call no body answers: to a tool the run does not offer,
 *  or (`unsent`) to one it offers to scripts alone. */
const unavailableResult = (toolName: string, unsent: boolean): ToolResult => ({
  status: 'error',
  error: unsent
    ? `tool_unavailable: "${toolName}" is not a direct call in this run; call it from a script as tools.${toolName}(...).`
    : `tool_unavailable: the tool "${toolName}" is not available in this run. Continue with the tools you were offered.`,
  diagnostics: { code: 'tool_unavailable', tool: toolName },
});

/** What the per-call program reads from its run's context. */
type CallServices =
  ProcessServices | Runs | WorkspaceFs | StorageFs | FileSystem.FileSystem;

/** A call's PreToolUse decision (`preToolUse`). */
type ToolCallHooks = Effect.Success<ReturnType<typeof preToolUse>>;

/** A response call's lane: its tool's (`RuntimeTool.lane`) when parallel, else a
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
    run: Effect.fn('toolUseDispatch.run')(function* <E, R>(
      seq: number,
      lane: DispatchFacts['lane'],
      body: (endedBefore: boolean) => Effect.Effect<boolean, E, R>,
    ): Effect.fn.Return<void, E, R> {
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
        if (call !== null && (yield* Deferred.await(call))) endedBefore = true;
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
    (at ? stored(initial, at, Schema.String) : run.config.instruction);
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
   *  row, whichever that is. Concurrent results of one parallel partition
   *  commit one at a time under the cell's lock, each onto the latest state. */
  const commit = (
    fact: CallFacts,
    rows:
      | readonly RunHistoryDraft[]
      | ((state: RunState) => readonly RunHistoryDraft[]),
    alongside?: ReturnType<typeof factRows>['alongside'],
  ) =>
    cell.append((state) => {
      const own = typeof rows === 'function' ? rows(state) : rows;
      const script = scriptOf(fact);
      return script !== null && recordOf(state, fact.callId) === null
        ? [scriptCallRow(runId, script), ...own]
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
        toolResultRow(runId, responseId, fact.callId, attempt, result, blobs),
        ...cards(state),
      ],
      alongside,
    );

  const toolOf = (fact: CallFacts) => step.registry.get(fact.toolName);
  /** The card rows a result commits: a card its attempt's body opened
   *  only closes, any other opens and closes in the same batch (a slow
   *  tool's opens with the intent its body starts with, so a resume finds
   *  the card its result closes). The card stores no output: a read
   *  projects it from the `tool.result` the batch commits (`rowCodec.ts`). */
  const resultCards = (
    fact: CallFacts,
    input: unknown,
    status: ToolCallStatus,
    attempt: number,
    files: readonly FileListEntry[] = [],
  ) => {
    const tool = toolOf(fact);
    return (state: RunState): RunHistoryDraft[] => [
      ...(tool?.slow && startedAt(state, fact.callId, attempt)
        ? []
        : [cardStartRow(runId, fact, input, attempt, tool)]),
      cardEndRow(runId, fact, status, files),
    ];
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

  /** Run `tool`'s body for `fact` at `attempt`, guard first, under the
   *  step's roots and plugin services: a refused path or unapproved command
   *  settles the call without the body running. A throwing tool is an error
   *  result; an interruption or a refused durable write fails. */
  const runBody = Effect.fn('toolUse.runBody')(function* (
    fact: CallFacts,
    tool: RuntimeTool,
    pre: ToolCallHooks,
    parsedInput: unknown,
    attempt: number,
    requests: CallRequests,
    place: Pick<RunCallShape, 'script' | 'scriptCalls'>,
  ): Effect.fn.Return<ToolResult, InvokeError, CallServices> {
    const stageId = scriptOf(fact)?.stageId;
    // A slow tool's card opens as its body starts; what the tool prints is
    // transient text on it, capped, never a row, refused once the call returned.
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
    // From here the call may have run: its intent commits now, with a slow
    // tool's card, unless this attempt's body already started (a re-entry).
    const bodyStarts = Effect.gen(function* () {
      if (!startedAt(yield* cell.current, fact.callId, attempt))
        yield* commit(fact, [
          intentRow(runId, responseId, fact, attempt),
          ...(tool.slow
            ? [cardStartRow(runId, fact, parsedInput, attempt, tool)]
            : []),
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
    if (Exit.isSuccess(invoked)) return invoked.value;
    if (Cause.hasInterrupts(invoked.cause))
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
    const refused = findStorageRefusal(invoked.cause);
    if (refused) return yield* runRefusal(runId, refused);
    const { message, diagnostics } = normalizeToolCallError(
      fact.toolName,
      Cause.squash(invoked.cause),
    );
    return {
      status: 'error',
      error: message.trim() || 'Tool run failed.',
      ...(diagnostics ? { diagnostics } : {}),
    };
  });

  /** Execute one call at `attempt` and commit its result, re-entering the
   *  request a resumed attempt left standing (`own`); `place` is the script
   *  that issued it, or the door a `script` call issues its own through. A
   *  throwing tool is an error result; interruption leaves no result. */
  const execute = Effect.fn('toolUse.executeCall')(function* (
    fact: CallFacts,
    parsedInput: unknown,
    { attempt, raised, own: standing }: ResumedAttempt,
    place: Pick<RunCallShape, 'script' | 'scriptCalls'>,
  ): Effect.fn.Return<void, InvokeError, CallServices> {
    // A tool the step offers but did not send (script-only tools on) is
    // reached from inside a script alone: a response's call to it has no body.
    const unsent =
      scriptOf(fact) === null &&
      step.offered.some((t) => t.name === fact.toolName && !t.sent);
    const tool = unsent ? undefined : step.registry.get(fact.toolName);
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
    // No offered tool, no body; else a hook's denial, or what the body did.
    const answer =
      !tool || !pre
        ? unavailableResult(fact.toolName, unsent)
        : (pre.denied ??
          (yield* runBody(
            fact,
            tool,
            pre,
            parsedInput,
            attempt,
            requests,
            place,
          )));
    yield* settle(fact, parsedInput, attempt, answer, pre, retireStanding);
  });

  /** Commit `fact`'s `answer` at `attempt`: its attachments captured, its
   *  card, its PostToolUse rows (`pre`, when its hooks ran), the follow-ups
   *  it answers and its facts, once the request it left standing retires. */
  const settle = Effect.fn('toolUse.settleCall')(function* (
    fact: CallFacts,
    parsedInput: unknown,
    attempt: number,
    answer: ToolResult,
    pre: ToolCallHooks | undefined,
    retireStanding: Effect.Effect<void>,
  ) {
    let result = answer;
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
    // The card commits with the result (a slow tool's closes, a fast tool's
    // opens and closes here); outside the batch recovery could see it undone.
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
        ...answered.map((followUpId) => consumedRow(runId, followUpId)),
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
  ): Effect.fn.Return<void, InvokeError, CallServices> {
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

  /** Open `script`'s trace stage at its first call, labelled by the
   *  script's title, which that call carries; it closes with the door's
   *  scope, as the script's own result settled it. */
  const scriptStage = Effect.fn('toolUse.scriptStage')(function* (
    script: DispatchFacts,
    stageId: string,
  ) {
    const stageOpened = yield* Ref.make(false);
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
    return Effect.fn('toolUse.openScriptStage')(function* (
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
  });

  /** Settle, as skipped, each call `script` issued that has no result yet
   *  (its guest never awaited it to its end), closing its card and
   *  withdrawing a request it was parked on. */
  const settleAbandoned = (script: DispatchFacts) =>
    Effect.flatMap(cell.current, (state) =>
      Effect.forEach(
        issuedBy(state, script.callId),
        ({ call: fact, status }) => {
          if (status.kind === 'settled') return Effect.void;
          const at = { responseId, callId: fact.callId };
          const entered = resumedAttempt(state, at, status);
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
              skipCall(
                fact,
                fact.input,
                status,
                skippedByScriptEnd(attemptOf(status) > 0),
              ),
            ),
          );
        },
        { discard: true },
      ),
    );

  /** The door a `script` call's guest issues calls through: the same per-call
   *  program and scheduler, under the script's stage. A resumed script is
   *  handed back what its rows settled, in commit order, before any call
   *  runs again; a call at a recorded `seq` that differs is a divergence. */
  const scriptCallsOf = Effect.fn('toolUse.scriptCalls')(function* (
    script: DispatchFacts,
  ) {
    const services = yield* Effect.context<CallServices | Scope.Scope>();
    // Built on first use: a call that issues none allocates nothing.
    const door = yield* Effect.cached(
      Effect.gen(function* () {
        const stageId = `script-${script.logId}`;
        // Settled calls in commit order, each handed back after the one before.
        const replayOrder = issuedBy(yield* cell.current, script.callId)
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
        const openStage = yield* scriptStage(script, stageId);
        const shared = sharedValues();
        const scopeOf = (source: ScriptSource): ScriptScope => ({
          ...source,
          callId: script.callId,
          calls: Effect.map(cell.current, (state) =>
            issuedBy(state, script.callId)
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
          const diverged = divergence(recorded, op, input);
          if (diverged !== null) return yield* diverged;
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
            // Reads the pinned catalog only and runs no tool: no lane, one commit.
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
              // Nothing runs again until the guest holds all that settled.
              yield* handedBack(replayOrder.at(-1));
              const status = recordOf(yield* cell.current, callId)?.status;
              if (status?.kind !== 'settled')
                yield* resumeCall(fact, input, status ?? { kind: 'issued' }, {
                  script: scopeOf(source),
                  scriptCalls: null,
                });
              // The script's own result says whether a call ended the turn.
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
          ...scriptCatalog(step, script.toolName, pluginOf),
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
          settleAbandoned: settleAbandoned(script).pipe(
            Effect.provideContext(services),
          ),
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
  ): Effect.fn.Return<boolean, InvokeError, CallServices> {
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
  const group: Message = { role: 'tool', results };
  const delivered = yield* cell.append((state) => [
    appendRow(runId, [group], { sourceResponse: responseId }),
    positionRow(runId, state, 'results.ready'),
  ]);
  return { state: delivered, endTurn };
});
