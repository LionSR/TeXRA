/**
 * The invoker's one-shot call and the pieces every model call shares with a
 * turn attempt: the retry gate's route policies, the priced usage report to
 * the process usage log, and the automatic retry batch under the gate.
 *
 * `ModelInvoker` owns every model call. A turn is its `invoke`, with rows; a
 * compaction summary is its `call`, on the run's binding; a helper call (a
 * session description, a draft polish) runs before or beside any run, so it
 * reaches {@link callModel} directly with its session's gate. Each is gated,
 * priced and reported under one retry owner; only a turn writes rows.
 */
import { Cause, Clock, Effect, Exit } from 'effect';
import {
  completedTurn,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm/turn';

import type { AgentTrace } from '@agent/trace';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type AgentCategory,
  type NormalizedUsage,
  type RunId,
} from '@shared/schemas';
import { UsageLog } from '@shared/usageLog';
import { roundTo } from '@utils/core';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError } from '@utils/errors/errorMessage';

import { classifyModelFailure, type ModelRouteVerdict } from './modelFailure';
import { priceTurnUsage } from './pricing';
import type { ModelRetryGate, RoutePolicy } from '../ModelRetryGate';
import type { BoundModel } from './modelBinding';

/** Base delay between automatic attempts; the gate scales its own on top. */
export const RETRY_BACKOFF_MS = 1000;

/**
 * The retry gate's two routes for one binding, narrowest first: the model on
 * its wire route, then the wire route (provider, credential, endpoint).
 * `verdictOf` reads a failed attempt the way its caller classified it.
 */
export function routePolicies(
  bound: BoundModel,
  verdictOf: (error: Error) => ModelRouteVerdict,
): [RoutePolicy, RoutePolicy] {
  return [
    {
      key: bound.modelRetryRouteKey,
      classifyFailure: (error) => {
        const verdict = verdictOf(error);
        return verdict.rateLimitScope === 'model'
          ? { retryAfterMs: verdict.retryAfterMs }
          : undefined;
      },
    },
    {
      key: bound.wireRouteKey,
      classifyFailure: (error) => {
        const verdict = verdictOf(error);
        return verdict.wireRouteFailure
          ? { retryAfterMs: verdict.retryAfterMs }
          : undefined;
      },
      isReachableFailure: (error) =>
        verdictOf(error).rateLimitScope === 'model',
    },
  ];
}

/**
 * Who a call's usage is billed to, as the usage log's wire names them. Every
 * field is stated: a call that serves no run (a draft polish) says so.
 */
export interface UsageAttribution {
  readonly agentName: string;
  readonly agentCategory: AgentCategory | null;
  readonly runId: RunId | null;
}

/**
 * Report one priced call to the process usage log, which bills per call. It
 * writes no session row: a turn's usage is its `response` row and a
 * compaction's its `model.compaction` row.
 */
export const reportUsage = (
  usageLog: UsageLog['Service'],
  bound: BoundModel,
  usage: NormalizedUsage | null,
  attribution: UsageAttribution,
  { config }: SettingsStores,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (usage === null) return;
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    yield* Effect.try({
      try: () =>
        usageLog.log(
          {
            model: bound.config.fullName,
            provider: usage.provider,
            agentName: attribution.agentName,
            ...(attribution.agentCategory === null
              ? {}
              : { agentCategory: attribution.agentCategory }),
            // Billing needs a real number, so a provider that reported no
            // cache-miss count is billed the derived estimate (input minus
            // cache-read). Display never guesses.
            inputTokens:
              usage.cacheMissInputTokens ??
              Math.max(0, usage.inputTokens - cachedInputTokens),
            outputTokens: usage.outputTokens,
            cost: roundTo(usage.cost, 6),
            responseTimeMs: Math.round(usage.responseTimeMs ?? 0),
            cachedInputTokens,
            reasoningTokens: usage.reasoningTokens ?? 0,
            usageRoute: usage.usageRoute ?? 'api-key',
            // The usage-log edge function's wire key, which stores the run id
            // in its `stream_id` column; a server-side rename, not ours.
            ...(attribution.runId === null
              ? {}
              : { streamId: attribution.runId }),
          },
          config,
        ),
      catch: ensureError,
    }).pipe(
      // Best-effort billing edge: a failed log never fails the call.
      Effect.catch((error) =>
        Effect.logWarning('Backend usage logging failed').pipe(
          Effect.annotateLogs({ error }),
        ),
      ),
    );
  });

/** A completed call and its priced usage (`null`: none reported). */
export interface CallResult {
  readonly turn: TurnResult;
  readonly usage: NormalizedUsage | null;
}

