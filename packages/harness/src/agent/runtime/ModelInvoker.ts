/**
 * The one service that touches the llm `Model` for a run. One `invoke` is
 * one turn with its billed attempts: the `TurnRequest` assembled from the
 * folded `RunState`, `prepareTurn`, the `attempt` row committed before the
 * request leaves the process, `identified` when the provider names the
 * response, the stream bridged into the trace, and the `response` row with
 * its dispatch facts and priced usage committed before any tool runs.
 * `call` is a compaction summary on the same binding, gate and pricing, off
 * the rows (`run/modelCall.ts`): its usage rides the edit its caller lands.
 *
 * A turn's retry loop is `invoke` over the invocation's rows: `nextAttempt`
 * reads the next move off them, so the loop keeps no count and no permit of
 * its own and a resume continues the same series under the same budget.
 * Each failed attempt commits a `failed` row with the move after it, an
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
  fillModelError,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm';

import { maybeSaveDebugObject } from '@agent/debug/debugMessageSaver';
import type { StreamHandle } from '@agent/trace/AgentTrace';
import {
  logContextManagementEvent,
  logProviderError,
} from '@agent/trace/helpers';
import {
  failureInfo,
  type CallFailure,
} from '@agent/runtime/modelAccess/failureInfo';
import {
  ModelAccess,
  type BoundModel,
} from '@agent/runtime/modelAccess/ModelAccess';
import { RouteUnavailable } from '@common/errors/agentErrors';
import { quotaFallbackMessage } from '@common/errors/sdkError/providerErrorFormat';
import { SessionRoots } from '@platform/rootedFs';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  MESSAGE_TYPES,
  qualifyAggregateId,
  type FailedNext,
  type InvocationRef,
  type RetryErrorInfo,
  type NormalizedUsage,
} from '@shared/schemas';
import type { DatabaseReadFailed } from '@shared/session/database';
import type { HistoryMessage } from '@shared/session/historyTurns';
import {
  failedNext,
  failuresBefore,
  nextAttempt,
  type Attempt,
  type Invocation,
  type NextAttempt,
  type RetryCredentials,
} from '@shared/session/inFlight';
import { turnText } from '@shared/session/runFacts';
import {
  findStorageRefusal,
  runRefusal,
  SessionLog,
  type CellError,
  type RunCell,
} from '@shared/session/runHistory';
import type { StateReadFailed } from '@shared/config/settings';
import type { RunHistoryDraft, RunState } from '@shared/session/runState';
import { UsageLog, usageAgentName } from '@shared/usageLog';

import { RouteRetries } from './ModelRetryGate';
import { decisionOf, policyDecidedRows } from './requests';
import { AgentRun } from './run/AgentRun';
import { callModel, RETRY_BACKOFF_MS, type CallResult } from './run/modelCall';
import { observeBackground, submitAndObserve } from './run/backgroundTurn';
import { contextTokens, outputBudget } from './run/contextTokens';
import { priceTurnUsage, reportUsage } from './run/pricing';
import {
  admittedTurn,
  attemptRows,
  chainedContinuation,
  checkRecordedRequest,
  type InvokeRequest,
} from './run/requestContext';
import { providerMessages } from './storedTurn';
import { dispatchFactsFor, localCallsOf } from './run/tools';
import { positionRow } from './loop/rows';
import type { SessionServices } from './rootLaunch';

/** The answer the invoker gives itself for an automatic quota fallback. */
const PERSONAL_RETRY = {
  type: 'request.decided',
  decision: { action: 'retry', credentials: 'personal' },
} as const;

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/** What a person is asked before an attempt the process stopped during is
 *  sent again: one they approved, or one past the automatic retries. */
const INTERRUPTED_RETRY_MESSAGE =
  'The process stopped while a model request was running, so it may have been billed without an answer. Retry again?';

/**
 * How much of a failed attempt's streamed output the failure carries. The
 * retry surface shows the tail so the user sees the work was not lost; the
 * bound keeps a long generation out of the error and off the run history row.
 */
const PARTIAL_TEXT_TAIL_MAX = 4096;

interface InvocationResponse {
  readonly kind: 'response';
  readonly state: RunState;
}

/** A failure's error is the run state's `lastError`. */
type InvocationOutcome =
  | InvocationResponse
  | { readonly kind: 'failed'; readonly state: RunState }
  | { readonly kind: 'cancelled'; readonly state: RunState };

