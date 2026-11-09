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
  ScopedRef,
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

import { saveModelIOIfEnabled } from '@agent/debug/debugMessageSaver';
import {
  logContextManagementEvent,
  logProviderError,
} from '@agent/trace/traceLogs';
import {
  routeFailureOf,
  type CallFailure,
} from '@agent/runtime/modelAccess/failureInfo';
import {
  ModelAccess,
  type BoundModel,
} from '@agent/runtime/modelAccess/ModelAccess';
import { RouteUnavailable } from '@common/errors/agentErrors';
import {
  modelFailureOf,
  quotaFallbackMessage,
} from '@common/errors/sdkError/providerErrorFormat';
import { SessionRoots } from '@platform/rootedFs';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  MESSAGE_TYPES,
  qualifyAggregateId,
  type StepAfterFailure,
  type InvocationRef,
  type ModelFailure,
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

import { resendDelayMs, RouteRetries } from './ModelRetryGate';
import { decisionOf, policyDecidedRows } from './requests';
import { AgentRun } from './run/AgentRun';
import { callModel, type ModelCallResult } from './run/modelCall';
import { observeBackground, submitAndObserve } from './run/backgroundTurn';
import { contextTokens, outputBudget } from './run/contextTokens';
import { priceTurnUsage, reportUsage } from './run/pricing';
import {
  admittedTurn,
  attemptRows,
  chainedContinuation,
  checkRecordedRequest,
  type InvokeRequest,
} from './run/recordedRequest';
import { providerMessages } from './providerMessages';
import { dispatchFactsFor, localCallsOf } from './run/tools';
import { configRow, positionRow } from './loop/rows';
import type { SessionServices } from './rootLaunch';

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/**
 * How much of a failed attempt's streamed output the failure carries. The
 * retry surface shows the tail so the user sees the work was not lost; the
 * bound keeps a long generation out of the error and off the run history row.
 */
const PARTIAL_TEXT_TAIL_MAX = 4096;

/** The monotonic clock in milliseconds. A response time is the difference
 *  of two readings, which a wall-clock step cannot make negative. */
