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
import { Clock, Effect, Schedule } from 'effect';
import {
  completedTurn,
  type TurnRequest,
  type TurnResult,
} from '@texra-ai/llm/turn';

import type { AgentTrace } from '@agent/trace';
import type { ModelRouteVerdict } from '@common/errors/sdkError/providerErrorFormat';
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

import { classifyModelFailure } from './modelFailure';
import { priceTurnUsage } from './pricing';
import type { ModelRetryGate, RoutePolicy } from '../ModelRetryGate';
import type { BoundModel } from './modelBinding';

/** Why a model call is made. Only a turn is recorded on the run ledger. */
export type CallPurpose = 'turn' | 'compaction' | 'helper';

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

/** Who a call's usage is billed to, as the usage log's wire names them. */
export interface UsageAttribution {
  readonly agentName?: string;
  readonly agentCategory?: AgentCategory;
  /** The run the call served; a helper with no run has none. */
  readonly runId?: RunId;
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
            ...(attribution.agentName === undefined
              ? {}
              : { agentName: attribution.agentName }),
            ...(attribution.agentCategory === undefined
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
            ...(attribution.runId === undefined
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

export interface ModelCall {
  readonly purpose: Exclude<CallPurpose, 'turn'>;
  readonly bound: BoundModel;
  /** A foreground request; the call prepares it on `bound`. */
  readonly request: TurnRequest;
  /** The session's retry gate: sibling calls on one credential share it. */
  readonly gate: ModelRetryGate;
  /** The session's settings: the retry limit and usage consent read them. */
  readonly settings: SettingsStores;
  readonly attribution: UsageAttribution;
  /** Where a pricing warning goes: the run's trace, or the process log. */
  readonly logger: Pick<AgentTrace, 'warn' | 'debug'>;
}

/**
 * One completed call outside a turn: prepared, streamed to its completed
 * result under the session's route gate, retried automatically as a turn's
 * attempts are (the configured batch, over failures classified retryable on
 * the bound route), then priced and reported. It writes no row; a caller
 * that records the call stamps the returned usage on its own row.
 */
export const callModel = Effect.fn('ModelInvoker.call')(function* (
  call: ModelCall,
): Effect.fn.Return<CallResult, Error, UsageLog> {
  const { bound, logger } = call;
  const retries = yield* readSettingFrom<number>(
    call.settings,
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
  );
  const verdictOf = (error: Error) =>
    classifyModelFailure(error, bound.usageRoute).verdict;
  const attempt = Effect.gen(function* () {
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
  const { turn, responseTimeMs } = yield* call.gate
    .withRoutes(routePolicies(bound, verdictOf), {
      baseBackoffMs: RETRY_BACKOFF_MS,
      onWait: (delayMs) =>
        logger.debug(`Waiting ${delayMs}ms for the model recovery probe.`),
    })(attempt)
    .pipe(
      Effect.retry({
        times: retries,
        schedule: Schedule.spaced(RETRY_BACKOFF_MS),
        // Stamped with the bound route, as a turn's attempts are: an
        // exhausted plan's 429 on a shared API-key host is not a rate limit.
        while: (error) =>
          classifyModelFailure(error, bound.usageRoute).autoRetryable,
      }),
    );
  const usage = priceTurnUsage(bound, turn.usage, responseTimeMs, logger);
  yield* reportUsage(
    yield* UsageLog,
    bound,
    usage,
    call.attribution,
    call.settings,
  );
  return { turn, usage };
});
