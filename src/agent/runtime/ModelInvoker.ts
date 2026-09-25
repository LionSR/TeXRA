/**
 * The one service that touches the llm `Model`. One `invoke` is one model
 * invocation with its billed attempts: the `TurnRequest` assembled from the
 * folded `RunState`, `prepareTurn`, the `attempt` row committed before the
 * request leaves the process (F1), `identified` when the provider names the
 * response, the stream bridged into the trace, and the `response` row with
 * its dispatch facts and priced usage committed before any tool runs.
 *
 * Two owners of retry, as before. Owner A is automatic and route-scoped: a
 * bounded batch of attempts under the session's `ModelRetryGate`, so sibling
 * runs on one credential share cooling. Owner B is a human and indefinite,
 * and it is durable here: the prompt is admitted by a `request.opened`
 * row whose `model.retry` permit walks
 * `waiting` -> `authorized` -> `started`. A decision survives a restart, an
 * unused permit survives one, and a consumed permit never buys a second
 * billed attempt implicitly.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Context,
  Data,
  Effect,
  Exit,
  type FileSystem,
  Layer,
  Result,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';
import {
  ModelError,
  type BackgroundEvent,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm/turn';

import { maybeSaveDebugObject } from '@agent/debug/debugMessageSaver';
import {
  logContextManagementEvent,
  logErrorData,
  logProgressStatus,
  type StreamHandle,
} from '@agent/trace';
import { hasMissingApiKeyErrorMarker } from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import type { StateReadFailed } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  AgentCategory,
  MESSAGE_TYPES,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  toRetryErrorInfo,
  type DeclinableUsageRoute,
  type InvocationRef,
  type NormalizedUsage,
  type ProviderError,
  type RequestDecision,
  type RetryErrorInfo,
} from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { generateShortId } from '@utils/core';
import { readSettingFrom } from '@utils/config/platformSettings';

import { AgentRun } from './run/AgentRun';
import { estimateInputTokensOrNull } from './run/estimateInputTokens';
import {
  backgroundDelivery,
  bindModel,
  releaseBindingUploads,
  type BoundModel,
} from './run/modelBinding';
import { classifyModelFailure, type ModelFailure } from './run/modelFailure';
import { priceTurnUsage } from './run/pricing';
import { turnText } from './run/turnText';
import { dispatchFactsFor } from './run/tools';
import {
  redactedForFact,
  retryRow,
  retryRows,
  rowAggregate,
  snapshotRow,
  stepRow,
} from './loop/rows';
import type { RunCell } from './loop/runProgram';
import type { HttpClient } from 'effect/unstable/http';
import type { RoutePolicy } from './ModelRetryGate';

/**
 * Credential source a retry decision picked: the account the run is already
 * configured with, or the user's personal credential. Derived from the one
 * request vocabulary so the retry arm stays the only definition.
 */
type RetryCredentials = NonNullable<
  Extract<RequestDecision, { action: 'retry' }>['credentials']
>;

/** Base delay between automatic attempts; the gate scales its own on top. */
const RETRY_BACKOFF_MS = 1000;

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

/**
 * How long accepted background work is observed after its submission, as
 * the retired poller allowed. The deadline is absolute and recorded with the
 * `accepted` row: a resume observes under the original one, never a fresh one.
 */
const BACKGROUND_MAX_DURATION_MS = 3 * 60 * 60 * 1000;

const EMPTY_RESPONSE_ERROR_MESSAGE =
  'Model response was empty or aborted; this may indicate a server issue or network problem.';

/**
 * How much of a failed attempt's streamed output the failure carries. The
 * retry surface shows the tail so the user sees the work was not lost; the
 * bound keeps a long generation out of the error and off the ledger row.
 */
const PARTIAL_TEXT_TAIL_MAX = 4096;

