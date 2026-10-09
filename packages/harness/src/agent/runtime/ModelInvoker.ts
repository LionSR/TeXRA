/**
 * The one service that touches the llm `Model`; every call carries a purpose
 * (`run/invocation.ts`). One `invoke` is one turn with its billed attempts: the
 * `TurnRequest` assembled from the folded `RunState`, `prepareTurn`, the
 * `attempt` row committed before the request leaves the process (F1),
 * `identified` when the provider names the response, the stream bridged into
 * the trace, and the `response` row with its dispatch facts and priced usage
 * committed before any tool runs. `call` is a compaction summary on the same
 * binding, gate and pricing, its attempts recorded on the run's history and
 * landed by its caller.
 *
 * Retry is the one loop (`run/invocation.ts`) over the invocation's rows:
 * each failed attempt commits a `failed` row with the move after it, an
 * automatic resend under the process's `ModelRetryGate` while the budget the
 * rows count lasts, then a person's answer to a `request.opened` the same
 * batch opens. The answer is the `request.decided` row, and the attempt
 * after it consumes it; an attempt a person admitted whose outcome no row
 * recorded is asked about again, never resent unasked.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Clock,
  Context,
  Effect,
  Exit,
  type FileSystem,
  Layer,
  Result,
  Stream,
  SynchronizedRef,
} from 'effect';
import {
  ModelError,
  type BackgroundEvent,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm';

import { maybeSaveDebugObject } from '@agent/debug/debugMessageSaver';
import {
  logContextManagementEvent,
  logProgressStatus,
  logProviderError,
  type StreamHandle,
} from '@agent/trace';
import { failureInfo } from '@agent/runtime/modelAccess/failureInfo';
import {
  ModelAccess,
  type BoundModel,
} from '@agent/runtime/modelAccess/ModelAccess';
import type { StateReadFailed } from '@platform/interfaces';
import { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  MESSAGE_TYPES,
  type FailedNext,
  type InvocationRef,
  type NormalizedUsage,
  type RetryErrorInfo,
} from '@shared/schemas';
import type { Attempt, RetryCredentials } from '@shared/session/inFlight';
import { findStorageRefusal } from '@shared/session/runHistory';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';
import { UsageLog, usageAgentName } from '@shared/usageLog';
import { generateShortId } from '@utils/core';

import { policyDecidedRows } from './requestPolicy';
import { AgentRun } from './run/AgentRun';
import { runInvocation, type RouteRetries } from './run/invocation';
import { callModel, type CallResult } from './run/modelCall';
import { observeBackground, submitAndObserve } from './run/backgroundTurn';
import { contextTokens } from './run/contextTokens';
import { priceTurnUsage, reportUsage } from './run/pricing';
import { turnReasoning, turnText } from './run/turnText';
import {
  admittedTurn,
  attemptRequest,
  attemptRows,
  chainedContinuation,
  checkRecordedRequest,
} from './run/requestContext';
import { dispatchFactsFor, localCallsOf } from './run/tools';
import { rowAggregate, positionRow } from './loop/rows';
import type { CellError, RunCell } from './loop/runProgram';

/** The answer the invoker gives itself for an automatic quota fallback. */
const PERSONAL_RETRY = {
  type: 'request.decided',
  decision: { action: 'retry', credentials: 'personal' },
} as const;

/**
 * The output-budget preflight's constants (R4), as the retired handler
 * preflight used them: the buffer covers tokenization differences and API
 * framing, and a reduction below the floor is not worth taking.
 */
const TOKEN_SAFETY_BUFFER = 10;
const TOOL_USE_SAFETY_BUFFER = 2000;
const MIN_COMPLETION_TOKENS = 100;

/** The output budget that fits in what the input leaves of the window. */
function reducedOutputBudget(available: number, buffer: number): number {
  if (available <= 0) return 1;
  const buffered = available - buffer;
  return buffered >= MIN_COMPLETION_TOKENS ? buffered : available;
}

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/** What a person is asked again about an admitted attempt a stop cut. */
const INTERRUPTED_RETRY_MESSAGE =
  'The process stopped while the retry you approved was running, so it may have been billed without an answer. Retry again?';

/**
 * How much of a failed attempt's streamed output the failure carries. The
 * retry surface shows the tail so the user sees the work was not lost; the
 * bound keeps a long generation out of the error and off the run history row.
 */
const PARTIAL_TEXT_TAIL_MAX = 4096;

