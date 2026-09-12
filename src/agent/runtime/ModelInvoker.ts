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
  Stream,
  SynchronizedRef,
} from 'effect';

import { maybeSaveDebugObject } from '@agent/debug/debugMessageSaver';
import { isRemoteAgent } from '@agent/index/agentRegistry';
import {
  logErrorData,
  logProgressStatus,
  type StreamHandle,
} from '@agent/trace';
import type { ModelCredentialSelection } from '@agent/types/ModelHandlerContracts';
import { hasMissingApiKeyErrorMarker } from '@common/errors/sdkError/errorMetadata';
import { isUserAbort } from '@common/errors/sdkError/errorPatterns';
import {
  ModelError,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from '@llm/turn';
import { resolveRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  MESSAGE_TYPES,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  ModelRetryMaxAttemptsSchema,
  RUN_PHASE,
  type InvocationRef,
  type NormalizedUsage,
  type RetryErrorInfo,
  type SnapshotRuntime,
} from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedger, RunLedgerRefused } from '@shared/session/runLedger';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';
import { generateShortId } from '@utils/core';
import { getValidatedConfig } from '@utils/config/configUtils';
import { ensureError } from '@utils/errors/errorMessage';

import { AgentRun } from './run/AgentRun';
import { bindModel, type BoundModel } from './run/modelBinding';
import { classifyModelFailure, type ModelFailure } from './run/modelFailure';
import { priceTurnUsage } from './run/pricing';
import { dispatchFactsFor } from './run/tools';
import { rowAggregate, runtimeSnapshotRow, stepRow } from './loop/rows';

/** Base delay between automatic attempts; the gate scales its own on top. */
const RETRY_BACKOFF_MS = 1000;

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
     * One billed attempt: prepare, commit the `attempt` row, stream, commit
     * the `response` row. Preparation and the stream run interruptible; the
     * two appends are masked so a stop cannot split a request from its row.
     * Fails with `AttemptFailed` carrying the state after the attempt row.
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
        mode: 'foreground',
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
      const fail = (cause: unknown, at: RunState) =>
        Effect.fail(new AttemptFailed(classifyModelFailure(cause), at));
      const prepared = yield* Effect.exit(bound.model.prepareTurn(turnRequest));
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) return yield* Effect.interrupt;
        return yield* fail(Cause.squash(prepared.cause), state);
      }
      const resolved = prepared.value;
      if (resolved.mode !== 'foreground') {
        return yield* fail(
          new ModelError({
            kind: 'unsupported',
            message: 'The run loops issue foreground turns only.',
          }),
          state,
        );
      }
      yield* saveDebug(
        state.messages,
        'messages',
        request.round,
        request.debugName,
      );
      // R4: the input estimate where the provider offers one. A count that
      // fails is logged and the provider enforces its own limit; an input
      // that alone exceeds the window is refused before it is billed.
      if (bound.model.estimateInputTokens && bound.contextWindow > 0) {
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
          return yield* fail(
            new ModelError({
              kind: 'invalid-request',
              message: `Input is ${estimate.value.inputTokens} tokens, which exceeds the model's context window of ${bound.contextWindow} tokens.`,
            }),
            state,
          );
        }
      }
      logRetryLifecycle(operationId, 'attempt_started', bound, {
        attempt: invocation.attempt,
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
              delivery: 'stream',
            },
          },
        ]),
      );
      const thinking: StreamHandle = logger.openRun(MESSAGE_TYPES.THINKING, {
        deferStart: true,
      });
      const output: StreamHandle = logger.openRun(
        MESSAGE_TYPES.MODEL_RESPONSE,
        { deferStart: true },
      );
      const stateRef = yield* Ref.make(state);
      const started = Date.now();
      const completed: { value: TurnResult | null } = { value: null };
      const onEvent = (event: TurnEvent) =>
        Effect.gen(function* () {
          switch (event.kind) {
            case 'identified': {
              const current = yield* Ref.get(stateRef);
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
              if (event.part === 'reasoning') thinking.append(event.text);
              else output.append(event.text);
              return;
            case 'phase':
              return;
            case 'completed':
              completed.value = event.result;
              return;
          }
        });
      const streamed = yield* Effect.exit(
        Stream.runForEach(bound.model.streamTurn(resolved), onEvent),
      );
      state = yield* Ref.get(stateRef);
      if (Exit.isFailure(streamed)) {
        thinking.finalize(undefined);
        output.finalize();
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
        return yield* fail(cause, state);
      }
      const responseTimeMs = Date.now() - started;
      const turn = completed.value;
      if (turn === null) {
        thinking.finalize(undefined);
        output.finalize();
        return yield* fail(
          new ModelError({
            kind: 'malformed-output',
            message: EMPTY_RESPONSE_ERROR_MESSAGE,
          }),
          state,
        );
      }
      const text = turnText(turn);
      const reasoning = turnReasoning(turn);
      thinking.finalize(reasoning === '' ? undefined : reasoning);
      output.finalize(text);
      yield* saveDebug(
        turn,
        'response',
        request.round,
        `${request.debugName}_response`,
      );
      const usage = priceTurnUsage(bound, turn.usage, responseTimeMs);
      if (usage !== null && usage.inputTokens > 0 && bound.contextWindow > 0) {
        logger.contextState({
          inputTokens: usage.inputTokens,
          contextWindow: bound.contextWindow,
        });
      }
      const responseId = randomUUID();
      const calls = dispatchFactsFor(turn, run.tools, logger, generateShortId);
      // The completed turn, committed once before any local tool runs.
      state = yield* Effect.uninterruptible(
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
        state,
        responseId,
        turn,
        text,
        usage,
        responseTimeMs,
      };
    });

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
          // which is this fiber being stopped or the session torn down.
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
          }).pipe(Effect.catch(() => Effect.interrupt));
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
            compatibilityKey: failed.compatibilityKey,
            agentCategory: run.config.agentCategory,
            temperature: run.setting.temperature,
            inScope: run.inScope,
          });
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
      failure: ModelFailure,
      failedAttempt: InvocationRef,
      operationId: string,
      outstanding: string | null,
    ): Effect.fn.Return<Decision, InvokeError> {
      let state = initial;
      const requestId = outstanding ?? `retry-${generateShortId()}`;
      const info = failure.info;
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
        logErrorData(logger, 'Model request failed', failure.formatted);
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
              payload: { kind: 'retry', data: request },
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
      // The manual gate as resumed. `waiting`: re-present the same request.
      // `authorized`: one unused permit. `started`: the permit was spent by
      // an attempt that never reported, so a new decision is required.
      let admission: 'automatic' | 'authorized' | 'decision' | 'waiting' =
        'automatic';
      let outstanding: string | null = null;
      let lastFailure: ModelFailure | null = null;
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
        lastFailure = classifyModelFailure(
          new Error(state.lastError?.message ?? 'The previous attempt failed.'),
        );
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
              return { kind: 'failed', state, error: failure.info };
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
        const invocation: InvocationRef = { invocationId, attempt };
        const exit = yield* Effect.exit(
          gatedAttempt(
            state,
            invocation,
            request,
            yield* SynchronizedRef.get(run.model),
            operationId,
          ),
        );
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
        lastFailure = error.failure;
        failedAttempt = invocation;
        attempt += 1;
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