/**
 * Between two automatic attempts, in both retry loops (a turn's and
 * {@link callModel}'s): the backoff, then a fresh binding when the failed one
 * held a connection a failure invalidates. A Responses WebSocket dies with a
 * failed turn and ages out after 55 minutes, so retrying on it cannot
 * succeed (#13407).
 */
export const beforeNextAttempt = <E, R>(
  failed: BoundModel,
  reacquire: (failed: BoundModel) => Effect.Effect<unknown, E, R>,
): Effect.Effect<unknown, E, R> =>
  Effect.sleep(RETRY_BACKOFF_MS).pipe(
    Effect.andThen(
      failed.persistentConnection ? reacquire(failed) : Effect.void,
    ),
  );

export interface ModelCall<R = never> {
  /** Why the call is made; a turn is `ModelInvoker.invoke`, not this path. */
  readonly purpose: 'compaction' | 'helper';
  /** The binding in force, read again before every attempt. */
  readonly binding: Effect.Effect<BoundModel>;
  /** Replace a binding whose connection a failure killed. */
  readonly reacquire: (failed: BoundModel) => Effect.Effect<unknown, never, R>;
  /** A foreground request; each attempt prepares it on its binding. */
  readonly request: TurnRequest;
  /** The session's retry gate: sibling calls on one credential share it. */
  readonly gate: ModelRetryGate;
  /** The session's settings: the retry limit and usage consent read them. */
  readonly settings: SettingsStores;
  readonly attribution: UsageAttribution;
  /** Automatic retries; the configured batch when absent. */
  readonly retries?: number;
  /** A run's trace; without one, diagnostics go to the Effect logger. */
  readonly logger: Pick<AgentTrace, 'warn' | 'debug'> | null;
}

/**
 * One completed call outside a turn: prepared, streamed to its completed
 * result under the session's route gate, retried automatically as a turn's
 * attempts are (the batch, over failures classified retryable on the bound
 * route, reacquiring a dead connection first), then priced and reported. It
 * writes no row; a caller that records the call stamps the usage on its own.
 */
export const callModel = Effect.fn('ModelInvoker.call')(function* <R>(
  call: ModelCall<R>,
): Effect.fn.Return<CallResult, Error, UsageLog | R> {
  const retries =
    call.retries ??
    (yield* readSettingFrom<number>(
      call.settings,
      MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
    ));
  // The trace's sinks are synchronous; with no trace, lines queue here and
  // leave through the Effect logger at the next step.
  const queued: Effect.Effect<void>[] = [];
  const logger = call.logger ?? {
    warn: (message: string) => void queued.push(Effect.logWarning(message)),
    debug: (message: string) => void queued.push(Effect.logDebug(message)),
  };
  const flush = Effect.suspend(() =>
    Effect.all(queued.splice(0), { discard: true }),
  );
  for (let attempt = 0; ; attempt++) {
    const bound = yield* call.binding;
    const once = Effect.gen(function* () {
      const prepared = yield* bound.model.prepareTurn(call.request);
      if (prepared.mode !== 'foreground') {
        return yield* Effect.die(
          new Error(`A ${call.purpose} call prepared as background work.`),
        );
      }
      const started = yield* Clock.currentTimeMillis;
      const turn = yield* completedTurn(bound.model.streamTurn(prepared));
      const responseTimeMs = (yield* Clock.currentTimeMillis) - started;
      return { turn, responseTimeMs };
    });
    const exit = yield* Effect.exit(
      call.gate.withRoutes(
        routePolicies(
          bound,
          (error) => classifyModelFailure(error, bound).verdict,
        ),
        {
          baseBackoffMs: RETRY_BACKOFF_MS,
          onWait: (delayMs) =>
            logger.debug(`Waiting ${delayMs}ms for the model recovery probe.`),
        },
      )(once),
    );
    yield* flush;
    if (Exit.isSuccess(exit)) {
      const { turn, responseTimeMs } = exit.value;
      const usage = priceTurnUsage(bound, turn.usage, responseTimeMs);
      yield* flush;
      yield* reportUsage(
        yield* UsageLog,
        bound,
        usage,
        call.attribution,
        call.settings,
      );
      return { turn, usage };
    }
    const error = Cause.squash(exit.cause);
    // Stamped with the bound route, as a turn's attempts are: an exhausted
    // plan's 429 on a shared API-key host is not a rate limit.
    if (
      Cause.hasInterrupts(exit.cause) ||
      attempt >= retries ||
      !classifyModelFailure(error, bound).autoRetryable
    ) {
      return yield* Effect.failCause(exit.cause);
    }
    yield* beforeNextAttempt(bound, call.reacquire);
  }
});
