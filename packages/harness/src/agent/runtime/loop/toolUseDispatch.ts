/**
 * Dispatch of one committed response's tool calls, from the folded state and
 * back into it. The guaranteed behaviours the node enforced, kept by
 * construction: contiguous parallel calls run concurrently under a
 * small window while every other call is a barrier that runs alone and in
 * order; a call repeating an earlier call's name and arguments never executes
 * and derives its primary's result with no edits, attachments or mutation;
 * a result that ends the turn stops dispatch after its partition settles;
 * one interrupt cancels the whole in-flight batch through the fiber; and no
 * ordinary tool failures become model-visible results. Durable write failures
 * halt dispatch so an unsettled call is never recorded as successful.
 *
 * One record per call (`PendingCall`), whichever issued it: the response, or
 * a guest of one of its `script` calls. Its rows are its only facts: the
 * `script.call` that issues a script's call commits with the call's first
 * row; its requests, under ids the attempt derives (`callRequestId`);
 * `tool.intent` as the body starts, after the PreToolUse hooks, the
 * guard and its approval, with a slow tool's card; `tool.result` with its
 * card's close; and the delivering `append` with the complete tool group
 * once, when every call of the response has settled. One scheduler places
 * both origins' calls.
 *
 * Resume reads only row data: a settled call stays settled; a duplicate
 * derives its primary; a call whose body never started re-enters what it
 * asked, or, untouched in a recovered response, is reported not started; a call whose body started re-runs when `replayable` says so, else
 * settles as outcome unknown. The model decides on retries.
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
import type { RuntimeTool as ITool } from '@agent/runtime/ToolServices';
import { ToolContext, type CallRequests } from '@agent/core/tools/ToolTypes';
import {
  IssuingScript,
  RunCall,
  ScriptCalls,
  ScriptDiverged,
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
  type ToolFileAttachment,
  type ToolResult,
  type ToolResultPayload,
} from '@shared/schemas';
import { JsonValueSchema, toJsonValue } from '@shared/schemas';
import { findStorageRefusal } from '@shared/session/runHistory';
import {
  type RunHistoryDraft,
  type RunState,
} from '@shared/session/runStateFold';
import {
  attemptOf,
  attemptRequests,
  callRequestId,
  settlementOf,
  type AttemptRequests,
  type CallStatus,
  type PendingCall,
} from '@shared/session/inFlight';
import { checkOwnFacts, factRows } from '@tools/plugins';
import { ToolRegistry } from '@tools/toolTable';
import { generateShortId, getBasename } from '@utils/core';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { pathToLocationIn } from '@utils/files/fileLocation';

import { AgentRun } from '../run/AgentRun';
import { inlineMediaPart, type InputPart } from '../run/mediaInput';
import { stored } from '../run/requestContext';
import {
  localCallsOf,
  parseCallArguments,
  replayable,
  SKIPPED_NOT_STARTED,
  SKIPPED_OUTCOME_UNKNOWN,
} from '../run/tools';
import {
  formatAttachmentSummary,
  formatToolResultAsText,
} from '../run/toolResultText';
import { guardedToolCall } from './toolGuard';
import { callHookText, preToolUse } from './hooks';
import {
  appendRow,
  displayRow,
  rowAggregate,
  positionRow,
  type Message,
} from './rows';
import type { StepTools } from './step';
import type { JoinedFollowUps } from '../FollowUps';
import type { InvokeError } from '../ModelInvoker';
import type { Runs } from '../runRegistry';
import type { RunCell } from './runProgram';

/** Max concurrently executing parallel tool calls. */
const MAX_PARALLEL_TOOL_CALLS = 4;

/** How much of a running tool's output streams to its card as transient
 *  text; the settlement carries the bounded capture whatever streamed. */
const STREAMED_OUTPUT_MAX = 50_000;

const SKIPPED_AFTER_END_TURN =
  'Tool call skipped: an earlier tool call ended the turn.';