export interface InvokeRequest {
  readonly system: string | undefined;
  /** The tools this turn advertises; a reflection turn advertises none. */
  readonly tools: TurnRequest['tools'];
  readonly toolChoice: TurnRequest['toolChoice'];
  readonly stopSequences?: TurnRequest['stopSequences'];
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
 * The ledger failures `invoke` can hand back. One definition: the dispatch
 * path in `loop/toolUseDispatch` branches on the same union, so it imports
 * this rather than re-declaring the alias.
 */
export type InvokeError =
  RunLedgerRefused | DatabaseWriteFailed | StateReadFailed;

export class ModelInvoker extends Context.Service<
  ModelInvoker,
  {
    readonly invoke: (
      cell: RunCell,
      request: InvokeRequest,
    ) => Effect.Effect<
      InvocationOutcome,
      InvokeError,
      FileSystem.FileSystem | LanguageModel | HttpClient.HttpClient
    >;
  }
>()('@texra/agent/ModelInvoker') {}

function turnReasoning(turn: TurnResult): string {
  if (turn.kind !== 'http') return '';
  return turn.content
    .flatMap((part) =>
      part.kind === 'reasoning'
        ? (part.content ?? part.summary).map((piece) => piece.text)
        : [],
    )
    .join('\n');
}

/** A failed attempt's classification; the rows it left are in the cell. */
class AttemptFailed extends Data.TaggedError('AttemptFailed')<{
  readonly failure: ModelFailure;
}> {
  override get message(): string {
    return this.failure.formatted.message;
  }
}

type RetryLifecycleEvent =
  | 'attempt_started'
  | 'attempt_succeeded'
  | 'attempt_failed'
  | 'retry_decision_requested'
  | 'retry_decided';

/**
 * Build a request service for one run; its model is run-owned, and every row
 * it writes goes through the run cell the loop hands each invocation.
 */
export const modelInvokerLayer = (): Layer.Layer<
  ModelInvoker,
  never,
  AgentRun
> =>
  Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const { runId, session, logger } = run;
      const aggregateId = rowAggregate(runId);

      const logRetryLifecycle = (
        operationId: string,
        event: RetryLifecycleEvent,
        bound: BoundModel,
        details: Record<string, unknown> = {},
      ): void => {
        logger.domain({
          key: 'modelRetryLifecycle',
          data: {
            kind: 'model_retry_lifecycle',
            event,
            operationId,
            operation: 'Model request',
            runId,
            agentName: run.config.agent,
            model: bound.modelId,
            credentialRoute: bound.usageRoute,
            ...details,
          },
        });
      };

      const saveDebug = (
        object: unknown,
        objectType: 'messages' | 'response',
        round: number,
        baseName: string,
      ) =>
        maybeSaveDebugObject({
          object,
          objectType,
          context: {
            logger,
            runId,
            modelName: run.config.model,
            isRemote: run.config.agentSource === 'remote',
            roots: session.roots,
          },
          fileOptions: { continuationCount: round, baseName },
        });

      /** Recheck the binding's background policy against live session settings. */
      const backgroundRequested = (bound: BoundModel) =>
        backgroundDelivery(
          {
            backgroundCapable: bound.backgroundCapable,
            protocol: bound.origin.protocol,
            modelName: bound.config.name,
            agentCategory: run.config.agentCategory,
          },
          session.roots,
        );