export interface InvokeRequest {
  readonly system: string | undefined;
  /** The tools this turn advertises; a text-only persona advertises none. */
  readonly tools: TurnRequest['tools'];
  readonly toolChoice: TurnRequest['toolChoice'];
  /** The turn's round ordinal, for debug file naming. */
  readonly round: number;
  /** The debug file base name of the family issuing the turn. */
  readonly debugName: string;
}

interface InvocationResponse {
  readonly kind: 'response';
  readonly state: RunState;
  readonly responseId: string;
  readonly turn: TurnResult;
  /** The assistant text of the turn, joined; empty when it produced none. */
  readonly text: string;
  readonly usage: NormalizedUsage | null;
  readonly responseTimeMs: number;
}

type InvocationOutcome =
  | InvocationResponse
  | {
      readonly kind: 'failed';
      readonly state: RunState;
      readonly error: RetryErrorInfo;
    }
  | { readonly kind: 'cancelled'; readonly state: RunState };

/**
 * The run history failures `invoke` can hand back. One definition: the dispatch
 * path in `loop/toolUseDispatch` branches on the same union, so it imports
 * this rather than re-declaring the alias.
 */
export type InvokeError = CellError | StateReadFailed;

/** What an invocation reads from its run's context. */
type InvokeServices = FileSystem.FileSystem | RouteRetries;

export class ModelInvoker extends Context.Service<
  ModelInvoker,
  {
    readonly invoke: (
      cell: RunCell,
      request: InvokeRequest,
    ) => Effect.Effect<InvocationOutcome, InvokeError, InvokeServices>;
    /** A compaction summary: one call outside a turn, on the run's binding,
     *  its attempts recorded on the run's history. */
    readonly call: (
      cell: RunCell,
      request: TurnRequest,
    ) => Effect.Effect<CallResult, Error>;
  }
>()('@texra/agent/ModelInvoker') {}

/**
 * Build a request service for one run; its model is run-owned, and every row
 * it writes goes through the run cell the loop hands each invocation.
 */
export const modelInvokerLayer = (): Layer.Layer<
  ModelInvoker,
  never,
  AgentRun | UsageLog | ModelAccess | RouteRetries
