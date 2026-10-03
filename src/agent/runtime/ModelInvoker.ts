/**
 * The one service that touches the llm `Model`; every call carries a purpose
 * (`run/modelCall.ts`). One `invoke` is one turn with its billed attempts: the
 * `TurnRequest` assembled from the folded `RunState`, `prepareTurn`, the
 * `attempt` row committed before the request leaves the process (F1),
 * `identified` when the provider names the response, the stream bridged into
 * the trace, and the `response` row with its dispatch facts and priced usage
 * committed before any tool runs. `call` is a compaction summary on the same
 * binding, gate and pricing, recorded by its caller.
 *
 * Two owners of retry. Owner A is automatic and route-scoped: a bounded batch
 * of attempts under the session's `ModelRetryGate`, so sibling runs on one
 * credential share cooling. Owner B is a human, indefinite and durable: a
 * `request.opened` row whose `model.retry` permit walks `waiting` ->
 * `authorized` -> `started`. A decision and an unused permit survive a
 * restart; a consumed permit never buys a second billed attempt implicitly.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Clock,
  Context,
  Data,
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
  type ResolvedTurn,
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
import { hasMissingApiKeyErrorMarker } from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import { routeCredentialSwitch } from '@model/modelRoute';
import type { StateReadFailed } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import { quotaFallbackRouteFor } from '@shared/quotaFallbackRoutes';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  AgentCategory,
  MESSAGE_TYPES,
  toRetryErrorInfo,
  type DeclinableUsageRoute,
  type InvocationRef,
  type NormalizedUsage,
  type ProviderError,
  type RequestDecision,
  type RetryErrorInfo,
} from '@shared/schemas';
import type { DatabaseWriteFailed } from '@shared/session/database';
import {
  findStorageRefusal,
  type RunHistoryRefused,
} from '@shared/session/runHistory';
import type { RunState } from '@shared/session/runStateFold';
import { UsageLog, usageAgentName } from '@shared/usageLog';
import { generateShortId } from '@utils/core';

import { policyDecidedRows } from './requestPolicy';
import { rejectedTokenRecovery } from './rejectedTokenRecovery';
import { AgentRun } from './run/AgentRun';
import {
  backgroundDelivery,
  bindModel,
  type BoundModel,
} from './run/modelBinding';
import { classifyModelFailure, type ModelFailure } from './run/modelFailure';
import {
  beforeNextAttempt,
  callModel,
  reportUsage,
  RETRY_BACKOFF_MS,
  routePolicies,
  type CallResult,
} from './run/modelCall';
import { observeBackground, submitAndObserve } from './run/backgroundTurn';
import { contextTokens } from './run/contextTokens';
import { priceTurnUsage } from './run/pricing';
import { turnReasoning, turnText } from './run/turnText';
import {
  attemptRows,
  chainedContinuation,
  checkRecordedRequest,
  recordedRequest,
} from './run/requestContext';
import { dispatchFactsFor } from './run/tools';
import {
  retryRow,
  retryRows,
  rowAggregate,
  snapshotRow,
  positionRow,
} from './loop/rows';
import type { RunCell } from './loop/runProgram';
import type { HttpClient } from 'effect/http';

/**
 * Credential source a retry decision picked: the account the run is already
 * configured with, or the user's personal credential. Derived from the one
 * request vocabulary so the retry arm stays the only definition.
 */
type RetryCredentials = NonNullable<
  Extract<RequestDecision, { action: 'retry' }>['credentials']
>;

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

/**
 * How much of a failed attempt's streamed output the failure carries. The
 * retry surface shows the tail so the user sees the work was not lost; the
 * bound keeps a long generation out of the error and off the run history row.
 */
const PARTIAL_TEXT_TAIL_MAX = 4096;

export interface InvokeRequest {
  readonly system: string | undefined;
  /** The tools this turn advertises; a workflow round advertises none. */
  readonly tools: TurnRequest['tools'];
  readonly toolChoice: TurnRequest['toolChoice'];
  /** The turn's round ordinal, for debug file naming. */
  readonly round: number;
  /** The debug file base name of the family issuing the turn. */
  readonly debugName: string;
  readonly fullTranscript?: boolean;
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
export type InvokeError =
  RunHistoryRefused | DatabaseWriteFailed | StateReadFailed;

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
    /** A compaction summary: one call outside a turn, on the run's binding. */
    readonly call: (
      request: TurnRequest,
      declinedRoutes: readonly DeclinableUsageRoute[],
    ) => Effect.Effect<CallResult, Error>;
  }