/**
 * The run history failures `invoke` can hand back. One definition: the dispatch
 * path in `loop/toolUseDispatch` branches on the same union, so it imports
 * this rather than re-declaring the alias.
 */
export type InvokeError = CellError | StateReadFailed | DatabaseReadFailed;

/** What one attempt reads: its files, and its run's session. */
type AttemptServices = FileSystem.FileSystem | SessionServices;

/** A failed attempt: llm's verdict, or no route to send it on. */
const isCallFailure = (error: unknown): error is CallFailure =>
  error instanceof ModelError || error instanceof RouteUnavailable;

/**
 * One failure of an attempt. `unsent` marks a binding that could not be
 * replaced (a renewal or a rebind that failed): nothing was sent, and no
 * retry repeats it.
 */
interface AttemptFailure {
  readonly error: CallFailure;
  readonly unsent: boolean;
}

/** The next attempt's reference: the invocation's next, or a new one. */
const nextRef = (invocation: Invocation | null): InvocationRef =>
  invocation === null
    ? { invocationId: randomUUID(), attempt: 1 }
    : {
        invocationId: invocation.current.ref.invocationId,
        attempt: invocation.current.ref.attempt + 1,
      };

export class ModelInvoker extends Context.Service<
  ModelInvoker,
  {
    readonly invoke: (
      cell: RunCell,
      request: InvokeRequest,
    ) => Effect.Effect<InvocationOutcome, InvokeError, AttemptServices>;
    /** A compaction summary: one call off the rows, on the run's binding.
     *  Its messages are the history's, media by address; the call resolves
     *  them. */
    readonly call: (
      cell: RunCell,
      request: Omit<TurnRequest, 'messages'> & {
        readonly messages: readonly HistoryMessage[];
      },
    ) => Effect.Effect<CallResult, Error>;
  }
>()('@texra-ai/harness/agent/ModelInvoker') {}

/**
 * Build a request service for one run; its model is run-owned, and every row
 * it writes goes through the run cell the loop hands each invocation.
 */
export const modelInvokerLayer = (): Layer.Layer<
  ModelInvoker,
  never,
  AgentRun | UsageLog | ModelAccess | RouteRetries | SessionServices