> =>
  Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const { runId, session, logger } = run;
      const aggregateId = rowAggregate(runId);
      const usageLog = yield* UsageLog;
      const access = yield* ModelAccess;
      const gate = yield* Effect.context<RouteRetries>();
      const attribution = {
        agentName: usageAgentName(run.config.agent, run.config.agentSource),
        runId,
      };

      const saveDebug = (
        object: unknown,
        objectType: 'messages' | 'response',
        round: number,
        baseName: string,
        bound: BoundModel,
      ) =>
        maybeSaveDebugObject({
          object,
          objectType,
          baseName,
          continuationCount: round,
          logger,
          modelName: bound.modelId,
          runId,
          roots: session.roots,
        });

      /** The semantic request an attempt admits: the folded history, the
       *  caller's system and tools, the run as its cache key, and the last
       *  response's continuation while the binding matches its whole origin.
       *  A resume rebuilds it from the same inputs; no row copies history. */
      const turnRequestFor = (
        state: RunState,
        request: InvokeRequest,
        bound: BoundModel,
        mode: TurnRequest['mode'],
      ): TurnRequest => ({
        mode,
        ...(request.system !== undefined ? { system: request.system } : {}),
        messages: state.messages,
        ...(request.tools !== undefined ? { tools: request.tools } : {}),
        ...(request.toolChoice !== undefined
          ? { toolChoice: request.toolChoice }
          : {}),
        ...chainedContinuation(state, bound.origin),
        cacheKey: run.runId,
      });

      /**
       * The tail of the text the failing attempt had streamed, which its
       * `failed` row carries for the retry surface. Attempts of one run go
       * one at a time, so the last one written is the failure's.
       */
      let streamedTail = '';
      const failAttempt = (error: ModelError, streamedText = '') =>
        Effect.suspend(() => {
          streamedTail = streamedText;
          return Effect.fail(error);
        });

      /** Prepare one attempt's turn: a failure is the attempt's own, unsent. */
      const prepareAttempt = (bound: BoundModel, request: TurnRequest) =>
        Effect.tapError(bound.model.prepareTurn(request), () =>
          Effect.sync(() => {
            streamedTail = '';
          }),
        );

      interface AttemptTrace {
        readonly thinking: StreamHandle;
        readonly output: StreamHandle;
      }
      /** What one attempt's events leave behind: the completed turn if it
       *  arrived, and the tail of the output text seen so far. */
      interface AttemptOutcome {
        value: TurnResult | null;
        streamedText: string;
      }
      const openTrace = (): AttemptTrace => ({
        thinking: logger.openRun(MESSAGE_TYPES.THINKING, { deferStart: true }),
        output: logger.openRun(MESSAGE_TYPES.MODEL_RESPONSE, {
          deferStart: true,
        }),
      });

      /**
       * The bridge from the model's events into the trace and the run history: the
       * provider's identity becomes an `identified` row as soon as it is seen
       * (once; a background operation may report it twice), deltas stream
       * into the run's thinking and output handles, and the completed result
       * is kept for the response row.
       */
      const eventSink =
        (
          invocation: InvocationRef,
          cell: RunCell,
          trace: AttemptTrace,
          completed: AttemptOutcome,
        ) =>
        (event: TurnEvent | BackgroundEvent) =>
          Effect.gen(function* () {
            switch (event.kind) {
              case 'identified': {
                const current = yield* cell.current;
                if (
                  current.invocation?.current.providerResponseId ===
                  event.providerResponseId
                ) {
                  return;
                }
                yield* cell.append([
                  {
                    type: 'model.message',
                    aggregateId,
                    payload: {
                      kind: 'identified',
                      invocation,
                      providerResponseId: event.providerResponseId,
                    },
                  },
                ]);
                return;
              }
              case 'delta':
                if (event.part === 'reasoning') {
                  trace.thinking.append(event.text);
                } else {
                  trace.output.append(event.text);
                  // Kept for the failure path only: a completed turn reports its
                  // own text, so this tail is read when the stream dies.
                  completed.streamedText = (
                    completed.streamedText + event.text
                  ).slice(-PARTIAL_TEXT_TAIL_MAX);
                }
                return;
              case 'cursor':
                return;
              case 'completed':
                completed.value = event.result;
                return;
            }
          });

      /**
       * The tail every attempt shares once its events have been consumed: the
       * trace handles close, a failed stream classifies, an empty one is a
       * malformed output, and a completed turn is priced and committed as the
       * `response` row before any local tool runs.
       */
      const finishAttempt = Effect.fn('ModelInvoker.finish')(function* (
        cell: RunCell,
        invocation: InvocationRef,
        request: InvokeRequest,
        bound: BoundModel,
        trace: AttemptTrace,
        started: number,
        streamed: Exit.Exit<void, ModelError | InvokeError>,
        completed: AttemptOutcome,
      ): Effect.fn.Return<
        InvocationResponse,
        ModelError | InvokeError,
        FileSystem.FileSystem
      > {
        if (Exit.isFailure(streamed)) {
          trace.thinking.finalize(undefined);
          trace.output.finalize();
          if (Cause.hasInterrupts(streamed.cause))
            return yield* Effect.interrupt;
          const refused = findStorageRefusal(streamed.cause);
          if (refused) return yield* Effect.fail(refused);
          const found = Cause.findError(streamed.cause);
          if (Result.isFailure(found))
            return yield* Effect.die(Cause.squash(streamed.cause));
          return yield* found.success instanceof ModelError
            ? failAttempt(found.success, completed.streamedText)
            : Effect.fail(found.success);
        }
        const responseTimeMs = (yield* Clock.currentTimeMillis) - started;
        const turn = completed.value;
        if (turn === null) {
          trace.thinking.finalize(undefined);
          trace.output.finalize();
          return yield* failAttempt(
            new ModelError({
              kind: 'malformed-output',
              message: EMPTY_RESPONSE_ERROR_MESSAGE,
            }),
            completed.streamedText,
          );
        }
        const text = turnText(turn);
        const reasoning = turnReasoning(turn);
        trace.thinking.finalize(reasoning === '' ? undefined : reasoning);
        trace.output.finalize(text);
        yield* saveDebug(
          turn,
          'response',
          request.round,
          `${request.debugName}_response`,
          bound,
        );
        const usage = priceTurnUsage(bound, turn.usage, responseTimeMs);
        const responseId = randomUUID();
        const calls = dispatchFactsFor(
          turn.kind === 'http' ? localCallsOf(turn.content) : [],
          (yield* SynchronizedRef.get(run.steps))?.tools.registry,
          logger,
          generateShortId,
        );
        // The completed turn, committed once before any local tool runs; it
        // closes the invocation and retires its failure in the fold.
        const next = yield* cell.append((state) => [
          {
            type: 'model.message',
            aggregateId,
            payload: {
              kind: 'response',
              responseId,
              invocation,
              turn,
              calls,
              usage,
            },
          },
          positionRow(runId, state, 'response.ready'),
        ]);
        const contextSize = contextTokens(next);
        if (contextSize > 0 && bound.config.contextWindow > 0) {
          logger.emit({
            type: 'context.state',
            inputTokens: contextSize,
            contextWindow: bound.config.contextWindow,
          });
        }
        yield* reportUsage(usageLog, bound, usage, attribution, session.roots);
        return {
          kind: 'response',
          state: next,
          responseId,
          turn,
          text,
          usage,
          responseTimeMs,
        };
      });

      /**
       * One billed attempt: prepare, commit the `attempt` row, stream or
       * submit-and-observe, commit the `response` row. Preparation and the
       * events run interruptible; every append is the cell's, masked, so a
       * stop cannot split a request from its row.
       */
      const attemptOnce = Effect.fn('ModelInvoker.attempt')(function* (
        cell: RunCell,
        invocation: InvocationRef,
        request: InvokeRequest,
        bound: BoundModel,
      ): Effect.fn.Return<
        InvocationResponse,
        ModelError | InvokeError,
        FileSystem.FileSystem
      > {
        const state = yield* cell.current;
        const turnRequest = turnRequestFor(
          state,
          request,
          bound,
          yield* bound.delivery,
        );
        let resolved = yield* prepareAttempt(bound, turnRequest);
        yield* saveDebug(
          state.messages,
          'messages',
          request.round,
          request.debugName,
          bound,
        );
        // R4: the run's context size (`contextTokens`: the last response's
        // provider-counted usage plus an estimate of what was added since).
        // An input that alone exceeds the window is refused before it is
        // billed; one leaving too little room for the requested output
        // shrinks that output rather than letting the provider reject it.
        if (resolved.mode === 'foreground' && bound.config.contextWindow > 0) {
          const inputTokens = contextTokens(state);
          if (inputTokens > bound.config.contextWindow) {
            return yield* failAttempt(
              new ModelError({
                kind: 'context-overflow',
                message: `Input is ${inputTokens} tokens, which exceeds the model's context window of ${bound.config.contextWindow} tokens.`,
              }),
            );
          }
          const { controls } = resolved;
          const requested =
            'maxOutputTokens' in controls ? controls.maxOutputTokens : null;
          if (
            requested !== null &&
            inputTokens + requested > bound.config.contextWindow
          ) {
            const reduced = reducedOutputBudget(
              bound.config.contextWindow - inputTokens,
              bound.textOnly ? TOKEN_SAFETY_BUFFER : TOOL_USE_SAFETY_BUFFER,
            );
            logContextManagementEvent(
              logger,
              `Token count (${inputTokens}) + max output tokens (${requested}) exceeds context window (${bound.config.contextWindow}). Reducing to ${reduced}.`,
              {
                action: 'max_tokens_reduced',
                tokensBefore: inputTokens,
                contextWindow: bound.config.contextWindow,
                utilizationBefore: roundedUtilizationPercent(
                  inputTokens,
                  bound.config.contextWindow,
                ),
                originalMaxTokens: requested,
                reducedMaxTokens: reduced,
                details: request.debugName,
              },
            );
            // The clamp is part of the request, so it is prepared again:
            // execution never reapplies defaults over a resolved turn.
            resolved = yield* prepareAttempt(bound, {
              ...turnRequest,
              maxOutputTokens: reduced,
            });
          }
        }
        // The durable fact before the billed request (F1), with the prepared
        // turn it sends, which the rows alone must rebuild.
        yield* cell.append((state) =>
          attemptRows(run, state, invocation, 'turn', bound.origin, resolved),
        );
        yield* checkRecordedRequest(run, resolved);
        const trace = openTrace();
        const started = yield* Clock.currentTimeMillis;
        const completed: AttemptOutcome = { value: null, streamedText: '' };
        const onEvent = eventSink(invocation, cell, trace, completed);
        const streamed = yield* Effect.exit(
          resolved.mode === 'foreground'
            ? Stream.runForEach(bound.model.streamTurn(resolved), onEvent)
            : submitAndObserve(
                run,
                cell,
                resolved,
                invocation,
                bound,
                onEvent,
                completed,
              ),
        );
        return yield* finishAttempt(
          cell,
          invocation,
          request,
          bound,
          trace,
          started,
          streamed,
          completed,
        );
      });

      /**
       * A resumed attempt whose background operation the rows hold: observe
       * the turn they recorded under its recorded deadline, never resubmit;
       * unbilled, so outside the route gate.
       */
      const observeAccepted = Effect.fn('ModelInvoker.observeAccepted')(
        function* (
          cell: RunCell,
          invocation: InvocationRef,
          request: InvokeRequest,
          bound: BoundModel,
          accepted: NonNullable<Attempt['accepted']>,
        ): Effect.fn.Return<
          InvocationResponse,
          ModelError | InvokeError,
          FileSystem.FileSystem
        > {
          const background = bound.model.background;
          if (background === undefined) {
            return yield* failAttempt(
              new ModelError({
                kind: 'unsupported',
                message:
                  'The run resumed onto a model that cannot observe its accepted background operation.',
              }),
            );
          }
          const resolved = admittedTurn(yield* cell.current);
          const trace = openTrace();
          const started = yield* Clock.currentTimeMillis;
          const completed: AttemptOutcome = { value: null, streamedText: '' };
          const streamed = yield* Effect.exit(
            observeBackground(
              run,
              cell,
              background,
              resolved,
              invocation,
              accepted,
              eventSink(invocation, cell, trace, completed),
            ),
          );
          return yield* finishAttempt(
            cell,
            invocation,
            request,
            bound,
            trace,
            started,
            streamed,
            completed,
          );
        },
      );

      /**
       * Rebind on `selection`, retiring the failed binding, on the routes
       * the run declines as its rows now stand; a failure keeps it, loudly.
       */
      const rebind =
        (cell: RunCell) =>
        (selection: RetryCredentials | 'renewed', failed: BoundModel) =>
          Effect.flatMap(cell.current, ({ declinedRoutes }) =>
            run.swapModel((current) =>
              // A switch may have landed while the panel waited; never undo it.
              current !== failed
                ? Effect.succeed(current)
                : access.bind({
                    modelId: failed.modelId,
                    // A personal-key retry leaves the failed route's overlay
                    // behind (subscription window, prices, PDF admission, a
                    // Kimi coding endpoint) and binds the catalog model.
                    config:
                      selection === 'personal' ? undefined : failed.config,
                    backend: failed.backend,
                    declinedRoutes,
                    textOnly: failed.textOnly,
                    temperature: run.persona.temperature,
                    renew: selection === 'renewed',
                  }),
            ),
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                logger.warn('Failed to refresh the model binding', {
                  data: error,
                }),
              ),
            ),
            Effect.result,
          );

      /**
       * The batch that ends attempt `ref` as `failed` with `error`. One that
       * asks opens its retry request first, with the credential move the
       * failure offers and, where the policy or an automatic quota fallback
       * answers at once, that answer, so no surface lists it pending.
       */
      const failedRows = Effect.fn('ModelInvoker.failedRows')(function* (
        cell: RunCell,
        ref: InvocationRef,
        error: RetryErrorInfo,
        next: FailedNext,
        bound: BoundModel,
      ): Effect.fn.Return<readonly RunHistoryDraft[]> {
        const failed: RunHistoryDraft = {
          type: 'model.message',
          aggregateId,
          payload: {
            kind: 'failed',
            invocation: ref,
            purpose: 'turn',
            error,
            next,
          },
        };
        if (next.kind !== 'ask') return [failed];
        const { requestId } = next;
        const credentialSwitch = yield* access.credentialSwitch(
          bound,
          error,
          (yield* cell.current).declinedRoutes,
        );
        const automatic =
          credentialSwitch?.kind === 'decline-route' &&
          credentialSwitch.automatic
            ? quotaFallbackRouteFor(credentialSwitch.route)
            : null;
        if (automatic !== null) {
          logProgressStatus(
            logger,
            `${automatic.retrySourceName} usage limit reached; retrying with ${automatic.retryFallbackName}.`,
          );
        }
        const payload = {
          kind: 'retry',
          data: {
            requestId,
            runId,
            operation: 'Model request',
            model: bound.modelId,
            errorMessage: error.message,
            errorDetails: error,
            credentialSwitch,
          },
        } as const;
        return [
          {
            type: 'request.opened',
            aggregateId,
            requestId,
            payload,
          },
          failed,
          ...(automatic
            ? [{ ...PERSONAL_RETRY, aggregateId, requestId }]
            : policyDecidedRows(session, runId, payload)),
        ];
      });

      const invoke = Effect.fn('ModelInvoker.invoke')(function* (
        cell: RunCell,
        request: InvokeRequest,
      ): Effect.fn.Return<InvocationOutcome, InvokeError, InvokeServices> {
        const ended = yield* runInvocation<
          InvocationResponse,
          InvokeError,
          FileSystem.FileSystem
        >({
          read: cell.current,
          binding: SynchronizedRef.get(run.model),
          rebind: rebind(cell),
          attempt: (bound, ref, accepted) =>
            accepted === null
              ? attemptOnce(cell, ref, request, bound)
              : observeAccepted(cell, ref, request, bound, accepted),
          failed: (ref, { error, unsent }, next, bound) =>
            Effect.gen(function* () {
              const info = failureInfo(error, bound.config.provider, {
                partialText: unsent ? undefined : streamedTail,
                unsent,
              });
              if (next.kind === 'ask' || next.kind === 'stop')
                yield* logProviderError(
                  logger,
                  next.kind === 'ask'
                    ? 'Model request failed'
                    : 'Model request failed (no retry available)',
                  { ...info, rawErrorBody: error.cause },
                );
              yield* cell.append(
                yield* failedRows(cell, ref, info, next, bound),
              );
              return info;
            }),
          asker: {
            requestId: () => `retry-${generateShortId()}`,
            await: (requestId) =>
              Effect.gen(function* () {
                logger.debug('Waiting for manual retry');
                // The answer is the `request.decided` row (R5) the decide
                // command lands; a closing plane cancels.
                const row = yield* session.requests
                  .decision(runId, requestId, (yield* cell.current).commit)
                  .pipe(
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        logger.warn(
                          'The retry prompt closed before a decision',
                          { data: error },
                        );
                        return null;
                      }),
                    ),
                  );
                if (row === null) return false;
                yield* cell.refresh;
                return true;
              }),
            reask: (attempt) =>
              Effect.gen(function* () {
                const bound = yield* SynchronizedRef.get(run.model);
                yield* cell.append(
                  yield* failedRows(
                    cell,
                    attempt.ref,
                    {
                      message: INTERRUPTED_RETRY_MESSAGE,
                      provider: bound.config.provider,
                      userRetryable: true,
                    },
                    { kind: 'ask', requestId: `retry-${generateShortId()}` },
                    bound,
                  ),
                );
              }),
          },
          chains: (bound) =>
            Effect.map(
              cell.current,
              (state) =>
                'continuation' in chainedContinuation(state, bound.origin),
            ),
          retries: (yield* SynchronizedRef.get(run.model)).automaticRetries,
          logger,
        });
        if (ended.kind === 'response') return ended;
        const state = yield* cell.current;
        if (ended.kind === 'failed')
          return { kind: 'failed', state, error: ended.error };
        logProgressStatus(logger, 'Retry cancelled by user');
        return { kind: 'cancelled', state };
      });

      /** A compaction summary on the run's binding; its caller lands it. */
      const call = (cell: RunCell, request: TurnRequest) =>
        callModel({
          purpose: 'compaction',
          binding: SynchronizedRef.get(run.model),
          reacquire: (failed, renew) =>
            rebind(cell)(renew ? 'renewed' : 'configured', failed),
          request,
          settings: session.roots,
          attribution,
          logger,
          record: {
            attempt: (ref, bound, resolved) =>
              cell
                .append((state) =>
                  attemptRows(
                    run,
                    state,
                    ref,
                    'summary',
                    bound.origin,
                    resolved,
                  ),
                )
                .pipe(Effect.as(attemptRequest(run, resolved))),
            failed: (ref, error, next) =>
              Effect.asVoid(
                cell.append([
                  {
                    type: 'model.message',
                    aggregateId,
                    payload: {
                      kind: 'failed',
                      invocation: ref,
                      purpose: 'summary',
                      error,
                      next,
                    },
                  },
                ]),
              ),
          },
        }).pipe(
          Effect.provideService(UsageLog, usageLog),
          Effect.provideContext(gate),
        );

      return { invoke, call };
    }),
  );