/** What the per-call program needs of a call, whichever origin issued it:
 *  a response's dispatch fact, or a script's `script.call`, which commits
 *  with the call's first row. */
type CallFacts =
  | Pick<DispatchFacts, 'callId' | 'toolName' | 'replay' | 'logId' | 'stageId'>
  | ScriptCallPayload;

/** The `script.call` a call carries, or null for a response's own. */
const scriptOf = (fact: CallFacts): ScriptCallPayload | null =>
  'scriptCallId' in fact ? fact : null;

type Settlement = Pick<
  ToolResultPayload,
  'disposition' | 'duplicateOf' | 'result' | 'attachments'
>;

type SettledAttachment = ToolResultPayload['attachments'][number];

/** What a call may reach of scripting, provided around each call. */
type ScriptServices = ScriptCalls | IssuingScript;

interface DispatchOutcome {
  readonly state: RunState;
  /** A settled result asked to end the turn. */
  readonly endTurn: boolean;
}

/**
 * A sanitized result as the run history stores it: `diagnostics` narrowed to JSON.
 * The sanitizer already reduced it to the validation-error shape or nothing,
 * so a value that is not JSON here is a defect in that projection, and the
 * row refuses it rather than storing a value `JSON.stringify` would throw on.
 */
function settledResult(result: ToolResult): Settlement['result'] {
  const { diagnostics, ...rest } = result;
  if (rest.status === 'executed') delete rest.consumedFollowUps; // own rows
  if (diagnostics === undefined) return rest;
  return { ...rest, diagnostics: JsonValueSchema.parse(diagnostics) };
}

/** A duplicate's copy of its primary's result: no edits, no files. */
const withoutEffects = (result: Settlement['result']): Settlement['result'] => {
  if (result.status !== 'executed') return result;
  const { edits: _edits, files: _files, ...rest } = result;
  return rest;
};

const endsTurn = (settlement: Pick<Settlement, 'result'>): boolean =>
  settlement.result.status === 'executed' && settlement.result.endTurn === true;

/**
 * Attachment bytes captured as immutable content before the settlement
 * commits: from the tool's own payload when it carried one, from the path
 * otherwise; a capture failure records the omission and its reason.
 */
const captureAttachments = Effect.fn('toolUse.captureAttachments')(function* (
  attachments: readonly ToolFileAttachment[],
  workspaceRoot: string | undefined,
): Effect.fn.Return<
  readonly SettledAttachment[],
  never,
  FileSystem.FileSystem
> {
  const fs = yield* FileSystem.FileSystem;
  const captured: SettledAttachment[] = [];
  for (const attachment of attachments) {
    const base = {
      path: attachment.path,
      mimeType: attachment.mimeType,
      ...(attachment.description !== undefined
        ? { description: attachment.description }
        : {}),
    };
    const inline =
      attachment.base64Data ||
      Buffer.from(attachment.bytes ?? []).toString('base64');
    const read =
      inline !== ''
        ? Exit.succeed(inline)
        : yield* Effect.exit(
            fs
              .readFile(
                pathToLocationIn(workspaceRoot, attachment.path).absolutePath,
              )
              .pipe(Effect.map((b) => Buffer.from(b).toString('base64'))),
          );
    captured.push({
      ...base,
      content: Exit.isSuccess(read)
        ? { kind: 'base64', data: read.value }
        : {
            kind: 'metadata-only',
            reason: toErrorMessage(Cause.squash(read.cause)),
          },
    });
  }
  return captured;
});

/**
 * How long delivery waits on the provider to take one upload. Uploading is
 * an optimisation for later rounds, so a stalled files endpoint must cost
 * delivery no more than this; the bytes are delivered either way.
 */
const UPLOAD_DEADLINE = '5 seconds';