const monotonicMillis = Effect.map(
  Clock.monotonicTimeNanos,
  (nanos) => Number(nanos) / 1e6,
);

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
    ) => Effect.Effect<ModelCallResult, Error>;
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
        saveModelIOIfEnabled({
          object,
          objectType,
          invocation,
          logger,
          modelName: bound.modelId,
          runId,
          roots,
        });

      /**
       * One attempt from its first event to its `response` row. The
       * provider's identity becomes an `identified` row as soon as it is
       * seen (once; a background operation may report it twice), deltas
       * stream into the run's thinking and output handles, and the
       * completed result is kept. Then the handles close, a failed stream
       * classifies, an empty one is a malformed output, and a completed
       * turn is priced and committed as the `response` row before any
       * local tool runs. `started` is when the request went out, on
       * {@link monotonicMillis}.
       */
      const consume = Effect.fn('ModelInvoker.consume')(function* (
        cell: RunCell,
        invocation: InvocationRef,
        bound: BoundModel,
        started: number,
        events: Stream.Stream<TurnEvent, ModelError | InvokeError, SessionLog>,
      ): Effect.fn.Return<
        InvocationResponse,
        ModelError | InvokeError,
        FileSystem.FileSystem | SessionLog
      > {
        const trace = {
          thinking: logger.openRun(MESSAGE_TYPES.THINKING),
          output: logger.openRun(MESSAGE_TYPES.MODEL_RESPONSE),
        };
        // What the events leave behind: the completed turn if it arrived,
        // and the tail of the output text seen so far.
        const completed: {
          value: TurnResult | null;
          streamedText: string;
        } = { value: null, streamedText: '' };
        const onEvent = Effect.fnUntraced(function* (event: TurnEvent) {
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
                // Kept for the failure path only: a completed turn reports
                // its own text, so this tail is read when the stream dies.
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
        const streamed = yield* Effect.exit(Stream.runForEach(events, onEvent));
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
        const responseTimeMs = (yield* monotonicMillis) - started;
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
        yield* reportUsage(
          usageLog,
          bound,
          turn.usage,
          responseTimeMs,
          attribution,
          roots,
        );
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
        const mode = bound.background ? 'background' : 'foreground';
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
        const started = yield* monotonicMillis;
        attemptStarts.set(invocation, started);
        return yield* consume(
          cell,
          invocation,
          bound,
          started,
          resolved.mode === 'foreground'
            ? bound.model.streamTurn(resolved)
            : submitAndObserve(run, cell, resolved, invocation, bound),
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
          return yield* consume(
            cell,
            invocation,
            bound,
            yield* monotonicMillis,
            observeBackground(
              run,
              cell,
              background,
              resolved,
              invocation,
              accepted,
            ),
          );
        },
      );

      /** Rebind for a retry on `credentials`, retiring the failed binding,
       *  on the routes the run declines as its rows now stand plus the one
       *  the retry `declines`; the new binding, or null when another stands.
       *  A failure keeps the old one, loudly. The turn's loop is the
       *  binding's one writer while it runs, the switch at its model
       *  boundary the other, so a binding that already replaced `failed` is
       *  one the loop bound itself, and stands. */
      const rebind = (
        cell: RunCell,
        { credentials, declines }: RetryCredentials,
        failed: BoundModel,
      ): Effect.Effect<BoundModel | null, CallFailure> =>
        Effect.flatMap(cell.current, (state) => {
          if (ScopedRef.getUnsafe(run.model) !== failed)
            return Effect.succeed(null);
          const declinedRoutes =
            declines === null || state.declinedRoutes.includes(declines)
              ? state.declinedRoutes
              : [...state.declinedRoutes, declines];
          return ScopedRef.set(
            run.model,
            access
              .bind({
                modelId: failed.modelId,
                // A personal-key retry drops the route's overlay (window,
                // prices, PDF admission, Kimi endpoint) for the catalog's.
                config: credentials === 'personal' ? undefined : failed.config,
                backend: failed.backend,
                declinedRoutes,
                textOnly: failed.textOnly,
                temperature: run.persona.temperature,
              })
              // The ref masks its acquisition; a stop must still cut a
              // bind in progress.
              .pipe(Effect.interruptible),
          ).pipe(Effect.andThen(ScopedRef.get(run.model)));
        }).pipe(
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
       * used-up `quota` offers and, where the policy answers at once, that
       * answer, so no surface lists it pending. A used-up plan the route
       * falls back from without asking asks nothing: its `failed` row
       * declines the route (`next: decline`).
       */
      const failedRows = Effect.fn('ModelInvoker.failedRows')(function* (
        cell: RunCell,
        ref: InvocationRef,
        error: ModelFailure,
        next: StepAfterFailure,
        bound: BoundModel,
        usage: NormalizedUsage | null,
      ): Effect.fn.Return<readonly RunHistoryDraft[], never, SessionServices> {
        const failedRow = (next: StepAfterFailure): RunHistoryDraft => ({
          type: 'model.message',
          aggregateId,
          payload: {
            kind: 'failed',
            invocation: ref,
            error,
            next,
            ...(usage === null ? {} : { usage }),
          },
        });
        if (next.kind !== 'ask') return [failedRow(next)];
        const { requestId } = next;
        const credentialSwitch = yield* access.credentialSwitch(
          bound,
          error.source === 'model' ? error.quota : undefined,
          (yield* cell.current).declinedRoutes,
        );
        if (
          credentialSwitch?.kind === 'decline-route' &&
          credentialSwitch.automatic
        ) {
          // Nobody is asked: the run declines the route and resends on the
          // user's own key. The notice records the route; an app words it.
          logger.info(quotaFallbackMessage(credentialSwitch), {
            messageType: MESSAGE_TYPES.QUOTA_FALLBACK,
            data: { route: credentialSwitch.route },
          });
          return [
            failedRow({ kind: 'decline', route: credentialSwitch.route }),
          ];
        }
        const payload = {
          kind: 'retry',
          data: {
            requestId,
            runId,
            operation: 'Model request',
            model: bound.modelId,
            failure: error,
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
          failedRow(next),
          ...(yield* policyDecidedRows(runId, payload)),
        ];
      });

      /** Record the failure of attempt `ref` and the move after it. */
      const recordFailure = Effect.fn('ModelInvoker.failed')(function* (
        cell: RunCell,
        ref: InvocationRef,
        { error }: AttemptFailure,
        next: StepAfterFailure,
        bound: BoundModel,
      ): Effect.fn.Return<void, InvokeError, SessionServices> {
        const failure = modelFailureOf(error, bound.config.provider);
        if (next.kind !== 'retry' && next.kind !== 'unchain')
          yield* logProviderError(
            logger,
            next.kind === 'stop'
              ? 'Model request failed (no retry available)'
              : 'Model request failed',
            failure,
            error.cause,
          );
        // A response the provider billed before refusing it is priced
        // and reported like a turn's, on its `failed` row.
        const started = attemptStarts.get(ref);
        const billed =
          error instanceof ModelError &&
          error.usage !== undefined &&
          started !== undefined
            ? {
                usage: error.usage,
                responseTimeMs: (yield* monotonicMillis) - started,
              }
            : null;
        const usage =
          billed === null
            ? null
            : priceTurnUsage(bound, billed.usage, billed.responseTimeMs);
        if (billed !== null)
          yield* reportUsage(
            usageLog,
            bound,
            billed.usage,
            billed.responseTimeMs,
            attribution,
            roots,
          );
        yield* cell.append(
          yield* failedRows(cell, ref, failure, next, bound, usage),
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
      ): Effect.Effect<StepAfterFailure> =>
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
            ? gate.withRoutes(bound.routes)(
                attemptOnce(cell, ref, request, bound),
              )
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
                ? Effect.succeed({
                    error: routeFailureOf(error),
                    unsent: false,
                  })
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
        const bound = yield* ScopedRef.get(run.model);
        yield* cell.append(
          yield* failedRows(
            cell,
            attempt.ref,
            { source: 'interrupted', provider: bound.config.provider },
            { kind: 'ask', requestId: `retry-${randomUUID()}` },
            bound,
            null,
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
        const retries = (yield* ScopedRef.get(run.model)).automaticRetries;
        for (;;) {
          const { invocation, requests } = yield* cell.current;
          const move = nextAttempt(invocation, requests, retries);
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
            const bound = yield* ScopedRef.get(run.model);
            const rebound = yield* Effect.result(
              rebind(cell, move.retry, bound),
            );
            if (Result.isFailure(rebound)) {
              const failure = { error: rebound.failure, unsent: true };
              const next = yield* moveAfter(cell, failure, ref, false, retries);
              yield* recordFailure(cell, ref, failure, next, bound);
              continue;
            }
            // The binding the retry is sent on, with the routes it declines,
            // recorded before the send.
            const { success: renewed } = rebound;
            if (renewed !== null)
              yield* cell.append([
                configRow(runId, run.config, renewed.modelId, {
                  backend: renewed.backend,
                  declinedRoutes: renewed.declinedRoutes,
                }),
              ]);
          }
          const bound = yield* ScopedRef.get(run.model);
          const tried = yield* tryAttempt(cell, request, move, ref, bound);
          if ('ok' in tried) return tried.ok;
          const failure = tried;
          const next = yield* moveAfter(
            cell,
            failure,
            ref,
            move.kind === 'observe',
            retries,
          );
          yield* recordFailure(cell, ref, failure, next, bound);
          if (next.kind === 'stop') return yield* endedAs(cell, 'failed');
          if (next.kind !== 'retry' && next.kind !== 'unchain') continue;
          // The pause before an automatic resend, unchained or not.
          const delayMs = resendDelayMs(failure.error);
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
              binding: ScopedRef.get(run.model),
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