> =>
  Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const { runId, logger } = run;
      const log = yield* SessionLog;
      const roots = yield* SessionRoots;
      const aggregateId = qualifyAggregateId('run', runId);
      const usageLog = yield* UsageLog;
      /** When each attempt was sent, by its reference, for pricing a failure
       *  the provider billed by the time it took. */
      const attemptStarts = new WeakMap<InvocationRef, number>();
      const access = yield* ModelAccess;
      const gate = yield* RouteRetries;
      const attribution = {
        agentName: usageAgentName(run.config.agent, run.config.agentSource),
        runId,
      };

      const saveDebug = (
        object: unknown,
        objectType: 'messages' | 'response',
        invocation: InvocationRef,
        bound: BoundModel,
      ) =>
        maybeSaveDebugObject({
          object,
          objectType,
          invocation,
          logger,
          modelName: bound.modelId,
          runId,
          roots,
        });

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
        (event: TurnEvent) =>
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
          if (refused) return yield* runRefusal(runId, refused);
          const found = Cause.findError(streamed.cause);
          if (Result.isFailure(found))
            return yield* Effect.die(Cause.squash(streamed.cause));
          return yield* found.success instanceof ModelError
            ? Effect.fail(
                fillModelError(found.success, {
                  partialText: completed.streamedText,
                }),
              )
            : Effect.fail(found.success);
        }
        const responseTimeMs = (yield* Clock.currentTimeMillis) - started;
        const turn = completed.value;
        if (turn === null) {
          trace.thinking.finalize(undefined);
          trace.output.finalize();
          return yield* new ModelError({
            kind: 'provider-rejection',
            message: EMPTY_RESPONSE_ERROR_MESSAGE,
            partialText: completed.streamedText,
          });
        }
        const text = turnText(turn);
        const reasoning = turn.content
          .flatMap((part) =>
            part.kind === 'reasoning'
              ? (part.content ?? part.summary).map((piece) => piece.text)
              : [],
          )
          .join('\n');
        trace.thinking.finalize(reasoning === '' ? undefined : reasoning);
        trace.output.finalize(text);
        yield* saveDebug(turn, 'response', invocation, bound);
        const usage = priceTurnUsage(bound, turn.usage, responseTimeMs);
        const responseId = randomUUID();
        const calls = dispatchFactsFor(
          localCallsOf(turn.content),
          (yield* SynchronizedRef.get(run.steps))?.tools.registry,
          logger,
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
        yield* reportUsage(usageLog, bound, usage, attribution, roots);
        return { kind: 'response', state: next };
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
        AttemptServices
      > {
        const state = yield* cell.current;
        const mode = yield* bound.delivery;
        yield* saveDebug(state.messages, 'messages', invocation, bound);
        // What the window leaves a foreground request (`outputBudget`); a
        // background one is the provider's to size.
        const { contextWindow } = bound.config;
        const budget =
          mode === 'background' ? null : outputBudget(state, bound);
        if (budget?.kind === 'overflow')
          return yield* new ModelError({
            kind: 'context-overflow',
            message: `Input is ${budget.inputTokens} tokens, which exceeds the model's context window of ${contextWindow} tokens.`,
          });
        const maxOutputTokens =
          budget?.kind === 'reduced' ? budget.maxOutputTokens : undefined;
        if (budget?.kind === 'reduced')
          logContextManagementEvent(
            logger,
            `Token count (${budget.inputTokens}) + max output tokens (${budget.limit}) exceeds context window (${contextWindow}). Reducing to ${maxOutputTokens}.`,
            {
              action: 'max_tokens_reduced',
              tokensBefore: budget.inputTokens,
              contextWindow,
              utilizationBefore: roundedUtilizationPercent(
                budget.inputTokens,
                contextWindow,
              ),
              originalMaxTokens: budget.limit,
              reducedMaxTokens: budget.maxOutputTokens,
              details: 'tooluse',
            },
          );
        // The request an attempt admits: the folded history with its media
        // resolved (the one read of media bytes), the caller's system and
        // tools, the run as its cache key, and the last response's
        // continuation while the binding matches its whole origin. A resume
        // rebuilds it from the same inputs; no row copies history.
        const resolved = yield* bound.model.prepareTurn({
          mode,
          ...(request.system !== undefined ? { system: request.system } : {}),
          messages: yield* providerMessages(state.messages, log.blobs),
          ...(request.tools !== undefined ? { tools: request.tools } : {}),
          ...(request.toolChoice !== undefined
            ? { toolChoice: request.toolChoice }
            : {}),
          ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
          ...chainedContinuation(state, bound.origin),
          cacheKey: run.runId,
        });
        // The durable fact before the billed request, with the prepared
        // turn it sends, which the rows alone must rebuild.
        yield* cell.append((state) =>
          attemptRows(run, state, invocation, bound.origin, resolved),
        );
        yield* checkRecordedRequest(run, resolved);
        const trace = openTrace();
        const started = yield* Clock.currentTimeMillis;
        attemptStarts.set(invocation, started);
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
          bound: BoundModel,
          accepted: NonNullable<Attempt['accepted']>,
        ): Effect.fn.Return<
          InvocationResponse,
          ModelError | InvokeError,
          AttemptServices
        > {
          const background = bound.model.background;
          if (background === undefined) {
            return yield* new ModelError({
              kind: 'invalid-request',
              message:
                'The run resumed onto a model that cannot observe its accepted background operation.',
            });
          }
          const resolved = yield* admittedTurn(yield* cell.current, log.blobs);
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
            bound,
            trace,
            started,
            streamed,
            completed,
          );
        },
      );

      /** Rebind on `selection`, retiring the failed binding, on the routes
       *  the run declines as its rows now stand; a failure keeps it, loudly.
       *  A renew names the token the provider rejected. */
      const rebind = (
        cell: RunCell,
        selection: RetryCredentials | 'renewed',
        failed: BoundModel,
      ): Effect.Effect<BoundModel, CallFailure> =>
        Effect.flatMap(cell.current, ({ declinedRoutes }) =>
          run.swapModel((current) =>
            // A switch may have landed while the panel waited; never undo it.
            current !== failed
              ? Effect.succeed(current)
              : access.bind({
                  modelId: failed.modelId,
                  // A personal-key retry drops the route's overlay (window,
                  // prices, PDF admission, Kimi endpoint) for the catalog's.
                  config: selection === 'personal' ? undefined : failed.config,
                  backend: failed.backend,
                  declinedRoutes,
                  textOnly: failed.textOnly,
                  temperature: run.persona.temperature,
                  ...(selection === 'renewed' && {
                    rejected: failed.subscriptionToken,
                  }),
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
        );

      /**
       * The batch that ends attempt `ref` as `failed` with `error`. One that
       * asks opens its retry request first, with the credential move a
       * used-up `quota` offers and, where the policy or an automatic quota
       * fallback answers at once, that answer, so no surface lists it pending.
       */
      const failedRows = Effect.fn('ModelInvoker.failedRows')(function* (
        cell: RunCell,
        ref: InvocationRef,
        error: RetryErrorInfo,
        next: FailedNext,
        bound: BoundModel,
        usage: NormalizedUsage | null,
        quota: ModelError['quota'],
      ): Effect.fn.Return<readonly RunHistoryDraft[], never, SessionServices> {
        const failed: RunHistoryDraft = {
          type: 'model.message',
          aggregateId,
          payload: {
            kind: 'failed',
            invocation: ref,
            error,
            next,
            ...(usage === null ? {} : { usage }),
          },
        };
        if (next.kind !== 'ask') return [failed];
        const { requestId } = next;
        const credentialSwitch = yield* access.credentialSwitch(
          bound,
          quota,
          (yield* cell.current).declinedRoutes,
        );
        const automatic =
          credentialSwitch?.kind === 'decline-route' &&
          credentialSwitch.automatic
            ? credentialSwitch
            : null;
        if (automatic !== null) {
          // The notice records the route it moved off; an app words it.
          logger.info(quotaFallbackMessage(automatic), {
            messageType: MESSAGE_TYPES.QUOTA_FALLBACK,
            data: { route: automatic.route },
          });
        }
        const payload = {
          kind: 'retry',
          data: {
            requestId,
            runId,
            operation: 'Model request',
            model: bound.modelId,
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
            : yield* policyDecidedRows(runId, payload)),
        ];
      });

      /** Record the failure of attempt `ref` and the move after it. */
      const recordFailure = Effect.fn('ModelInvoker.failed')(function* (
        cell: RunCell,
        ref: InvocationRef,
        { error }: AttemptFailure,
        next: FailedNext,
        bound: BoundModel,
      ): Effect.fn.Return<void, InvokeError, SessionServices> {
        const info = failureInfo(error, bound.config.provider);
        const quota = error instanceof ModelError ? error.quota : undefined;
        if (next.kind === 'ask' || next.kind === 'stop')
          yield* logProviderError(
            logger,
            next.kind === 'ask'
              ? 'Model request failed'
              : 'Model request failed (no retry available)',
            { ...info, rawErrorBody: error.cause },
          );
        // A response the provider billed before refusing it is priced
        // and reported like a turn's, on its `failed` row.
        const started = attemptStarts.get(ref);
        const usage =
          error instanceof ModelError &&
          error.usage !== undefined &&
          started !== undefined
            ? priceTurnUsage(
                bound,
                error.usage,
                (yield* Clock.currentTimeMillis) - started,
              )
            : null;
        yield* reportUsage(usageLog, bound, usage, attribution, roots);
        yield* cell.append(
          yield* failedRows(cell, ref, info, next, bound, usage, quota),
        );
      });

      /** The move after `failure` of attempt `ref`, read off the attempts
       *  before it, llm's verdict and the budget. */
      const moveAfter = (
        cell: RunCell,
        { error, unsent }: AttemptFailure,
        ref: InvocationRef,
        observed: boolean,
        retries: number,
      ): Effect.Effect<FailedNext> =>
        Effect.map(cell.current, ({ invocation }) =>
          failedNext(
            failuresBefore(invocation, ref),
            {
              // A failed observation is never resubmitted unasked: the work
              // it watched was already billed.
              unchain:
                !observed &&
                error instanceof ModelError &&
                error.kind === 'continuation-gone',
              automatic:
                !observed &&
                !unsent &&
                error instanceof ModelError &&
                error.retryable,
              // A person is offered a retry whenever llm says the same
              // request can succeed, and after a used-up quota, whose retry
              // carries the switch onto their own credential; a missing
              // route is fixed outside the run.
              offered:
                !unsent &&
                error instanceof ModelError &&
                (error.retryable || error.quota !== undefined),
            },
            retries,
            `retry-${randomUUID()}`,
          ),
        );

      /**
       * Make the attempt `move` names on `bound`: a send under the process's
       * route gate, so every run on one credential shares cooling, or an
       * observation, unbilled, outside it. An interruption stays the run's
       * and a refused write its own; anything else is a defect.
       */
      const tryAttempt = (
        cell: RunCell,
        request: InvokeRequest,
        move: Extract<NextAttempt, { kind: 'send' | 'observe' }>,
        ref: InvocationRef,
        bound: BoundModel,
      ): Effect.Effect<
        { readonly ok: InvocationResponse } | AttemptFailure,
        InvokeError,
        AttemptServices
      > =>
        Effect.exit(
          move.kind === 'send'
            ? gate.withRoutes(bound.routes, {
                baseBackoffMs: RETRY_BACKOFF_MS,
                onWait: (delayMs) =>
                  logger.debug(
                    `Waiting ${delayMs}ms for the model recovery probe.`,
                  ),
              })(attemptOnce(cell, ref, request, bound))
            : observeAccepted(cell, ref, bound, move.attempt.accepted),
        ).pipe(
          Effect.flatMap(
            (
              exit,
            ): Effect.Effect<
              { readonly ok: InvocationResponse } | AttemptFailure,
              InvokeError
            > => {
              if (Exit.isSuccess(exit))
                return Effect.succeed({ ok: exit.value });
              if (Cause.hasInterrupts(exit.cause)) return Effect.interrupt;
              const found = Cause.findError(exit.cause);
              if (Result.isFailure(found))
                return Effect.die(Cause.squash(exit.cause));
              const error = found.success;
              return isCallFailure(error)
                ? Effect.succeed({ error, unsent: false })
                : Effect.fail(error);
            },
          ),
        );

      /** Wait for the answer to the open retry request: the
       *  `request.decided` row the decide command lands; false when nobody
       *  will answer it (the session closed first). */
      const awaitDecision = Effect.fn('ModelInvoker.await')(function* (
        cell: RunCell,
        requestId: string,
      ): Effect.fn.Return<boolean, InvokeError> {
        logger.debug('Waiting for manual retry');
        const row = yield* decisionOf(
          runId,
          requestId,
          (yield* cell.current).commit,
        ).pipe(
          Effect.provideService(SessionLog, log),
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn('The retry prompt closed before a decision', {
                data: error,
              });
              return null;
            }),
          ),
        );
        if (row === null) return false;
        yield* cell.refresh;
        return true;
      });

      /** Ask again about `attempt`, whose outcome no row records: one a
       *  person allowed, or one past the automatic retries. */
      const reask = Effect.fn('ModelInvoker.reask')(function* (
        cell: RunCell,
        attempt: Attempt,
      ): Effect.fn.Return<void, InvokeError, SessionServices> {
        const bound = yield* SynchronizedRef.get(run.model);
        yield* cell.append(
          yield* failedRows(
            cell,
            attempt.ref,
            {
              message: INTERRUPTED_RETRY_MESSAGE,
              provider: bound.config.provider,
            },
            { kind: 'ask', requestId: `retry-${randomUUID()}` },
            bound,
            null,
            undefined,
          ),
        );
      });

      /** The turn as it ends without a response: the state its rows left. */
      const endedAs = (
        cell: RunCell,
        kind: 'failed' | 'cancelled',
      ): Effect.Effect<InvocationOutcome> =>
        Effect.map(cell.current, (state) => {
          if (kind === 'cancelled')
            logger.info('Retry cancelled by user', {
              messageType: MESSAGE_TYPES.PROGRESS_STATUS,
            });
          return { kind, state };
        });

      /**
       * Drive one turn's invocation to its response or its end: read the
       * next move off its rows, make it, and, when an attempt fails, record
       * why and what follows.
       */
      const invoke = Effect.fn('ModelInvoker.invoke')(function* (
        cell: RunCell,
        request: InvokeRequest,
      ): Effect.fn.Return<InvocationOutcome, InvokeError, AttemptServices> {
        const retries = (yield* SynchronizedRef.get(run.model))
          .automaticRetries;
        // Once per invocation, a subscription access token the provider
        // rejects before its stored expiry (revoked, or expired server-side)
        // is renewed: the binding rebound on a refreshed session and the
        // attempt made again on it, an observation unrecorded. A renewal
        // that fails takes the rejection's place as an unsent failure, so
        // the user reads the "sign in again" instruction rather than "token
        // is expired", and no retry resends the rejected token.
        let renewed = false;
        let again: NextAttempt | null = null;
        for (;;) {
          const { invocation, requests } = yield* cell.current;
          const move: NextAttempt =
            again ?? nextAttempt(invocation, requests, retries);
          again = null;
          if (move.kind === 'fail') return yield* endedAs(cell, 'failed');
          if (move.kind === 'cancel') return yield* endedAs(cell, 'cancelled');
          if (move.kind === 'await') {
            if (!(yield* awaitDecision(cell, move.requestId)))
              return yield* endedAs(cell, 'cancelled');
            continue;
          }
          if (move.kind === 'reask') {
            yield* reask(cell, move.attempt);
            continue;
          }
          const ref =
            move.kind === 'observe' ? move.attempt.ref : nextRef(invocation);
          if (move.kind === 'send' && move.retry !== null) {
            // Rebind before sending `ref` on a person's retry answer. A
            // failed rebind is `ref`'s failure, recorded unsent, so nothing
            // goes out on the binding it meant to leave.
            const bound = yield* SynchronizedRef.get(run.model);
            const rebound = yield* Effect.result(
              rebind(cell, move.retry, bound),
            );
            if (Result.isFailure(rebound)) {
              const failure = { error: rebound.failure, unsent: true };
              const next = yield* moveAfter(cell, failure, ref, false, retries);
              yield* recordFailure(cell, ref, failure, next, bound);
              continue;
            }
          }
          const bound = yield* SynchronizedRef.get(run.model);
          const tried = yield* tryAttempt(cell, request, move, ref, bound);
          if ('ok' in tried) return tried.ok;
          const observed = move.kind === 'observe';
          let failure: AttemptFailure = tried;
          let next: FailedNext | null = null;
          if (
            !renewed &&
            tried.error instanceof ModelError &&
            tried.error.kind === 'authentication' &&
            bound.subscriptionToken !== undefined
          ) {
            renewed = true;
            const rebound = yield* Effect.result(
              rebind(cell, 'renewed', bound),
            );
            if (Result.isSuccess(rebound)) {
              if (observed) {
                again = move;
                continue;
              }
              next = { kind: 'retry' };
            } else failure = { error: rebound.failure, unsent: true };
          }
          next ??= yield* moveAfter(cell, failure, ref, observed, retries);
          yield* recordFailure(cell, ref, failure, next, bound);
          if (next.kind === 'stop') return yield* endedAs(cell, 'failed');
          if (next.kind !== 'retry' && next.kind !== 'unchain') continue;
          // The pause before an automatic resend, unchained or not: as long
          // as the provider asked, else the base backoff; none for a failure
          // llm scoped to a route, which the gate cools and waits out before
          // the next send.
          const vendor =
            failure.error instanceof ModelError ? failure.error : undefined;
          const delayMs =
            vendor?.scope !== undefined
              ? 0
              : (vendor?.retryAfterMs ?? RETRY_BACKOFF_MS);
          if (next.kind === 'unchain')
            logger.warn(
              `Chained response gone (${failure.error.message}); retrying once with the full transcript.`,
            );
          else
            logger.debug(
              `Model request failed; automatic retry in ${delayMs}ms.`,
              { data: failure.error.message },
            );
          if (delayMs > 0) yield* Effect.sleep(delayMs);
        }
      });

      /** A compaction summary on the run's binding; its caller lands it. */
      const call: ModelInvoker['Service']['call'] = (cell, request) =>
        Effect.flatMap(
          providerMessages(request.messages, log.blobs),
          (messages) =>
            callModel({
              binding: SynchronizedRef.get(run.model),
              renew: (failed) => rebind(cell, 'renewed', failed),
              request: { ...request, messages },
              settings: roots,
              attribution,
              debug: (message) => Effect.sync(() => logger.debug(message)),
            }).pipe(
              Effect.provideService(UsageLog, usageLog),
              Effect.provideService(RouteRetries, gate),
            ),
        );

      return { invoke, call };
    }),
  );
