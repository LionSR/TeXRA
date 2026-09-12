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
 * and it is durable here: the prompt is admitted by an `approval.requested`
 * row bound through a `flow.snapshot` whose `pendingRetry` walks
 * `waiting` -> `authorized` -> `started`. A decision survives a restart, an
 * unused permit survives one, and a consumed permit never buys a second
 * billed attempt implicitly.
 */
import { randomUUID } from 'node:crypto';

import {
  Cause,
  Context,
  Effect,
  Exit,
  Layer,
  Ref,
  Scope,
  Stream,
  SynchronizedRef,
} from 'effect';

import { maybeSaveDebugObject } from '@agent/debug/debugMessageSaver';
import { isRemoteAgent } from '@agent/index/agentRegistry';
import {
  logContextManagementEvent,
  logErrorData,
  logProgressStatus,
  type StreamHandle,
} from '@agent/trace';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import { hasMissingApiKeyErrorMarker } from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  ModelError,
  type BackgroundEvent,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from '@llm/turn';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { roundedUtilizationPercent } from '@shared/runs/contextUtilization';
import {
  AgentCategory,
  MESSAGE_TYPES,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelRetryMaxAttemptsSchema,
  RUN_PHASE,
  toRetryErrorInfo,
  type InvocationRef,
  type NormalizedUsage,
  type ProviderError,
  type RetryErrorInfo,
  type SnapshotRuntime,
} from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import { generateShortId } from '@utils/core';
import { getConfig, getValidatedConfig } from '@utils/config/configUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun } from './run/AgentRun';
import { bindModel, type BoundModel } from './run/modelBinding';
import { classifyModelFailure, type ModelFailure } from './run/modelFailure';
import { priceTurnUsage } from './run/pricing';
import { dispatchFactsFor } from './run/tools';
import {
  redactedForFact,
  rowAggregate,
  runtimeSnapshotRow,
  stepRow,
} from './loop/rows';

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
 * One initial attempt plus the configured number of automatic retries. The
 * schema bounds the setting to [0, 5] and falls back to the default on
 * anything else, so the result is always >= 1.
 */
function automaticAttemptLimit(): number {
  return (
    1 +
    getValidatedConfig(
      'texra.model.retry.maxAttempts',
      ModelRetryMaxAttemptsSchema,
      MODEL_RETRY_MAX_ATTEMPTS_SETTING.defaultValue,
    )
  );
}

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

export type InvocationOutcome =
  | InvocationResponse
  | {
      readonly kind: 'failed';
      readonly state: RunState;
      readonly error: RetryErrorInfo;
    }
  | { readonly kind: 'cancelled'; readonly state: RunState };

export type InvokeError = RunLedgerRefused | DatabaseWriteFailed;

export class ModelInvoker extends Context.Service<
  ModelInvoker,
  {
    readonly invoke: (
      state: RunState,
      request: InvokeRequest,
    ) => Effect.Effect<InvocationOutcome, InvokeError>;
  }
>()('@texra/agent/ModelInvoker') {}

/** The assistant text of a completed turn: message parts, in order. */
export function turnText(turn: TurnResult): string {
  return turn.content
    .flatMap((part) =>
      part.kind === 'message' ? part.content.map((piece) => piece.text) : [],
    )
    .join('');
}

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

/** A failed attempt: its classification plus the state its rows left. */
class AttemptFailed extends Error {
  constructor(
    readonly failure: ModelFailure,
    readonly state: RunState,
  ) {
    super(failure.formatted.message);
    this.name = 'AttemptFailed';
  }
}

type RetryLifecycleEvent =
  | 'attempt_started'
  | 'attempt_succeeded'
  | 'attempt_failed'
  | 'retry_decision_requested'
  | 'retry_decided';

export const modelInvokerLayer: Layer.Layer<
  ModelInvoker,
  never,
  AgentRun | RunLedger