/**
 * The model-visible content of one settlement: text, then inline media. The
 * run history keeps the bytes; whether a later request sends them or a file id is
 * the bound model's in-memory upload cache's decision, made when it lowers.
 *
 * An attachment the binding cannot carry inline (a PDF on a route without
 * native PDF support, an image on a text-only route, any other type) reaches
 * the model as the text mention only, and says so in the transcript rather
 * than degrading silently.
 */
function settlementContent(
  settlement: Pick<Settlement, 'result' | 'attachments'>,
  capabilities: Parameters<typeof inlineMediaPart>[2],
  logger: AgentTrace,
): readonly InputPart[] {
  const attachments: ToolFileAttachment[] = settlement.attachments.map(
    (attachment) => ({
      path: attachment.path,
      mimeType: attachment.mimeType,
      ...(attachment.description !== undefined
        ? { description: attachment.description }
        : {}),
    }),
  );
  const text = formatToolResultAsText(
    settlement.result,
    attachments.length > 0 ? formatAttachmentSummary(attachments) : undefined,
  );
  const media = settlement.attachments.flatMap((attachment) => {
    if (attachment.content.kind !== 'base64') {
      logger.warn(
        `The model receives "${attachment.path}" as a mention only: its bytes were not captured (${attachment.content.reason}).`,
      );
      return [];
    }
    const part = inlineMediaPart(
      attachment.mimeType,
      attachment.content.data,
      capabilities,
    );
    if (part === null) {
      logger.warn(
        `The model receives "${attachment.path}" as a mention only: the bound model carries no ${attachment.mimeType} attachment inline.`,
      );
      return [];
    }
    return [part];
  });
  return [{ kind: 'text', text }, ...media];
}

/** A response call's lane: its tool's (`ITool.lane`) when parallel, else a
 *  barrier; a duplicate's `'own'` (it only waits for its primary). */
const responseLane = (fact: DispatchFacts): DispatchFacts['lane'] => {
  if (fact.duplicateOf !== null) return 'own';
  return fact.lane === 'parallel' ? 'parallel' : 'barrier';
};