>()('@texra/agent/ModelInvoker') {}

/** A failed attempt's classification; the rows it left are in the cell. */
class AttemptFailed extends Data.TaggedError('AttemptFailed')<{
  readonly failure: ModelFailure;
}> {
  override get message(): string {
    return this.failure.formatted.message;
  }
}

/**
 * Build a request service for one run; its model is run-owned, and every row
 * it writes goes through the run cell the loop hands each invocation.
 */
export const modelInvokerLayer = (): Layer.Layer<
  ModelInvoker,
  never,
  AgentRun | UsageLog | LanguageModel | HttpClient.HttpClient
> =>
  Layer.effect(
    ModelInvoker,
    Effect.gen(function* () {
      const run = yield* AgentRun;
      const { runId, session, logger } = run;
      const aggregateId = rowAggregate(runId);
      const usageLog = yield* UsageLog;
      type Binders = LanguageModel | HttpClient.HttpClient;
      const binders = yield* Effect.context<Binders>();
      const attribution = {
        agentName: usageAgentName(run.config.agent, run.config.agentSource),
        agentCategory: run.config.agentCategory,
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
          context: {
            logger,
            runId,
            modelName: bound.modelId,
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
            modelName: bound.config.id,
            agentCategory: run.config.agentCategory,
          },
          session.roots,
        );

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
        ...chainedContinuation(state, bound.origin, request.fullTranscript),
        cacheKey: run.runId,
      });

      const failAttempt = (
        cause: unknown,
        bound: BoundModel,
        partialText?: string,
      ) =>
        Effect.fail(
          new AttemptFailed({
            failure: classifyModelFailure(cause, bound, partialText),
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
          const refused = findStorageRefusal(streamed.cause);
          if (refused) return yield* Effect.fail(refused);
          const cause = Cause.squash(streamed.cause);
          return yield* failAttempt(cause, bound, completed.streamedText);
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
          bound,
        );
        const usage = priceTurnUsage(bound, turn.usage, responseTimeMs);
        const responseId = randomUUID();
        const calls = dispatchFactsFor(
          turn,
          (yield* SynchronizedRef.get(run.steps))?.tools.registry,
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
          ...snapshotRow(runId, state, { runtime: { lastError: null } }),
          positionRow(runId, state, 'response.ready'),
        ]);
        const contextSize = contextTokens(next);
        if (contextSize > 0 && bound.contextWindow > 0) {
          logger.emit({
            type: 'context.state',
            inputTokens: contextSize,
            contextWindow: bound.contextWindow,
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
          bound,
        );
        // R4: the run's context size (`contextTokens`: the last response's
        // provider-counted usage plus an estimate of what was added since).
        // An input that alone exceeds the window is refused before it is
        // billed; one leaving too little room for the requested output
        // shrinks that output rather than letting the provider reject it.
        if (resolved.mode === 'foreground' && bound.contextWindow > 0) {
          const inputTokens = contextTokens(state);
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
          attemptRows(run, state, invocation, bound.origin, resolved),
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
       * A resumed attempt whose background operation the run history holds: observe
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
          // The admitted request as its rows record it, and its storage mode,
          // govern the observation turn, not current code or settings:
          // re-preparing a temporary background turn as stored would let the
          // completion mint an anchor for a response the provider never kept. The prior continuation stays out: observing needs no
          // anchor, and its fingerprint check would reject the turn before
          // observe can compare the admitted fingerprint and deliver the result.
          const state = yield* cell.current;
          const { continuation: _prior, ...admitted } = yield* Effect.sync(() =>
            recordedRequest(state),
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
      ): Effect.Effect<
        InvocationResponse,
        AttemptFailed | InvokeError,
        FileSystem.FileSystem
      > => {
        const routes = routePolicies(bound, (error) =>
          error instanceof AttemptFailed
            ? error.failure.verdict
            : classifyModelFailure(error, bound).verdict,
        );
        return session.modelRetries.withRoutes(routes, {
          baseBackoffMs: RETRY_BACKOFF_MS,
          onWait: (delayMs) =>
            logger.debug(`Waiting ${delayMs}ms for the model recovery probe.`),
        })(attemptOnce(cell, invocation, request, bound));
      };

      /** Rebind a retry, retiring the failed binding; a failure keeps it, loudly. */
      const rebind = (
        selection: RetryCredentials,
        failed: BoundModel,
        declinedRoutes: readonly DeclinableUsageRoute[],
      ) =>
        run
          .swapModel((current) =>
            // A switch may have landed while the panel waited; never undo it.
            current !== failed
              ? Effect.succeed(current)
              : bindModel({
                  modelId: failed.modelId,
                  // A personal-key retry leaves the failed route's overlay
                  // behind (subscription window, prices, PDF admission, a
                  // Kimi coding endpoint) and binds the catalog model.
                  config: selection === 'personal' ? undefined : failed.config,
                  stores: run.stores,
                  compatibilityKey: failed.compatibilityKey,
                  declinedRoutes,
                  agentCategory: run.config.agentCategory,
                  temperature: run.setting.temperature,
                }),
          )
          .pipe(
            Effect.provideContext(binders),
            Effect.tapError((error) =>
              Effect.sync(() =>
                logger.warn('Failed to refresh the model binding', {
                  data: error,
                }),
              ),
            ),
            Effect.result,
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
        // The failure as it is recorded, live or recovered from the run history:
        // the prompt, the row and the reported error all read this one value,
        // so a restart re-presents the same facts the first prompt showed.
        recorded: ProviderError,
        failedAttempt: InvocationRef,
        outstanding: string | null,
      ): Effect.fn.Return<
        Decision,
        InvokeError,
        LanguageModel | HttpClient.HttpClient
      > {
        const requestId = outstanding ?? `retry-${generateShortId()}`;
        const info = toRetryErrorInfo(recorded);
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
          const credentialSwitch = yield* routeCredentialSwitch(
            failed,
            recorded,
            (yield* cell.current).declinedRoutes,
            run.stores.secrets,
          );
          const automatic =
            credentialSwitch?.kind === 'decline-route' &&
            credentialSwitch.automatic
              ? quotaFallbackRouteFor(credentialSwitch.route)
              : null;
          const request = {
            requestId,
            runId,
            operation: 'Model request',
            model: failed.modelId,
            errorMessage: info.message,
            errorDetails: info,
            credentialSwitch,
          };
          const payload = { kind: 'retry', data: request } as const;
          yield* logProviderError(logger, 'Model request failed', recorded);
          if (automatic !== null) {
            logProgressStatus(
              logger,
              `${automatic.retrySourceName} usage limit reached; retrying with ${automatic.retryFallbackName}.`,
            );
          }
          yield* cell.append((state) => [
            {
              type: 'request.opened',
              aggregateId,
              requestId,
              payload,
              thread: null,
            },
            ...retryRows(runId, state, pendingRetry('waiting'), {
              lastError: info,
            }),
            ...(automatic
              ? [{ ...PERSONAL_RETRY, aggregateId, requestId }]
              : policyDecidedRows(session, runId, payload)),
          ]);
        }
        const state = yield* cell.current;
        logger.debug('Waiting for manual retry', { data: info.message });
        // The decision is the `request.decided` row (R5): one already landed
        // (the invoker's own, or a surface's before a crash), else the one the
        // decide command lands while this fiber waits; a closing plane cancels.
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
        if (decision.action === 'retry') {
          logger.debug('Manual retry triggered');
          const selection = decision.credentials ?? 'configured';
          // A personal retry declines the route its offer named, on this
          // run's history only: no concurrent run or stored preference changes.
          const { declinedRoutes: declined, requests } = yield* cell.current;
          const opened = requests[requestId]?.payload;
          const offer =
            opened?.kind === 'retry' ? opened.data.credentialSwitch : null;
          const declinedRoutes =
            selection === 'personal' &&
            offer?.kind === 'decline-route' &&
            !declined.includes(offer.route)
              ? [...declined, offer.route]
              : declined;
          // Always rebuild the binding: a key or preference may have changed
          // while the panel waited; a personal answer declines the route.
          yield* rebind(selection, failed, declinedRoutes);
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
        // One initial attempt plus the binding's automatic retries; the
        // setting is bounded to [0, 5], so the limit is always >= 1.
        const limit =
          1 + (yield* SynchronizedRef.get(run.model)).automaticRetries;
        let automaticAttempts = 0;
        const recoverToken = rejectedTokenRecovery(run, cell.current, rebind);
        let sent = request;
        // An open attempt with no response is an invocation the process never
        // saw finish: the next attempt continues its numbering, and its gate
        // state below says whether a human must admit it first.
        const open = state.openAttempt;
        const invocationId = open?.invocation.invocationId ?? randomUUID();
        let attempt = open === null ? 1 : open.invocation.attempt + 1;
        // An open attempt accepted as background work is observed first, under
        // its recorded deadline; only its failure (or a held gate) starts anew.
        let observing =
          open !== null && open.accepted !== null && state.pendingRetry === null
            ? { invocation: open.invocation, accepted: open.accepted }
            : null;
        // The manual gate as resumed: `waiting` re-presents the request,
        // `authorized` holds one unused permit, `started` needs a new decision.
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
          // Every gate write commits `lastError` with it, so a gate without
          // one is malformed: refuse loudly rather than fabricate a failure.
          if (state.lastError === null) {
            return yield* Effect.die(
              new Error('A manual retry gate has no recorded failure.'),
            );
          }
          lastFailure = state.lastError;
        }
        for (;;) {
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
                yield* SynchronizedRef.get(run.model),
                failure,
                failedAttempt,
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
            // Consume the permit: `started` commits with the attempt row, so a
            // crash cannot reuse the authorization.
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
          // Read after the gate: a manual retry rebinds the model.
          const bound = yield* SynchronizedRef.get(run.model);
          let carried = false;
          let invocation: InvocationRef;
          let exit: Exit.Exit<InvocationResponse, AttemptFailed | InvokeError>;
          // The accepted operation this round observed, if any: a recovered
          // token re-observes it rather than resubmitting an admitted turn.
          const observed = observing;
          if (observed !== null) {
            invocation = observed.invocation;
            exit = yield* Effect.exit(
              observeAccepted(
                cell,
                invocation,
                request,
                bound,
                observed.accepted,
              ),
            );
            observing = null;
          } else {
            invocation = { invocationId, attempt };
            attempt += 1;
            carried =
              'continuation' in
              chainedContinuation(
                yield* cell.current,
                bound.origin,
                sent.fullTranscript,
              );
            exit = yield* Effect.exit(
              gatedAttempt(cell, invocation, sent, bound),
            );
          }
          if (Exit.isSuccess(exit)) return exit.value;
          if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt;
          const found = Cause.findError(exit.cause);
          const error = Result.isSuccess(found) ? found.success : undefined;
          if (error?._tag !== 'AttemptFailed') {
            const runHistory =
              error?._tag === 'RunHistoryRefused' ||
              error?._tag === 'DatabaseWriteFailed';
            return yield* runHistory
              ? Effect.fail(error)
              : Effect.die(error ?? Cause.squash(exit.cause));
          }
          const failure = yield* recoverToken(error.failure, bound);
          if (failure === null) {
            observing = observed;
            continue;
          }
          lastFailure = failure.formatted;
          failedAttempt = invocation;
          const dropChain = carried && failure.storedResponseGone;
          if (dropChain) {
            logger.warn(
              `Chained response gone (${failure.info.message}); retrying once with the full transcript.`,
            );
            sent = { ...request, fullTranscript: true };
          } else automaticAttempts += 1;
          if (isUserAbort(failure.error))
            return { kind: 'cancelled', state: yield* cell.current };
          if (
            dropChain ||
            (failure.autoRetryable && automaticAttempts < limit)
          ) {
            if (!dropChain)
              logger.debug(
                `Model request failed; automatic retry ${automaticAttempts} of ${limit - 1} in ${RETRY_BACKOFF_MS}ms.`,
                { data: failure.info.message },
              );
            const { declinedRoutes: declined } = yield* cell.current;
            yield* beforeNextAttempt(bound, (b) =>
              rebind('configured', b, declined),
            );
            continue;
          }
          if (
            !failure.formatted.userRetryable ||
            hasMissingApiKeyErrorMarker(failure.error)
          ) {
            yield* logProviderError(
              logger,
              'Model request failed (no retry available)',
              failure.formatted,
            );
            // The invoker is the one writer of the run's failure fact.
            const failed = yield* cell.append((state) =>
              snapshotRow(runId, state, {
                runtime: { lastError: failure.info },
              }),
            );
            return { kind: 'failed', state: failed, error: failure.info };
          }
          admission = 'decision';
        }
      });

      /** A compaction summary on the run's binding; its caller records it. */
      const call = (
        request: TurnRequest,
        declinedRoutes: readonly DeclinableUsageRoute[],
      ) =>
        callModel({
          purpose: 'compaction',
          binding: SynchronizedRef.get(run.model),
          reacquire: (failed) => rebind('configured', failed, declinedRoutes),
          request,
          gate: session.modelRetries,
          settings: session.roots,
          attribution,
          logger,
        }).pipe(Effect.provideService(UsageLog, usageLog));

      return { invoke, call };
    }),
  );