      /**
       * The semantic request an attempt admits: this run's history as the
       * ledger folded it, plus the caller's system, tools and stop sequences
       * and the continuation the last response left, when the binding still
       * matches its origin. A resume rebuilds the admitted turn from the same
       * inputs, so no row has to carry a second copy of the history.
       */
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
        ...(request.stopSequences !== undefined
          ? { stopSequences: request.stopSequences }
          : {}),
        ...(state.continuation !== null &&
        state.continuation.origin.protocol === bound.origin.protocol &&
        state.continuation.origin.requestedModel === bound.origin.requestedModel
          ? { continuation: state.continuation }
          : {}),
      });

      const failAttempt = (
        cause: unknown,
        bound: BoundModel,
        partialText?: string,
      ) =>
        Effect.fail(
          new AttemptFailed({
            failure: classifyModelFailure(cause, bound.usageRoute, partialText),
          }),
        );

      /**
       * Prepare one attempt's turn. A preparation that fails is this
       * attempt's own failure; an interruption stays an interruption.
       */
      const prepareAttempt = Effect.fn('ModelInvoker.prepare')(function* (
        bound: BoundModel,
        request: TurnRequest,
      ): Effect.fn.Return<ResolvedTurn, AttemptFailed> {
        const prepared = yield* Effect.exit(bound.model.prepareTurn(request));
        if (Exit.isFailure(prepared)) {
          if (Cause.hasInterrupts(prepared.cause))
            return yield* Effect.interrupt;
          return yield* failAttempt(Cause.squash(prepared.cause), bound);
        }
        return prepared.value;
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
       * The bridge from the model's events into the trace and the ledger: the
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
                  current.openAttempt?.providerResponseId ===
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
                      returnedModel: event.returnedModel,
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
              case 'phase':
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
        operationId: string,
        trace: AttemptTrace,
        started: number,
        streamed: Exit.Exit<void, unknown>,
        completed: AttemptOutcome,
      ): Effect.fn.Return<
        InvocationResponse,
        AttemptFailed | InvokeError,
        FileSystem.FileSystem
      > {
        if (Exit.isFailure(streamed)) {
          trace.thinking.finalize(undefined);
          trace.output.finalize();
          if (Cause.hasInterrupts(streamed.cause))
            return yield* Effect.interrupt;
          const cause = Cause.squash(streamed.cause);
          if (
            cause instanceof RunLedgerRefused ||
            cause instanceof DatabaseWriteFailed
          ) {
            return yield* Effect.fail(cause);
          }
          logRetryLifecycle(operationId, 'attempt_failed', bound, {
            attempt: invocation.attempt,
          });
          return yield* failAttempt(cause, bound, completed.streamedText);
        }
        const responseTimeMs = Date.now() - started;
        const turn = completed.value;
        if (turn === null) {
          trace.thinking.finalize(undefined);
          trace.output.finalize();
          return yield* failAttempt(
            new ModelError({
              kind: 'malformed-output',
              message: EMPTY_RESPONSE_ERROR_MESSAGE,
            }),
            bound,
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
        );
        const usage = priceTurnUsage(bound, turn.usage, responseTimeMs, logger);
        if (
          usage !== null &&
          usage.inputTokens > 0 &&
          bound.contextWindow > 0
        ) {
          logger.contextState({
            inputTokens: usage.inputTokens,
            contextWindow: bound.contextWindow,
          });
        }
        const responseId = randomUUID();
        const calls = dispatchFactsFor(
          turn,
          run.tools,
          logger,
          generateShortId,
        );
        // The completed turn, committed once before any local tool runs. A
        // response retires the failure a retry was recovering from in the
        // same transaction, so no resume reads a delivered turn as failed.
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
          ...(state.lastError === null
            ? []
            : [snapshotRow(runId, state, { runtime: { lastError: null } })]),
          stepRow(runId, state, 'response.ready'),
        ]);
        logRetryLifecycle(operationId, 'attempt_succeeded', bound, {
          attempt: invocation.attempt,
        });
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
       * Background work: submit, and if the provider accepted it rather than
       * completing at once, commit the `accepted` row with its deadline before
       * `observe` is called (the commit barrier, row 4). A progress callback is
       * no substitute: nothing observes an operation the ledger does not hold.
       */
      const submitAndObserve = Effect.fn('ModelInvoker.background')(function* (
        resolved: Extract<ResolvedTurn, { mode: 'background' }>,
        invocation: InvocationRef,
        bound: BoundModel,
        cell: RunCell,
        onEvent: (event: BackgroundEvent) => Effect.Effect<void, InvokeError>,
        completed: AttemptOutcome,
      ): Effect.fn.Return<void, ModelError | InvokeError> {
        const background = bound.model.background;
        if (background === undefined) {
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'The bound model resolved a background turn it cannot submit.',
          });
        }
        const submission = yield* background.submit(resolved);
        if (submission.kind === 'completed') {
          completed.value = submission.result;
          return;
        }
        const deadlineAtMs = Date.now() + BACKGROUND_MAX_DURATION_MS;
        yield* cell.append([
          {
            type: 'model.message',
            aggregateId,
            payload: {
              kind: 'identified',
              invocation,
              providerResponseId: submission.operation.providerResponseId,
              returnedModel: submission.returnedModel,
            },
          },
          {
            type: 'model.message',
            aggregateId,
            payload: {
              kind: 'accepted',
              invocation,
              operation: submission.operation,
              deadlineAtMs,
            },
          },
        ]);
        yield* Stream.runForEach(
          background.observe(resolved, submission.operation, { deadlineAtMs }),
          onEvent,
        );
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
        operationId: string,
      ): Effect.fn.Return<
        InvocationResponse,
        AttemptFailed | InvokeError,
        FileSystem.FileSystem
      > {
        const state = yield* cell.current;
        const turnRequest = turnRequestFor(
          state,
          request,
          bound,
          (yield* backgroundRequested(bound)) ? 'background' : 'foreground',
        );
        let resolved = yield* prepareAttempt(bound, turnRequest);
        yield* saveDebug(
          state.messages,
          'messages',
          request.round,
          request.debugName,
        );
        // R4: the input estimate where the provider offers one. A count that
        // fails is logged and the provider enforces its own limit; an input
        // that alone exceeds the window is refused before it is billed, and an
        // input that leaves too little room for the requested output shrinks
        // that output rather than letting the provider reject the request.
        if (resolved.mode === 'foreground' && bound.contextWindow > 0) {
          const inputTokens = yield* estimateInputTokensOrNull(
            bound.model,
            resolved,
            logger,
            'Token counting failed. Proceeding without token adjustment.',
          );
          if (inputTokens !== null) {
            if (inputTokens > bound.contextWindow) {
              return yield* failAttempt(
                new ModelError({
                  kind: 'invalid-request',
                  message: `Input is ${inputTokens} tokens, which exceeds the model's context window of ${bound.contextWindow} tokens.`,
                }),
                bound,
              );
            }
            const { controls } = resolved;
            const requested =
              'maxOutputTokens' in controls ? controls.maxOutputTokens : null;
            if (
              requested !== null &&
              inputTokens + requested > bound.contextWindow
            ) {
              const reduced = reducedOutputBudget(
                bound.contextWindow - inputTokens,
                run.config.agentCategory === AgentCategory.ToolUse
                  ? TOOL_USE_SAFETY_BUFFER
                  : TOKEN_SAFETY_BUFFER,
              );
              logContextManagementEvent(
                logger,
                `Token count (${inputTokens}) + max output tokens (${requested}) exceeds context window (${bound.contextWindow}). Reducing to ${reduced}.`,
                {
                  action: 'max_tokens_reduced',
                  tokensBefore: inputTokens,
                  contextWindow: bound.contextWindow,
                  utilizationBefore: roundedUtilizationPercent(
                    inputTokens,
                    bound.contextWindow,
                  ),
                  originalMaxTokens: requested,
                  reducedMaxTokens: reduced,
                  details: request.debugName,
                },
              );
              // The clamp is part of the request, so the request is prepared
              // again with it: execution never reapplies defaults over a
              // resolved turn.
              resolved = yield* prepareAttempt(bound, {
                ...turnRequest,
                maxOutputTokens: reduced,
              });
            }
          }
        }
        logRetryLifecycle(operationId, 'attempt_started', bound, {
          attempt: invocation.attempt,
          delivery: resolved.mode,
        });
        // The durable fact before the billed request (F1).
        yield* cell.append([
          {
            type: 'model.message',
            aggregateId,
            payload: {
              kind: 'attempt',
              invocation,
              origin: bound.origin,
              delivery:
                resolved.mode === 'background' ? 'background' : 'stream',
            },
          },
        ]);
        const trace = openTrace();
        const started = Date.now();
        const completed: AttemptOutcome = { value: null, streamedText: '' };
        const onEvent = eventSink(invocation, cell, trace, completed);
        const streamed = yield* Effect.exit(
          resolved.mode === 'foreground'
            ? Stream.runForEach(bound.model.streamTurn(resolved), onEvent)
            : submitAndObserve(
                resolved,
                invocation,
                bound,
                cell,
                onEvent,
                completed,
              ),
        );
        return yield* finishAttempt(
          cell,
          invocation,
          request,
          bound,
          operationId,
          trace,
          started,
          streamed,
          completed,
        );
      });

      /**
       * A resumed attempt whose background operation the ledger holds: observe
       * it under the deadline recorded with its `accepted` row, never resubmit,
       * even if the background settings changed since. Unbilled, so it runs
       * outside the route gate. The admitted turn is rebuilt from the rows
       * below the attempt, which are its history, so the observed completion
       * can anchor the next round exactly as a live submission does.
       */
      const observeAccepted = Effect.fn('ModelInvoker.observeAccepted')(
        function* (
          cell: RunCell,
          invocation: InvocationRef,
          request: InvokeRequest,
          bound: BoundModel,
          operationId: string,
          accepted: NonNullable<
            NonNullable<RunState['openAttempt']>['accepted']
          >,
        ): Effect.fn.Return<
          InvocationResponse,
          AttemptFailed | InvokeError,
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
              bound,
            );
          }
          // The admitted storage mode governs the observation turn, not the
          // current setting: re-preparing a temporary background turn as stored
          // would let the completion mint an anchor for a response the provider
          // never kept. The prior continuation stays out: observing needs no
          // anchor, and its fingerprint check would reject the turn before
          // observe can compare the admitted fingerprint and deliver the result.
          const { continuation: _prior, ...admitted } = turnRequestFor(
            yield* cell.current,
            request,
            bound,
            'background',
          );
          const resolved = yield* prepareAttempt(bound, {
            ...admitted,
            store: accepted.operation.store,
          });
          if (resolved.mode !== 'background') {
            return yield* failAttempt(
              new ModelError({
                kind: 'unsupported',
                message:
                  'The resumed background operation re-prepared as a foreground turn.',
              }),
              bound,
            );
          }
          logRetryLifecycle(operationId, 'attempt_started', bound, {
            attempt: invocation.attempt,
            delivery: 'background',
            resumed: true,
          });
          const trace = openTrace();
          const started = Date.now();
          const completed: AttemptOutcome = { value: null, streamedText: '' };
          const streamed = yield* Effect.exit(
            Stream.runForEach(
              background.observe(resolved, accepted.operation, {
                deadlineAtMs: accepted.deadlineAtMs,
              }),
              eventSink(invocation, cell, trace, completed),
            ),
          );
          return yield* finishAttempt(
            cell,
            invocation,
            request,
            bound,
            operationId,
            trace,
            started,
            streamed,
            completed,
          );
        },
      );

      /**
       * One attempt under the session's route gate: the gate is session state
       * by design (sibling runs share cooling), and the attempt runs inside its
       * permits on this fiber. Cancelling the run interrupts the fiber, which
       * the gate reads as the waiting or in-flight attempt being abandoned.
       */
      const gatedAttempt = (
        cell: RunCell,
        invocation: InvocationRef,
        request: InvokeRequest,
        bound: BoundModel,
        operationId: string,
      ): Effect.Effect<
        InvocationResponse,
        AttemptFailed | InvokeError,
        FileSystem.FileSystem
      > => {
        const verdictFor = (error: Error) =>
          error instanceof AttemptFailed
            ? error.failure.verdict
            : classifyModelFailure(error).verdict;
        const routes: [RoutePolicy, RoutePolicy] = [
          {
            key: bound.modelRetryRouteKey,
            classifyFailure: (error: Error) => {
              const verdict = verdictFor(error);
              return verdict.rateLimitScope === 'model'
                ? { retryAfterMs: verdict.retryAfterMs }
                : undefined;
            },
          },
          {
            key: bound.wireRouteKey,
            classifyFailure: (error: Error) => {
              const verdict = verdictFor(error);
              return verdict.wireRouteFailure
                ? { retryAfterMs: verdict.retryAfterMs }
                : undefined;
            },
            isReachableFailure: (error: Error) =>
              verdictFor(error).rateLimitScope === 'model',
          },
        ];
        return session.modelRetries.withRoutes(routes, {
          baseBackoffMs: RETRY_BACKOFF_MS,
          onWait: (delayMs) =>
            logger.debug(`Waiting ${delayMs}ms for the model recovery probe.`),
        })(attemptOnce(cell, invocation, request, bound, operationId));
      };

      /**
       * The routes the run declines after this decision. Answering a retry
       * with the user's own API key turns this run away from the subscription
       * route the failed attempt billed — for this run only, on its own
       * ledger, so a concurrent run's fallback is untouched and the user's
       * stored preference stays theirs to change in settings.
       */
      const declinedAfter = (
        state: RunState,
        selection: RetryCredentials,
        failed: BoundModel,
      ): readonly DeclinableUsageRoute[] => {
        if (selection !== 'personal' || failed.usageRoute === 'api-key') {
          return state.declinedRoutes;
        }
        return state.declinedRoutes.includes(failed.usageRoute)
          ? state.declinedRoutes
          : [...state.declinedRoutes, failed.usageRoute];
      };

      /** Rebuild the model binding a retry runs on. */
      const rebind = (
        selection: RetryCredentials,
        failed: BoundModel,
        declinedRoutes: readonly DeclinableUsageRoute[],
      ) =>
        SynchronizedRef.updateEffect(run.model, (current) =>
          Effect.gen(function* () {
            // A switch may have landed while the panel waited; never undo it.
            if (current !== failed) return current;
            // A personal-key retry leaves the failed route's overlay behind
            // (subscription window, prices, PDF admission, a Kimi coding
            // endpoint) and binds the catalog model.
            const config =
              selection === 'personal'
                ? ((yield* resolveRuntimeModelConfig(failed.modelId)) ??
                  failed.config)
                : failed.config;
            const next = yield* bindModel({
              config,
              stores: run.stores,
              compatibilityKey: failed.compatibilityKey,
              declinedRoutes,
              agentCategory: run.config.agentCategory,
              temperature: run.setting.temperature,
            }).pipe(Scope.provide(run.scope));
            yield* releaseBindingUploads(current.model, current.modelId);
            logger.debug('Refreshed model binding before manual retry');
            return next;
          }),
        );

      type Decision = 'retry' | 'deny' | 'cancel';

      /**
       * The durable manual-retry admission. `requestId` is the outstanding
       * request when the run resumed with a `waiting` gate, else a new one is
       * committed with its binding before the prompt is shown.
       */
      const manualRetry = Effect.fn('ModelInvoker.manualRetry')(function* (
        cell: RunCell,
        failed: BoundModel,
        // The failure as it is recorded, live or recovered from the ledger:
        // the prompt, the row and the reported error all read this one value,
        // so a restart re-presents the same facts the first prompt showed.
        recorded: ProviderError,
        failedAttempt: InvocationRef,
        operationId: string,
        outstanding: string | null,
      ): Effect.fn.Return<
        Decision,
        InvokeError,
        LanguageModel | HttpClient.HttpClient
      > {
        const requestId = outstanding ?? `retry-${generateShortId()}`;
        const info = toRetryErrorInfo(recorded);
        const request = {
          requestId,
          runId,
          operation: 'Model request',
          model: failed.modelId,
          errorMessage: info.message,
          errorDetails: info,
        };
        const pendingRetry = (substate: 'waiting' | 'authorized' | 'started') =>
          ({
            requestId,
            invocation: failedAttempt,
            failedModelId: failed.modelId,
            failedCompatibilityKey: failed.compatibilityKey,
            credentialScope:
              failed.origin.protocol === 'vscode-lm'
                ? 'editor'
                : failed.origin.deployment.credentialScope,
            substate,
          }) as const;
        if (outstanding === null) {
          logErrorData(logger, 'Model request failed', recorded);
          logRetryLifecycle(operationId, 'retry_decision_requested', failed, {
            userRetryable: info.userRetryable,
            statusCode: info.statusCode,
            provider: info.provider,
          });
          yield* cell.append((state) => [
            {
              type: 'request.opened',
              aggregateId,
              requestId,
              // The row is committed here rather than at the session's door
              // (`openRequest`), so the scrub that door applies happens here:
              // a provider message echoing an `Authorization` header never
              // reaches a durable row.
              payload: redactedForFact({ kind: 'retry', data: request }),
              thread: null,
            },
            ...retryRows(runId, state, pendingRetry('waiting'), {
              lastError: info,
            }),
          ]);
        }
        const state = yield* cell.current;
        logger.debug('Waiting for manual retry', { data: info.message });
        // The decision is the `request.decided` row (R5): one a surface already
        // landed for an outstanding request (a crash after the decision keeps
        // its unused consent), else the one the decide command lands on the
        // tail while this fiber waits. A plane that closes first is a
        // cancellation.
        let decision = state.requests[requestId]?.decision ?? null;
        if (decision === null) {
          const row = yield* session
            .decisionFor(runId, requestId, state.commit)
            .pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  logger.warn('The retry prompt closed before a decision', {
                    data: error,
                  });
                  return null;
                }),
              ),
            );
          if (row === null) {
            decision = { action: 'cancel', cause: 'The session closed.' };
          } else {
            yield* cell.fold(row, 'The retry decision');
            decision = row.decision;
          }
        }
        logRetryLifecycle(operationId, 'retry_decided', failed, {
          action: decision.action,
        });
        if (decision.action === 'retry') {
          logger.debug('Manual retry triggered');
          const selection = decision.credentials ?? 'configured';
          const declinedRoutes = declinedAfter(
            yield* cell.current,
            selection,
            failed,
          );
          // Always rebuild the binding on a manual retry: the user may have set
          // a new key or toggled a route preference while the panel waited, and
          // a personal-credentials answer declines the exhausted route for the
          // rest of this run. A rebind that fails leaves the run on the binding
          // it has, loudly.
          yield* rebind(selection, failed, declinedRoutes).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                logger.warn(
                  'Failed to refresh the model binding before retry',
                  {
                    data: error,
                  },
                ),
              ),
            ),
          );
          yield* cell.append((state) =>
            retryRows(runId, state, pendingRetry('authorized'), {
              lastError: info,
              declinedRoutes,
            }),
          );
          return 'retry';
        }
        logProgressStatus(
          logger,
          decision.action === 'deny'
            ? decision.reason
            : 'Retry cancelled by user',
        );
        // Either answer clears the gate, keeping the failure it recorded.
        yield* cell.append((state) =>
          retryRows(runId, state, null, { lastError: info }),
        );
        return decision.action === 'deny' ? 'deny' : 'cancel';
      });

      const invoke = Effect.fn('ModelInvoker.invoke')(function* (
        cell: RunCell,
        request: InvokeRequest,
      ): Effect.fn.Return<
        InvocationOutcome,
        InvokeError,
        FileSystem.FileSystem | LanguageModel | HttpClient.HttpClient
      > {
        const state = yield* cell.current;
        const operationId = `model-operation-${generateShortId()}`;
        // One initial attempt plus the configured number of automatic
        // retries; the schema bounds the setting to [0, 5] and falls back to
        // the default on anything else, so the limit is always >= 1.
        const limit =
          1 +
          (yield* readSettingFrom<number>(
            session.roots,
            MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
          ));
        let automaticAttempts = 0;
        // An open attempt with no response is an invocation whose outcome the
        // process never saw: the next attempt continues its numbering, and its
        // gate state below says whether a human must admit it first.
        const open = state.openAttempt;
        const invocationId = open?.invocation.invocationId ?? randomUUID();
        let attempt = open === null ? 1 : open.invocation.attempt + 1;
        // An open attempt the provider accepted as background work is observed
        // first, under its recorded deadline; only a failure of that
        // observation (or a gate a human already holds) leads to a new attempt.
        let observing =
          open !== null && open.accepted !== null && state.pendingRetry === null
            ? { invocation: open.invocation, accepted: open.accepted }
            : null;
        // The manual gate as resumed. `waiting`: re-present the same request.
        // `authorized`: one unused permit. `started`: spent by an attempt that
        // never reported, so a new decision is required.
        let admission: 'automatic' | 'authorized' | 'decision' | 'waiting' =
          'automatic';
        let outstanding: string | null = null;
        // The failure the manual gate presents: the live attempt's own record,
        // or, on a resume, the one the snapshot committed with the gate.
        let lastFailure: ProviderError | null = null;
        let failedAttempt: InvocationRef = {
          invocationId,
          attempt: Math.max(1, attempt - 1),
        };
        if (state.pendingRetry !== null) {
          const gate = state.pendingRetry;
          failedAttempt = gate.invocation;
          if (gate.substate === 'waiting') {
            admission = 'waiting';
            outstanding = gate.requestId;
          } else if (gate.substate === 'authorized') {
            admission = 'authorized';
          } else {
            admission = 'decision';
          }
          // Every gate write commits `lastError` in the same batch, so a gate
          // without its failure is a malformed aggregate: refuse loudly rather
          // than re-present a fabricated one.
          if (state.lastError === null) {
            return yield* Effect.die(
              new Error('A manual retry gate has no recorded failure.'),
            );
          }
          lastFailure = state.lastError;
        }
        for (;;) {
          const bound = yield* SynchronizedRef.get(run.model);
          if (admission !== 'automatic') {
            if (admission === 'waiting' || admission === 'decision') {
              const failure = lastFailure;
              if (failure === null) {
                return yield* Effect.die(
                  new Error('A manual retry gate has no failure to present.'),
                );
              }
              const decision = yield* manualRetry(
                cell,
                bound,
                failure,
                failedAttempt,
                operationId,
                outstanding,
              );
              outstanding = null;
              if (decision === 'deny') {
                return {
                  kind: 'failed',
                  state: yield* cell.current,
                  error: toRetryErrorInfo(failure),
                };
              }
              if (decision === 'cancel')
                return { kind: 'cancelled', state: yield* cell.current };
            }
            // Consume the permit: `started` commits with the attempt row, so
            // a crash after this transaction cannot reuse the authorization.
            const gate = (yield* cell.current).pendingRetry;
            if (gate === null) {
              return yield* Effect.die(
                new Error('An authorized retry has no gate.'),
              );
            }
            yield* cell.append([
              retryRow(runId, { ...gate, substate: 'started' }),
            ]);
            admission = 'automatic';
          }
          let invocation: InvocationRef;
          let exit: Exit.Exit<InvocationResponse, AttemptFailed | InvokeError>;
          if (observing !== null) {
            invocation = observing.invocation;
            exit = yield* Effect.exit(
              observeAccepted(
                cell,
                invocation,
                request,
                yield* SynchronizedRef.get(run.model),
                operationId,
                observing.accepted,
              ),
            );
            observing = null;
          } else {
            invocation = { invocationId, attempt };
            attempt += 1;
            exit = yield* Effect.exit(
              gatedAttempt(
                cell,
                invocation,
                request,
                yield* SynchronizedRef.get(run.model),
                operationId,
              ),
            );
          }
          if (Exit.isSuccess(exit)) return exit.value;
          if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt;
          const found = Cause.findError(exit.cause);
          const error = Result.isSuccess(found) ? found.success : undefined;
          if (error?._tag !== 'AttemptFailed') {
            const ledger =
              error?._tag === 'RunLedgerRefused' ||
              error?._tag === 'DatabaseWriteFailed';
            return yield* ledger
              ? Effect.fail(error)
              : Effect.die(error ?? Cause.squash(exit.cause));
          }
          lastFailure = error.failure.formatted;
          failedAttempt = invocation;
          automaticAttempts += 1;
          const { failure } = error;
          if (isUserAbort(failure.error))
            return { kind: 'cancelled', state: yield* cell.current };
          if (failure.autoRetryable && automaticAttempts < limit) {
            logger.debug(
              `Model request failed; automatic retry ${automaticAttempts} of ${limit - 1} in ${RETRY_BACKOFF_MS}ms.`,
              { data: failure.info.message },
            );
            yield* Effect.sleep(RETRY_BACKOFF_MS);
            continue;
          }
          if (
            !failure.formatted.userRetryable ||
            hasMissingApiKeyErrorMarker(failure.error)
          ) {
            logErrorData(
              logger,
              'Model request failed (no retry available)',
              failure.formatted,
            );
            // The invoker is the one writer of the run's failure fact.
            const failed = yield* cell.append((state) => [
              snapshotRow(runId, state, {
                runtime: { lastError: failure.info },
              }),
            ]);
            return { kind: 'failed', state: failed, error: failure.info };
          }
          admission = 'decision';
        }
      });

      return { invoke };
    }),
  );