/**
 * The one scheduler, for a response's calls and a script's guest's alike.
 * Calls take their places in issue order (`seq`), whatever order their
 * fibers reach it in. Each call answers whether it ended the turn, and its
 * body learns whether any call it waited for did, so a call after a
 * partition that ended the turn sees it and its own partition does not.
 */
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
  /** The files the run read since its loop started (`RunCall.readFiles`). */
  readFiles: Set<string>,
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
  // A stored call nothing of which ran is reported, not run, unless a
  // script's run made it (no model to report to).
  const replan =
    cell.opened.pendingResponse?.responseId === responseId &&
    !run.config.script;
  const calls = localCallsOf(pending.assistant.content);
  const { entries } = yield* ToolRegistry;
  const pluginOf = new Map(step.offered.map((t) => [t.name, t.plugin]));
  // The calls answer the instruction the committed state records.
  const at = initial.input.instruction;
  const userInstruction =
    run.config.rootUserInstruction ??
    (at ? stored(initial, at, z.string()) : run.config.instruction);
  // Concurrent settlements of one parallel partition serialize under the
  // cell's lock and each folds onto the latest state.
  const { append } = cell;
  const recordOf = (state: RunState, callId: string): PendingCall | null =>
    state.pendingResponse?.responseId === responseId
      ? (state.pendingResponse.records[callId] ?? null)
      : null;
  const settledOf = (state: RunState, callId: string) => {
    const status = recordOf(state, callId)?.status;
    return status?.kind === 'settled' ? status : null;
  };
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

  const settle = (
    fact: CallFacts,
    attempt: number,
    settlement: Settlement,
    cards: (state: RunState) => readonly RunHistoryDraft[] = () => [],
    alongside?: ReturnType<typeof factRows>['alongside'],
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
            ...settlement,
          },
        },
        ...cards(state),
      ],
      alongside,
    );

  const slow = (fact: CallFacts) =>
    step.registry.get(fact.toolName)?.slow === true;
  /** The row that opens a call's card: a slow tool's commits with the
   *  intent its body starts with, so a resume finds the card its
   *  settlement closes; a fast tool's rides the settlement batch itself. */
  const cardStart = (
    fact: CallFacts,
    input: unknown,
    attempt: number,
  ): RunHistoryDraft => {
    const phase = scriptOf(fact)?.phase;
    return displayRow(runId, {
      type: 'tool.start',
      logId: fact.logId,
      toolName: fact.toolName,
      input: toJsonValue(input),
      ...(phase != null ? { phase } : {}),
      ...(attempt > 1 ? { attempt } : {}),
      ...(fact.stageId !== null ? { stageId: fact.stageId } : {}),
    });
  };
  /** The card rows a settlement commits: a card its attempt's body opened
   *  only closes, any other opens and closes in the same batch. The card
   *  stores no output: a read projects it from the `tool.result` the batch
   *  commits (`rowCodec.ts`). */
  const settledCards =
    (
      fact: CallFacts,
      input: unknown,
      status: ToolCallStatus,
      attempt: number,
      files: readonly FileListEntry[] = [],
    ) =>
    (state: RunState): RunHistoryDraft[] => [
      ...(slow(fact) && startedAt(state, fact.callId, attempt)
        ? []
        : [cardStart(fact, input, attempt)]),
      displayRow(runId, {
        type: 'tool.end',
        logId: fact.logId,
        status,
        ...(files.length > 0 ? { files: [...files] } : {}),
        ...(fact.stageId !== null ? { stageId: fact.stageId } : {}),
      }),
    ];

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

  const syntheticSettlement = (error: string): Settlement => ({
    disposition: 'skipped',
    duplicateOf: null,
    result: { status: 'error', error },
    attachments: [],
  });

  /** Execute one call and commit its settlement. Never fails: a throwing
   *  tool is an error result. Interruption leaves no settlement. `raised`
   *  counts the requests the attempt opened before, and `standing` is the
   *  one a resumed attempt re-enters: still open, or answered and not yet
   *  read. */
  const execute = Effect.fn('toolUse.executeCall')(function* (
    fact: CallFacts,
    parsedInput: unknown,
    attempt: number,
    raised: number,
    standing: AttemptRequests['own'],
  ): Effect.fn.Return<
    void,
    InvokeError,
    | ProcessServices
    | Runs
    | WorkspaceFs
    | StorageFs
    | FileSystem.FileSystem
    | ScriptServices
  > {
    const tool: ITool | undefined = step.registry.get(fact.toolName);
    const stageId = fact.stageId ?? undefined;
    // A slow tool's card opens as its body starts. What the tool prints
    // while it runs streams to that card as transient text, the way a
    // response's chunks reach a streaming row (C3): never a row of its own,
    // capped, and refused once the call has returned, so no chunk can be
    // enqueued after the settlement that closes the card.
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
    // The call's requests, under ids the attempt derives: a fresh one past
    // every ordinal it raised. A resumed attempt joins the request it left
    // standing when it asks that kind again; one it no longer asks is
    // retired as cancelled, so no surface keeps offering it.
    const at = { responseId, callId: fact.callId, attempt };
    let reentering = standing;
    let opened = raised;
    // Through the decision authority's own check, so an answer a surface
    // landed meanwhile stands and the retirement writes nothing.
    const retireStanding = Effect.suspend(() => {
      const open = reentering?.request.decision === null ? reentering : null;
      reentering = null;
      if (open === null) return Effect.void;
      return run.session.requests
        .decide(runId, open.requestId, {
          action: 'cancel',
          cause: 'The resumed call no longer asks it.',
        })
        .pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              logger.warn(
                `Request ${open.requestId} the resumed call no longer asks stays open: its retirement failed.`,
                { data: error },
              ),
            ),
          ),
          Effect.asVoid,
        );
    });
    const requests: CallRequests = {
      nextId: (kind) =>
        reentering?.request.payload.kind === kind
          ? reentering.requestId
          : callRequestId(at, opened + 1),
      open: (payload, options) =>
        Effect.suspend(() => {
          const reentered =
            payload.data.requestId === reentering?.requestId
              ? reentering
              : null;
          if (reentered !== null) reentering = null;
          else if (payload.data.requestId === callRequestId(at, opened + 1))
            opened += 1;
          // Answered before this owner's loop reached the call: the answer
          // is the row's, and what the host staged for it is released here,
          // as no later decision will release it.
          if (reentered?.request.decision != null)
            return Effect.as(
              Effect.uninterruptible(options?.onNeverCommitted ?? Effect.void),
              reentered.request.decision,
            );
          return run.session.requests.ask(runId, payload, {
            ...options,
            open: (rows) => {
              if (reentered !== null) {
                // Open already: only what the policy decides commits, and
                // the decision is read from where the resume read the run.
                const decided = rows.filter(
                  (row) => row.type !== 'request.opened',
                );
                const from = cell.opened.commit;
                return decided.length === 0
                  ? Effect.succeed(from)
                  : commit(fact, decided).pipe(Effect.as(from));
              }
              return retireStanding.pipe(
                Effect.andThen(Effect.sync(() => run.session.log.now())),
                Effect.flatMap((from) =>
                  commit(fact, rows).pipe(Effect.as(from)),
                ),
              );
            },
          });
        }),
    };
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
      // The body starts once the guard let it: from here the call may have
      // run, so its intent commits now, with a slow tool's card, and not
      // again for an attempt whose body already started (a body re-entering
      // the request it parked on).
      const bodyStarts = Effect.gen(function* () {
        if (!startedAt(yield* cell.current, fact.callId, attempt))
          yield* commit(fact, [
            intentRow(fact, attempt),
            ...(tool.slow === true
              ? [cardStart(fact, parsedInput, attempt)]
              : []),
          ]);
        accepting = tool.slow === true;
        yield* pre.bodyStarts;
      });
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
            Effect.provideService(RunCall, {
              readFiles,
              responseId,
              instruction: userInstruction,
              attempt,
              logId: fact.logId,
            }),
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
        if (refused) return yield* Effect.fail(refused);
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
    const attachments = yield* captureAttachments(
      extracted.attachments,
      run.session.roots.workspace,
    );
    const status: ToolCallStatus =
      extracted.sanitizedResult.status === 'error' ? 'failed' : 'completed';
    // The whole card commits with the settlement (a slow tool's closes here,
    // a fast tool's opens and closes here): a terminal card outside the batch
    // would show the call completed while recovery sees it unsettled.
    const cards = settledCards(fact, parsedInput, status, attempt, editedFiles);
    // An executed call's PostToolUse rows, the follow-ups its result answers
    // and its facts (the run's, and its plugin's own aggregates') commit too.
    const post = pre ? yield* pre.after(extracted.sanitizedResult) : [];
    const answered =
      extracted.sanitizedResult.status === 'executed'
        ? (extracted.sanitizedResult.consumedFollowUps ?? [])
        : [];
    const facts = factRows(extracted.facts, runId, plugin, run.session.log);
    yield* retireStanding;
    yield* settle(
      fact,
      attempt,
      {
        disposition:
          extracted.sanitizedResult.status === 'executed'
            ? 'executed'
            : 'failed',
        duplicateOf: null,
        result: settledResult(extracted.sanitizedResult),
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
    );
  });

  /**
   * A call not yet settled, continued from where its rows left it (from
   * nothing, for a fresh call). A response's call untouched in a recovered
   * response is reported not started. An attempt whose body never started
   * re-enters whatever it asked: any answer is the attempt's, since nothing
   * ran yet. A started attempt re-enters its own request while it stands,
   * or once answered if no waiter read the answer (decided since this owner
   * took the run); one a stop retired as cancelled decides nothing, and
   * the body asks again. Otherwise the body may have run: the replay rule
   * re-runs it, or it settles as outcome unknown, closing the card the
   * interrupted attempt opened, and the model decides from that what to do
   * (verify, ask, or call again under its own approval).
   */
  const resumeCall = Effect.fn('toolUse.resumeCall')(function* (
    fact: CallFacts,
    input: unknown,
    status: Exclude<CallStatus, { kind: 'settled' }>,
  ): Effect.fn.Return<
    void,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs | ScriptServices
  > {
    const current = yield* cell.current;
    const reached = attemptOf(status);
    const asked = (attempt: number) =>
      attemptRequests(current.requests, {
        responseId,
        callId: fact.callId,
        attempt,
      });
    const next = asked(reached + 1);
    const untouched = status.kind === 'issued' && next.raised === 0;
    if (untouched && replan && scriptOf(fact) === null) {
      yield* settle(fact, 1, syntheticSettlement(SKIPPED_NOT_STARTED));
      return;
    }
    if (status.kind === 'issued' || next.raised > 0)
      return yield* execute(fact, input, reached + 1, next.raised, next.own);
    const { raised, own } = asked(reached);
    if (
      raised > 0 &&
      (own === null ||
        !own.request.resolved ||
        current.decidedSinceActivation.has(own.requestId))
    )
      return yield* execute(fact, input, reached, raised, own);
    if (yield* replayable(fact, step.registry, input, logger))
      return yield* execute(fact, input, reached + 1, 0, null);
    yield* settle(
      fact,
      reached,
      syntheticSettlement(SKIPPED_OUTCOME_UNKNOWN),
      settledCards(fact, input, 'failed', reached),
    );
  });

  /**
   * The calls a response's call may issue as a script, each through this
   * same per-call program and the same scheduler, under the script's stage,
   * its settlement handed back at its `tool.result` commit. A resumed script
   * is handed back what its rows settled, in the order those settlements
   * committed, before any call runs again; an unsettled call continues as
   * its rows say; and a call at a recorded `seq` that is not the recorded
   * one is a divergence. A parallel call takes the window, a tool that
   * bounds its own calls runs beside the others, any other is a barrier.
   */
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
    // Built when the call's tool first asks for it, so a call that issues
    // none allocates nothing; the dispatch's scope still owns the stage.
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
            ...(script.stageId !== null ? { parentId: script.stageId } : {}),
          });
        });
        yield* Effect.addFinalizer((exit) =>
          Effect.gen(function* () {
            if (!(yield* Ref.get(stageOpened))) return;
            const settled = settledOf(yield* cell.current, script.callId);
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
            yield* settle(fact, 1, {
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
                yield* resumeCall(fact, input, status ?? { kind: 'issued' });
              // A script's calls are not the response's: its own result
              // says whether one of them ended the turn.
              return false;
              // The calls it makes know the script that issued them.
            }).pipe(
              Effect.provideService(IssuingScript, scopeOf(source)),
              Effect.provideService(ScriptCalls, null),
            ),
          );
          const settledNow = settledOf(yield* cell.current, callId);
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
        } satisfies ScriptDoor;
      }).pipe(Effect.provideContext(services)),
    );
    return <A, E, R>(call: Effect.Effect<A, E, R>) =>
      call.pipe(
        Effect.provideService(ScriptCalls, door),
        Effect.provideService(IssuingScript, null),
      );
  });

  const lanes = yield* makeScheduler;
  const ordinalOf = new Map(
    pending.calls.map((fact) => [fact.callId, fact.ordinal]),
  );

  /** One call of the response, in its place: a duplicate derives its
   *  primary, effects stripped, once the primary is done (and waits with
   *  it when it never settled); a call after one that ended the turn is
   *  skipped; any other runs, or continues as its rows left it. Answers
   *  whether its settlement ended the turn. */
  const responseCall = Effect.fn('toolUse.responseCall')(function* (
    fact: DispatchFacts,
    endedBefore: boolean,
  ): Effect.fn.Return<
    boolean,
    InvokeError,
    ProcessServices | Runs | WorkspaceFs | StorageFs | FileSystem.FileSystem
  > {
    const status = recordOf(yield* cell.current, fact.callId)?.status;
    const call = calls[fact.ordinal];
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
      const primary = settledOf(yield* cell.current, fact.duplicateOf);
      if (primary !== null)
        yield* settle(fact, attempt, {
          disposition: 'duplicate',
          duplicateOf: fact.duplicateOf,
          result: withoutEffects(primary.result),
          attachments: [],
        });
    } else if (endedBefore) {
      yield* settle(fact, attempt, syntheticSettlement(SKIPPED_AFTER_END_TURN));
    } else {
      const input = parseCallArguments(call, logger);
      yield* Effect.scoped(
        Effect.flatMap(scriptCallsOf(fact), (provide) =>
          provide(resumeCall(fact, input, status)),
        ),
      );
    }
    const settled = settledOf(yield* cell.current, fact.callId);
    return settled !== null && endsTurn(settled);
  });

  yield* Effect.forEach(
    pending.calls,
    (fact) =>
      lanes.run(fact.ordinal, responseLane(fact), (endedBefore) =>
        responseCall(fact, endedBefore),
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
  // A script's calls are not the response's: its own result says whether
  // one of them ended the turn.
  const endTurn = settledPending.calls.some((fact) => {
    const settled = settlementOf(settledPending, fact.callId);
    return settled !== null && endsTurn(settled);
  });
  const bound = yield* SynchronizedRef.get(run.model);
  const results = settledPending.calls.map((fact, ordinal) => {
    const settlement = settlementOf(settledPending, fact.callId);
    if (settlement === null) {
      throw new Error(`Call ${fact.callId} is unsettled at delivery.`);
    }
    return {
      callOrdinal: ordinal,
      status:
        settlement.result.status === 'executed'
          ? ('success' as const)
          : ('error' as const),
      content: [
        ...settlementContent(settlement, bound.config.capabilities, logger),
        // What the call's hooks add, after its result.
        ...callHookText(settledState, responseId, fact.callId),
      ],
    };
  });
  // Offer each delivered document to the binding's upload cache, so the
  // requests that replay this history can send a file id instead of the
  // bytes: concurrent under the parallel-call bound, the batch under one
  // aggregate deadline that warns with the paths that never finished. A
  // batch that ends the turn, or one delivered while a queued model switch
  // waits for the next boundary (whose binding never saw these ids), keeps
  // its documents local.
  const switching =
    !endTurn &&
    (yield* run.session.followUps.read(run.runId)).followUps.some(
      (f) => f.control?.kind === 'model',
    );
  const documents = (endTurn || switching ? [] : settledPending.calls).flatMap(
    (fact) =>
      (settlementOf(settledPending, fact.callId)?.attachments ?? []).flatMap(
        (attachment) => {
          if (attachment.content.kind !== 'base64') return [];
          const part = inlineMediaPart(
            attachment.mimeType,
            attachment.content.data,
            bound.config.capabilities,
          );
          return part?.kind === 'document'
            ? [{ path: attachment.path, part }]
            : [];
        },
      ),
  );
  const uploadFile =
    documents.length === 0 ? undefined : bound.model.uploadFile;
  if (uploadFile !== undefined) {
    // Settled uploads leave the set; the aggregate deadline names the rest.
    const pendingUploads = new Set(documents.map(({ path }) => path));
    yield* Effect.forEach(
      documents,
      ({ path, part }) =>
        uploadFile({
          mimeType: part.mimeType,
          filename: getBasename(path) || 'attachment',
          base64: part.base64,
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