> = Layer.effect(
  ModelInvoker,
  Effect.gen(function* () {
    const run = yield* AgentRun;
    const ledger = yield* RunLedger;
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
      Effect.tryPromise({
        try: () =>
          maybeSaveDebugObject({
            object,
            objectType,
            context: {
              logger,
              runId,
              modelName: run.config.model,
              isRemote: isRemoteAgent(run.config.agent),
            },
            fileOptions: { continuationCount: round, baseName },
          }),
        catch: ensureError,
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() =>
            logger.debug('Debug object save failed', { data: error }),
          ),
        ),
      );

    /** The snapshot the retry protocol commits: runtime fields on the last
     *  written family state, references from the folded rows. */
    const retrySnapshot = (
      state: RunState,
      runtime: Pick<SnapshotRuntime, 'pendingRetry' | 'lastError'>,
    ): RunLedgerDraft => runtimeSnapshotRow(runId, state, runtime);

    /**
     * Whether a turn runs as background work: a workflow turn on a binding
     * that supports it, under the provider's toggle. Tool-use turns stream
     * (per-step output); the OpenAI toggle applies to GPT models as its
     * description says, the Google one to any route with server-side state.
     */
    const backgroundRequested = (bound: BoundModel): boolean => {
      if (!bound.backgroundCapable) return false;
      if (run.config.agentCategory !== AgentCategory.Workflow) return false;
      if (bound.origin.protocol === 'google-interactions') {
        return getConfig<boolean>('texra.model.useGoogleBackgroundResponses');
      }
      return (
        bound.config.name.toLowerCase().startsWith('gpt') &&
        getConfig<boolean>('texra.model.useBackgroundResponses')
      );
    };

    const failAttempt = (cause: unknown, at: RunState) =>
      Effect.fail(new AttemptFailed(classifyModelFailure(cause), at));

    interface AttemptTrace {
      readonly thinking: StreamHandle;
      readonly output: StreamHandle;
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
        stateRef: Ref.Ref<RunState>,
        trace: AttemptTrace,
        completed: { value: TurnResult | null },
      ) =>
      (event: TurnEvent | BackgroundEvent) =>
        Effect.gen(function* () {
          switch (event.kind) {
            case 'identified': {
              const current = yield* Ref.get(stateRef);
              if (
                current.openAttempt?.providerResponseId ===
                event.providerResponseId
              ) {
                return;
              }
              const next = yield* ledger.appendBatch(runId, current, [
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
              yield* Ref.set(stateRef, next);
              return;
            }
            case 'delta':
              if (event.part === 'reasoning') trace.thinking.append(event.text);
              else trace.output.append(event.text);
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
      state: RunState,
      invocation: InvocationRef,
      request: InvokeRequest,
      bound: BoundModel,
      operationId: string,
      trace: AttemptTrace,
      started: number,
      streamed: Exit.Exit<void, unknown>,
      completed: { value: TurnResult | null },
    ): Effect.fn.Return<InvocationResponse, AttemptFailed | InvokeError> {
      if (Exit.isFailure(streamed)) {
        trace.thinking.finalize(undefined);
        trace.output.finalize();
        if (Cause.hasInterrupts(streamed.cause)) return yield* Effect.interrupt;
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
        return yield* failAttempt(cause, state);
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
          state,
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
      if (usage !== null && usage.inputTokens > 0 && bound.contextWindow > 0) {
        logger.contextState({
          inputTokens: usage.inputTokens,
          contextWindow: bound.contextWindow,
        });
      }
      const responseId = randomUUID();
      const calls = dispatchFactsFor(turn, run.tools, logger, generateShortId);
      // The completed turn, committed once before any local tool runs.
      const next = yield* Effect.uninterruptible(
        ledger.appendBatch(runId, state, [
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
          stepRow(runId, state, 'response.ready'),
        ]),
      );
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
      stateRef: Ref.Ref<RunState>,
      onEvent: (event: BackgroundEvent) => Effect.Effect<void, InvokeError>,
      completed: { value: TurnResult | null },
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
      const current = yield* Ref.get(stateRef);
      const next = yield* Effect.uninterruptible(
        ledger.appendBatch(runId, current, [
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
        ]),
      );
      yield* Ref.set(stateRef, next);
      yield* Stream.runForEach(
        background.observe(submission.operation, { deadlineAtMs }),
        onEvent,
      );
    });

    /**
     * One billed attempt: prepare, commit the `attempt` row, stream or
     * submit-and-observe, commit the `response` row. Preparation and the
     * events run interruptible; the appends are masked so a stop cannot
     * split a request from its row. Fails with `AttemptFailed` carrying the
     * state after the attempt row.
     */
    const attemptOnce = Effect.fn('ModelInvoker.attempt')(function* (
      initial: RunState,
      invocation: InvocationRef,
      request: InvokeRequest,
      bound: BoundModel,
      operationId: string,
    ): Effect.fn.Return<InvocationResponse, AttemptFailed | InvokeError> {
      let state = initial;
      const turnRequest: TurnRequest = {
        mode: backgroundRequested(bound) ? 'background' : 'foreground',
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
      };
      const prepared = yield* Effect.exit(bound.model.prepareTurn(turnRequest));
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) return yield* Effect.interrupt;
        return yield* failAttempt(Cause.squash(prepared.cause), state);
      }
      let resolved = prepared.value;
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
      if (
        resolved.mode === 'foreground' &&
        bound.model.estimateInputTokens &&
        bound.contextWindow > 0
      ) {
        const estimate = yield* Effect.exit(
          bound.model.estimateInputTokens(resolved),
        );
        if (Exit.isFailure(estimate)) {
          if (Cause.hasInterrupts(estimate.cause))
            return yield* Effect.interrupt;
          logger.debug(
            'Token counting failed. Proceeding without token adjustment.',
            { data: Cause.squash(estimate.cause) },
          );
        } else if (estimate.value.inputTokens > bound.contextWindow) {
          return yield* failAttempt(
            new ModelError({
              kind: 'invalid-request',
              message: `Input is ${estimate.value.inputTokens} tokens, which exceeds the model's context window of ${bound.contextWindow} tokens.`,
            }),
            state,
          );
        } else {
          const inputTokens = estimate.value.inputTokens;
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
            const clamped = yield* Effect.exit(
              bound.model.prepareTurn({
                ...turnRequest,
                maxOutputTokens: reduced,
              }),
            );
            if (Exit.isFailure(clamped)) {
              if (Cause.hasInterrupts(clamped.cause)) {
                return yield* Effect.interrupt;
              }
              return yield* failAttempt(Cause.squash(clamped.cause), state);
            }
            resolved = clamped.value;
          }
        }
      }
      logRetryLifecycle(operationId, 'attempt_started', bound, {
        attempt: invocation.attempt,
        delivery: resolved.mode,
      });
      // The durable fact before the billed request (F1).
      state = yield* Effect.uninterruptible(
        ledger.appendBatch(runId, state, [
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
        ]),
      );
      const trace = openTrace();
      const stateRef = yield* Ref.make(state);
      const started = Date.now();
      const completed: { value: TurnResult | null } = { value: null };
      const onEvent = eventSink(invocation, stateRef, trace, completed);
      const streamed = yield* Effect.exit(
        resolved.mode === 'foreground'
          ? Stream.runForEach(bound.model.streamTurn(resolved), onEvent)
          : submitAndObserve(
              resolved,
              invocation,
              bound,
              stateRef,
              onEvent,
              completed,
            ),
      );
      state = yield* Ref.get(stateRef);
      return yield* finishAttempt(
        state,
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
     * outside the route gate.
     */
    const observeAccepted = Effect.fn('ModelInvoker.observeAccepted')(
      function* (
        initial: RunState,
        invocation: InvocationRef,
        request: InvokeRequest,
        bound: BoundModel,
        operationId: string,
        accepted: NonNullable<NonNullable<RunState['openAttempt']>['accepted']>,
      ): Effect.fn.Return<InvocationResponse, AttemptFailed | InvokeError> {
        const background = bound.model.background;
        if (background === undefined) {
          return yield* failAttempt(
            new ModelError({
              kind: 'unsupported',
              message:
                'The run resumed onto a model that cannot observe its accepted background operation.',
            }),
            initial,
          );
        }
        logRetryLifecycle(operationId, 'attempt_started', bound, {
          attempt: invocation.attempt,
          delivery: 'background',
          resumed: true,
        });
        const trace = openTrace();
        const stateRef = yield* Ref.make(initial);
        const started = Date.now();
        const completed: { value: TurnResult | null } = { value: null };
        const streamed = yield* Effect.exit(
          Stream.runForEach(
            background.observe(accepted.operation, {
              deadlineAtMs: accepted.deadlineAtMs,
            }),
            eventSink(invocation, stateRef, trace, completed),
          ),
        );
        const state = yield* Ref.get(stateRef);
        return yield* finishAttempt(
          state,
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
     * One attempt under the session's route gate. The gate is Promise-tier
     * session state by design (sibling runs share cooling); the attempt runs
     * inside its permit on this fiber's services, and the fiber's abort
     * signal is the one the gate waits and the request abort on.
     */
    const gatedAttempt = (
      state: RunState,
      invocation: InvocationRef,
      request: InvokeRequest,
      bound: BoundModel,
      operationId: string,
    ): Effect.Effect<InvocationResponse, AttemptFailed | InvokeError> =>
      Effect.scoped(
        Effect.gen(function* () {
          const signal = yield* Effect.abortSignal;
          const gate = session.modelRetries;
          const verdictFor = (error: Error) =>
            error instanceof AttemptFailed
              ? error.failure.verdict
              : classifyModelFailure(error).verdict;
          const routes = [
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
          // The permits: an abort or a disposed gate while waiting rejects,
          // which is this fiber being stopped or the session torn down, and
          // only those two reasons become an interrupt. Any other rejection
          // is a bug in the gate and dies with its cause rather than reading
          // to the user as a stop.
          const acquired = yield* Effect.tryPromise({
            try: () =>
              gate.acquireAll(routes, {
                signal,
                onWait: (delayMs) =>
                  logger.debug(
                    `Waiting ${delayMs}ms for the model recovery probe.`,
                  ),
              }),
            catch: (cause) => cause,
          }).pipe(
            Effect.catchIf(
              (cause) => isUserAbort(cause) || cause === signal.reason,
              () => Effect.interrupt,
            ),
            Effect.catch((cause) => Effect.die(ensureError(cause))),
          );
          const exit = yield* Effect.exit(
            attemptOnce(state, invocation, request, bound, operationId),
          );
          if (Exit.isSuccess(exit)) {
            gate.settle(acquired, { kind: 'success' }, RETRY_BACKOFF_MS);
            return exit.value;
          }
          if (Cause.hasInterrupts(exit.cause)) {
            gate.settle(acquired, { kind: 'abandoned' }, RETRY_BACKOFF_MS);
            return yield* Effect.interrupt;
          }
          const error = Cause.squash(exit.cause);
          gate.settle(
            acquired,
            { kind: 'failure', error: ensureError(error) },
            RETRY_BACKOFF_MS,
          );
          return yield* exit;
        }),
      );

    /** Rebuild the model binding a retry runs on. */
    const rebind = (selection: ModelCredentialSelection, failed: BoundModel) =>
      SynchronizedRef.updateEffect(run.model, (current) =>
        Effect.gen(function* () {
          // A switch may have landed while the panel waited; never undo it.
          if (current !== failed) return current;
          const config =
            selection === 'personal' && failed.routedOnKimiCode
              ? ((yield* Effect.tryPromise({
                  try: () =>
                    run.inScope(() =>
                      resolveRuntimeModelConfig(failed.modelId),
                    ),
                  catch: ensureError,
                })) ?? failed.config)
              : failed.config;
          const next = yield* bindModel({
            config,
            stores: run.stores,
            compatibilityKey: failed.compatibilityKey,
            agentCategory: run.config.agentCategory,
            temperature: run.setting.temperature,
            inScope: run.inScope,
          }).pipe(Scope.provide(run.scope));
          logger.debug('Refreshed model binding before manual retry');
          return next;
        }),
      );

    type Decision =
      | { readonly kind: 'retry'; readonly state: RunState }
      | { readonly kind: 'deny'; readonly state: RunState }
      | { readonly kind: 'cancel'; readonly state: RunState };

    /**
     * The durable manual-retry admission. `requestId` is the outstanding
     * request when the run resumed with a `waiting` gate, else a new one is
     * committed with its binding before the prompt is shown.
     */
    const manualRetry = Effect.fn('ModelInvoker.manualRetry')(function* (
      initial: RunState,
      failed: BoundModel,
      // The failure as it is recorded, live or recovered from the ledger:
      // the prompt, the row and the reported error all read this one value,
      // so a restart re-presents the same facts the first prompt showed.
      recorded: ProviderError,
      failedAttempt: InvocationRef,
      operationId: string,
      outstanding: string | null,
    ): Effect.fn.Return<Decision, InvokeError> {
      let state = initial;
      const requestId = outstanding ?? `retry-${generateShortId()}`;
      const info = toRetryErrorInfo(recorded);
      const request = {
        requestId,
        runId,
        operation: 'Model request',
        model: failed.modelId,
        errorMessage: info.message,
        errorDetails: info,
        kimiCodeRoutedOnFailure: failed.routedOnKimiCode,
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
        state = yield* Effect.uninterruptible(
          ledger.appendBatch(runId, state, [
            {
              type: 'approval.requested',
              aggregateId,
              requestId,
              // The row is committed here rather than at the interaction
              // owner's publish door (`requestRowCommitted`), so the scrub
              // that door applies happens here: a provider message echoing
              // an `Authorization` header never reaches a durable row.
              payload: redactedForFact({ kind: 'retry', data: request }),
            },
            retrySnapshot(state, {
              pendingRetry: pendingRetry('waiting'),
              lastError: info,
            }),
          ]),
        );
      }
      session.status.transition(runId, RUN_PHASE.WAITING, 'wait');
      logger.debug('Waiting for manual retry', { data: info.message });
      // The host's credential selection is recorded here and the binding is
      // rebuilt on this fiber once the decision lands: the rebind is part of
      // the admitted attempt, never a side effect of the prompt.
      let selection: ModelCredentialSelection = 'configured';
      const result = yield* Effect.tryPromise({
        try: () =>
          session.interactions.requestRetry(request, {
            requestRowCommitted: true,
            prepareRetry: (selected) => {
              selection = selected;
              return Promise.resolve();
            },
          }),
        catch: ensureError,
      }).pipe(
        // A rejected prompt (a host torn down mid-wait) is a cancellation.
        Effect.catch((error) =>
          Effect.sync(() => {
            logger.warn('The retry prompt failed', { data: error });
            return { action: 'cancel' as const };
          }),
        ),
      );
      const decisionSource =
        result.action === 'retry' ? (result.decisionSource ?? 'human') : null;
      logRetryLifecycle(operationId, 'retry_decided', failed, {
        action: result.action,
        decisionSource:
          decisionSource ?? (result.action === 'deny' ? 'denied' : 'cancelled'),
      });
      if (result.action === 'retry') {
        logger.debug('Manual retry triggered');
        session.status.transition(runId, RUN_PHASE.RUNNING, 'resume');
        // Always rebuild the binding on a manual retry: the user may have set
        // a new key or toggled a route preference while the panel waited. A
        // rebind that fails leaves the run on the binding it has, loudly.
        yield* rebind(selection, failed).pipe(
          Effect.catch((error) =>
            Effect.sync(() =>
              logger.warn('Failed to refresh the model binding before retry', {
                data: error,
              }),
            ),
          ),
        );
        state = yield* Effect.uninterruptible(
          ledger.appendBatch(runId, state, [
            {
              type: 'approval.resolved',
              aggregateId,
              requestId,
              decision: 'approved',
            },
            retrySnapshot(state, {
              pendingRetry: pendingRetry('authorized'),
              lastError: info,
            }),
          ]),
        );
        return { kind: 'retry', state };
      }
      if (result.action === 'deny') {
        logProgressStatus(
          logger,
          result.reason ?? 'Retry denied (no human input available)',
        );
        session.status.transition(runId, RUN_PHASE.RUNNING, 'resume');
        state = yield* Effect.uninterruptible(
          ledger.appendBatch(runId, state, [
            {
              type: 'approval.resolved',
              aggregateId,
              requestId,
              decision: 'denied',
              ...(result.reason !== undefined ? { cause: result.reason } : {}),
            },
            retrySnapshot(state, { pendingRetry: null, lastError: info }),
          ]),
        );
        return { kind: 'deny', state };
      }
      logProgressStatus(logger, 'Retry cancelled by user');
      session.status.transition(runId, RUN_PHASE.CANCELLED, 'user-stop');
      state = yield* Effect.uninterruptible(
        ledger.appendBatch(runId, state, [
          {
            type: 'approval.resolved',
            aggregateId,
            requestId,
            decision: 'cancelled',
          },
          retrySnapshot(state, { pendingRetry: null, lastError: info }),
        ]),
      );
      return { kind: 'cancel', state };
    });

    const invoke = Effect.fn('ModelInvoker.invoke')(function* (
      initial: RunState,
      request: InvokeRequest,
    ): Effect.fn.Return<InvocationOutcome, InvokeError> {
      let state = initial;
      const operationId = `model-operation-${generateShortId()}`;
      const limit = automaticAttemptLimit();
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
      // `authorized`: one unused permit. `started`: the permit was spent by
      // an attempt that never reported, so a new decision is required.
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
              state,
              bound,
              failure,
              failedAttempt,
              operationId,
              outstanding,
            );
            state = decision.state;
            outstanding = null;
            if (decision.kind === 'deny') {
              return {
                kind: 'failed',
                state,
                error: toRetryErrorInfo(failure),
              };
            }
            if (decision.kind === 'cancel') return { kind: 'cancelled', state };
          }
          // Consume the permit: `started` commits with the attempt row, so
          // a crash after this transaction cannot reuse the authorization.
          const gate = state.pendingRetry;
          if (gate === null) {
            return yield* Effect.die(
              new Error('An authorized retry has no gate.'),
            );
          }
          state = yield* Effect.uninterruptible(
            ledger.appendBatch(runId, state, [
              runtimeSnapshotRow(runId, state, {
                pendingRetry: { ...gate, substate: 'started' },
              }),
            ]),
          );
          admission = 'automatic';
        }
        let invocation: InvocationRef;
        let exit: Exit.Exit<InvocationResponse, AttemptFailed | InvokeError>;
        if (observing !== null) {
          invocation = observing.invocation;
          exit = yield* Effect.exit(
            observeAccepted(
              state,
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
              state,
              invocation,
              request,
              yield* SynchronizedRef.get(run.model),
              operationId,
            ),
          );
        }
        if (Exit.isSuccess(exit)) return exit.value;
        if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt;
        const error = Cause.squash(exit.cause);
        if (!(error instanceof AttemptFailed)) {
          if (
            error instanceof RunLedgerRefused ||
            error instanceof DatabaseWriteFailed
          ) {
            return yield* Effect.fail(error);
          }
          return yield* Effect.die(error);
        }
        state = error.state;
        lastFailure = error.failure.formatted;
        failedAttempt = invocation;
        automaticAttempts += 1;
        const { failure } = error;
        if (isUserAbort(failure.error)) return { kind: 'cancelled', state };
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
          return { kind: 'failed', state, error: failure.info };
        }
        admission = 'decision';
      }
    });

    return { invoke };
  }),
);
