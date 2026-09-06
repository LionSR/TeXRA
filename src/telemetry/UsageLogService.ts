import { randomUUID } from 'node:crypto';

import {
  Clock,
  Data,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Semaphore,
} from 'effect';
import ky from 'ky';

import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from '@auth/config';
import { createLog } from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import { workspaceRoots } from '@platform/workspaceRoots';
import type { UsageRoute } from '@shared/schemas';
import {
  TELEMETRY_ENABLED_DEFAULT,
  TELEMETRY_ENABLED_KEY,
} from '@shared/schemas';
import { CODING_PLAN_SUBSCRIPTIONS } from '@shared/codingPlanSubscriptions';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isEnvFlagEnabled } from '@utils/system/envFlags';

import { UsageLogResponseSchema } from './UsageLogTypes';
import type {
  UsageLogEntry,
  UsageLogBatch,
  UsageLogResponse,
} from './UsageLogTypes';

const log = createLog('UsageLogService');

const USAGE_LOG_ENDPOINT = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/log-usage`;
const MAX_QUEUE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 10000;
const DISPOSE_WARNING_TIMEOUT_MS = 5000;

export const USAGE_LOG_FLUSH_OUTCOME = {
  ACCEPTED: 'accepted',
  PENDING: 'pending',
  REJECTED: 'rejected',
} as const;

type UsageLogFlushOutcome =
  (typeof USAGE_LOG_FLUSH_OUTCOME)[keyof typeof USAGE_LOG_FLUSH_OUTCOME];

interface UsageLogConfig {
  batchSize: number;
  flushIntervalMs: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: UsageLogConfig = {
  batchSize: 10,
  flushIntervalMs: 30000,
  enabled: true,
};

/**
 * Environment variables that switch usage logging off without editing config.
 *
 * `TEXRA_NO_TELEMETRY` is ours; `DO_NOT_TRACK` is the cross-tool console
 * convention, honoured so a user who exports it once opts out of every tool
 * that respects it. Either one overrides {@link TELEMETRY_ENABLED_KEY} — an
 * environment that says "do not send" wins over a stored `true`, never the
 * reverse, so neither can be used to force logging back on.
 */
const TELEMETRY_OPT_OUT_ENV_VARS = [
  'TEXRA_NO_TELEMETRY',
  'DO_NOT_TRACK',
] as const;

function isTelemetryDisabledByEnv(): boolean {
  return TELEMETRY_OPT_OUT_ENV_VARS.some((name) => isEnvFlagEnabled(name));
}

/**
 * The ambient clock with a sleep that does not hold the event loop.
 *
 * The flush ticker sleeps forever between ticks, and the process clock's
 * sleep schedules a referenced timer, so a ticker alone would keep a
 * short-lived host (the CLI) alive until `dispose()` interrupted it. This
 * clock is what the ticker sleeps on: the same readings as the clock in
 * scope, a timer the loop does not wait for, still interrupted through the
 * clock rather than a timer handle the service holds. Only the ticker's
 * sleep sees it; a flush the ticker forks runs on the process clock, and the
 * request it sends holds the loop on its own.
 */
function unrefSleepClock(clock: Clock.Clock): Clock.Clock {
  return {
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
    currentTimeMillis: clock.currentTimeMillis,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    currentTimeNanos: clock.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const handle = setTimeout(
          () => resume(Effect.void),
          Duration.toMillis(duration),
        );
        handle.unref?.();
        return Effect.sync(() => clearTimeout(handle));
      }),
  };
}

/**
 * Routes whose records meter what the user consumed against their plan.
 *
 * Subscription routes are accounted against a database aggregate populated by
 * `log-usage`. A record on one of these routes is therefore not telemetry —
 * dropping it lets hosted calls continue against a stale total, past the cap.
 * They are sent regardless of {@link TELEMETRY_ENABLED_KEY}; the opt-out
 * governs the `api-key` (bring-your-own-key) rounds, which cost TeXRA nothing
 * and exist only as analytics.
 */
const PLAN_ACCOUNTING_ROUTES = new Set<UsageRoute>([
  'chatgpt-subscription',
  'xai-subscription',
  ...CODING_PLAN_SUBSCRIPTIONS.map((plan) => plan.usageRoute),
]);

function isPlanAccounting(entry: Pick<UsageLogEntry, 'usageRoute'>): boolean {
  return (
    entry.usageRoute != null && PLAN_ACCOUNTING_ROUTES.has(entry.usageRoute)
  );
}

/**
 * The user's usage-logging opt-out, read live rather than snapshotted at
 * {@link UsageLogServiceImpl.initialize}.
 *
 * Reading it on each queue and send is what makes turning the setting off take
 * effect immediately instead of at the next launch — and lets the flush path
 * drop optional rounds recorded before the opt-out rather than shipping one last
 * batch. `config.enabled` remains a separate, independent gate so a host (or a
 * test) can hold the service off regardless of user settings.
 *
 * `config` is the workspace's configuration the consent is read from: the
 * calling context's by default, or the one captured with a queued entry.
 */
function isTelemetryEnabledBySetting(
  config: ConfigProvider = workspaceRoots().config,
): boolean {
  // Checked before the config read so the kill switch also holds on a host that
  // has not initialized its platform yet.
  if (isTelemetryDisabledByEnv()) return false;

  const inspection = config.inspect<unknown>(TELEMETRY_ENABLED_KEY);
  const configuredValues = [
    inspection?.globalValue,
    inspection?.workspaceValue,
  ].filter((value) => value !== undefined);
  // `.texra/config.json` is hand-edited and JsonConfigProvider hands back raw
  // JSON. Validate each present scope before applying consent precedence: a
  // valid global `true` must not hide a mistyped project-local `"false"` and
  // quietly enable the thing the user likely meant to switch off.
  const malformed = configuredValues.find(
    (value) => typeof value !== 'boolean',
  );
  if (malformed !== undefined) {
    log.warn(
      `Ignoring non-boolean ${TELEMETRY_ENABLED_KEY} (got ${typeof malformed}); treating optional usage logging as disabled`,
    );
    return false;
  }
  // Either scope may opt out. In particular, a checked-in project `true` must
  // not reverse a user-wide privacy choice, while the CLI still honours a
  // project-local `false` when no global value is present.
  if (configuredValues.includes(false)) return false;
  return configuredValues.length > 0 ? true : TELEMETRY_ENABLED_DEFAULT;
}

/** Why optional usage logging is off, or `null` when it is on. */
export type UsageLoggingOptOut =
  | { readonly source: 'environment'; readonly envVar: string }
  | { readonly source: 'setting' }
  | null;

/**
 * The opt-out as a user-facing fact, for surfaces that report what TeXRA is
 * doing (`texra doctor`). Derived from the same gate the send path uses, so a
 * report of "off" cannot drift from the behaviour.
 */
export function usageLoggingOptOut(): UsageLoggingOptOut {
  const envVar = TELEMETRY_OPT_OUT_ENV_VARS.find((name) =>
    isEnvFlagEnabled(name),
  );
  if (envVar) return { source: 'environment', envVar };
  return isTelemetryEnabledBySetting() ? null : { source: 'setting' };
}

/**
 * A queued entry with the configuration of the workspace it was recorded in.
 * The flush runs on a timer or at shutdown, outside any run: re-reading
 * consent from the ambient roots there would consult the process roots (on
 * the desktop, the no-workspace session) instead of the paper that produced
 * the entry, and miss that paper's opt-out.
 */
interface QueuedUsageEntry {
  readonly entry: UsageLogEntry;
  readonly config: ConfigProvider;
}

/** A batch that failed to send, kept with its consent sources for the retry. */
interface RetryBatch {
  readonly batchId: string;
  readonly entries: readonly QueuedUsageEntry[];
}

/**
 * The batch could not be delivered or acknowledged and must be sent again:
 * the token lookup, the request, its body, its parse, or an acknowledgement
 * that does not cover the batch. `requeue` is the batch to keep for the
 * retry, or null when it failed before a batch was taken.
 */
class UsageBatchUndelivered extends Data.TaggedError('UsageBatchUndelivered')<{
  readonly reason: string;
  readonly requeue: RetryBatch | null;
}> {}

class UsageLogServiceImpl {
  private queue: QueuedUsageEntry[] = [];
  private retryBatch: RetryBatch | null = null;
  /** The ticker that schedules the periodic flush, forked by `initialize`
   *  and interrupted by `dispose`. It only schedules: each flush runs on a
   *  fiber of its own, so interrupting the ticker never touches a send. */
  private flushTimer: Fiber.Fiber<never> | null = null;
  /** One permit: a flush holds it while it drains, so batches leave in order
   *  and a second caller (or `dispose`) waits behind the one in flight. */
  private readonly flushLane = Semaphore.makeUnsafe(1);
  /** The drain in flight, if any: a `flush()` arriving while it runs joins
   *  its outcome, so a rejection the drain hit is not hidden behind the
   *  ACCEPTED an empty queue would report. */
  private inFlightDrain: Deferred.Deferred<UsageLogFlushOutcome> | null = null;
  // Copied, never aliased: `dispose()` writes `config.enabled`, so a
  // dispose-before-initialize would otherwise flip DEFAULT_CONFIG for good.
  private config: UsageLogConfig = { ...DEFAULT_CONFIG };
  private extensionVersion: string | undefined;
  private editorType: string | undefined;

  initialize(
    config?: Partial<UsageLogConfig>,
    extensionVersion?: string,
    editorType?: string,
  ): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.extensionVersion = extensionVersion;
    this.editorType = editorType;
    this.startFlushTimer();

    if (isTelemetryDisabledByEnv()) {
      log.info(
        `Optional usage logging is disabled by the environment (${TELEMETRY_OPT_OUT_ENV_VARS.join(' / ')}); only plan-accounting rounds are reported`,
      );
    }

    log.debug(
      `UsageLogService initialized (batchSize=${this.config.batchSize}, flushIntervalMs=${this.config.flushIntervalMs}, enabled=${this.config.enabled})`,
    );
  }

  log(
    entry: Omit<UsageLogEntry, 'timestamp' | 'extensionVersion' | 'editorType'>,
  ): void {
    if (!this.config.enabled) return;
    // The originating workspace: a run's session roots when called from a run.
    const { config } = workspaceRoots();
    if (!isPlanAccounting(entry) && !isTelemetryEnabledBySetting(config)) {
      return;
    }

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      log.warn('Queue full, dropping oldest entry');
      this.queue.shift();
    }

    this.queue.push({
      entry: {
        ...entry,
        timestamp: new Date().toISOString(),
        extensionVersion: this.extensionVersion,
        editorType: this.editorType,
      },
      config,
    });
    log.debug(`Queued usage entry (queue size: ${this.queue.length})`);

    if (this.queue.length >= this.config.batchSize) {
      effectRuntime().runFork(this.backgroundFlush());
    }
  }

  flush(): Promise<UsageLogFlushOutcome> {
    return effectRuntime().runPromise(this.sharedDrain());
  }

  /** One drain under the lane, its outcome shared with every caller that
   *  arrives while it is in flight. The lane still orders it behind a
   *  running dispose or an earlier drain. */
  private readonly sharedDrain = Effect.fn('UsageLogService.flush')(function* (
    this: UsageLogServiceImpl,
  ) {
    if (this.inFlightDrain) return yield* Deferred.await(this.inFlightDrain);
    const outcome = yield* Deferred.make<UsageLogFlushOutcome>();
    this.inFlightDrain = outcome;
    return yield* this.flushLane.withPermit(this.drain()).pipe(
      Effect.onExit((exit) => {
        this.inFlightDrain = null;
        return Deferred.done(outcome, exit);
      }),
    );
  });

  /** Send every batch that is due, one after another, under the lane. */
  private readonly drain = Effect.fn('UsageLogService.drain')(function* (
    this: UsageLogServiceImpl,
  ) {
    let finalOutcome: UsageLogFlushOutcome = USAGE_LOG_FLUSH_OUTCOME.ACCEPTED;

    while (this.retryBatch || this.queue.length > 0) {
      const batchOutcome = yield* this.flushQueuedBatch();
      if (batchOutcome === USAGE_LOG_FLUSH_OUTCOME.PENDING) {
        return finalOutcome === USAGE_LOG_FLUSH_OUTCOME.REJECTED
          ? finalOutcome
          : batchOutcome;
      }
      if (batchOutcome === USAGE_LOG_FLUSH_OUTCOME.REJECTED) {
        finalOutcome = batchOutcome;
      }
    }

    return finalOutcome;
  });

  /**
   * A flush nobody awaits: the periodic one and the batch-size trigger. The
   * drain cannot fail, so only a defect reaches here, and it is reported by
   * its owner instead of ending a fiber nobody observes.
   */
  private backgroundFlush(): Effect.Effect<void> {
    return this.sharedDrain().pipe(
      Effect.asVoid,
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          log.error(`Usage flush failed: ${toErrorMessage(defect)}`);
        }),
      ),
    );
  }

  /** One batch: keep it for retry (PENDING) when it cannot be delivered. */
  private flushQueuedBatch(): Effect.Effect<UsageLogFlushOutcome> {
    return this.sendNextBatch().pipe(
      Effect.catchTag('UsageBatchUndelivered', (error) =>
        Effect.sync(() => {
          const requeued = error.requeue?.entries.length ?? 0;
          if (error.requeue) this.retryBatch = error.requeue;
          const requeuedMessage =
            requeued > 0 ? `; requeued ${requeued} entries` : '';
          log.warn(
            `Failed to send usage batch${requeuedMessage}: ${error.reason}`,
          );
          return USAGE_LOG_FLUSH_OUTCOME.PENDING;
        }),
      ),
    );
  }

  private readonly sendNextBatch = Effect.fn(
    'UsageLogService.flushQueuedBatch',
  )(function* (this: UsageLogServiceImpl) {
    const token = yield* Effect.tryPromise({
      try: () => SupabaseClient.getAccessToken(),
      catch: (error) =>
        new UsageBatchUndelivered({
          reason: toErrorMessage(error),
          requeue: null,
        }),
    });
    if (!token) {
      log.debug('Skipping flush - user not authenticated');
      return USAGE_LOG_FLUSH_OUTCOME.PENDING;
    }

    let batch = this.retryBatch;
    if (batch) {
      this.retryBatch = null;
    } else {
      const entries = this.queue;
      this.queue = [];
      if (entries.length === 0) return USAGE_LOG_FLUSH_OUTCOME.PENDING;

      batch = {
        entries,
        batchId: randomUUID(),
      };
    }

    // Re-read each entry's consent here rather than on entry: the token
    // lookup above is asynchronous, so a user who opts out while it is in
    // flight would otherwise have this continuation ship the batch anyway.
    // Applied after the batch is taken so it also drops optional rounds
    // queued before the opt-out instead of leaving the timer to send them,
    // and read from the workspace each entry was recorded in, since this
    // flush runs outside any run.
    const kept = batch.entries.filter(
      ({ entry, config }) =>
        isPlanAccounting(entry) || isTelemetryEnabledBySetting(config),
    );
    const dropped = batch.entries.length - kept.length;
    if (dropped > 0) {
      log.debug(
        `Usage logging is disabled; dropped ${dropped} optional ${dropped === 1 ? 'entry' : 'entries'} without sending`,
      );
    }
    if (kept.length === 0) {
      // ACCEPTED, not PENDING: these entries are gone for good, and PENDING
      // means "kept for a later retry" to every caller that inspects it.
      return USAGE_LOG_FLUSH_OUTCOME.ACCEPTED;
    }
    batch = { ...batch, entries: kept };

    log.debug(
      `Flushing ${batch.entries.length} entries (batch: ${batch.batchId})`,
    );

    const response = yield* this.sendBatch(batch, token);
    if (!response.success) {
      this.reportPermanentRejection(
        batch,
        response.error ?? 'Usage batch was rejected',
      );
      return USAGE_LOG_FLUSH_OUTCOME.REJECTED;
    }
    log.debug(
      `Batch ${batch.batchId} sent successfully (${response.accepted} entries)`,
    );
    return USAGE_LOG_FLUSH_OUTCOME.ACCEPTED;
  });

  private reportPermanentRejection(batch: RetryBatch, reason: string): void {
    log.error(
      `Usage batch ${batch.batchId} was permanently rejected; discarded ${batch.entries.length} entries so later batches can continue`,
      {
        data: {
          batchId: batch.batchId,
          entryCount: batch.entries.length,
          reason,
        },
      },
    );
  }

  /**
   * Deliver one batch. Succeeds with the acknowledgement, or with the
   * endpoint's permanent (non-retryable) rejection for the caller to report;
   * everything else is {@link UsageBatchUndelivered} with the batch to keep.
   */
  private readonly sendBatch = Effect.fn('UsageLogService.sendBatch')(
    function* (batch: RetryBatch, token: string) {
      const undelivered = (reason: string) =>
        new UsageBatchUndelivered({ reason, requeue: batch });
      const wire: UsageLogBatch = {
        batchId: batch.batchId,
        entries: batch.entries.map(({ entry }) => entry),
      };
      // ky's `timeout` only guards until response headers arrive (it clears
      // the timer once fetch settles), so a server that stalls mid-body would
      // hang the `.json()` read indefinitely, wedging the flush lane and
      // dispose(). The body read therefore sits inside the same timed effect
      // as the request: the timeout interrupts it, and the interruption
      // reaches fetch through the signal.
      const { httpResponse, data } = yield* Effect.tryPromise({
        try: async (signal) => {
          const httpResponse = await ky.post(USAGE_LOG_ENDPOINT, {
            json: wire,
            headers: { Authorization: `Bearer ${token}` },
            timeout: false,
            signal,
            throwHttpErrors: false,
          });
          return { httpResponse, data: await httpResponse.json<unknown>() };
        },
        catch: (error) => undelivered(toErrorMessage(error)),
      }).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(REQUEST_TIMEOUT_MS),
          orElse: () =>
            Effect.fail(
              undelivered(
                `Usage endpoint did not answer within ${REQUEST_TIMEOUT_MS}ms`,
              ),
            ),
        }),
      );
      const response: UsageLogResponse = yield* Effect.try({
        try: () => UsageLogResponseSchema.parse(data),
        catch: (error) => undelivered(toErrorMessage(error)),
      });
      if (!response.success) {
        if (response.retryable === false) return response;
        return yield* undelivered(response.error ?? 'Usage batch was rejected');
      }
      if (!httpResponse.ok) {
        return yield* undelivered(
          `Usage endpoint returned HTTP ${httpResponse.status} with a success acknowledgement`,
        );
      }
      if (response.accepted !== wire.entries.length) {
        return yield* undelivered(
          `Usage batch acknowledgement accepted ${response.accepted} of ${wire.entries.length} entries`,
        );
      }
      return response;
    },
  );

  private startFlushTimer(): void {
    const runtime = effectRuntime();
    if (this.flushTimer) runtime.runFork(Fiber.interrupt(this.flushTimer));
    // The ticker lives until dispose() interrupts it, and it must not keep a
    // short-lived host (the CLI) alive on its own: an active run keeps the
    // loop running so the tick still fires, but at exit dispose() flushes and
    // interrupts it rather than the ticker pinning the process. Its sleep
    // therefore runs on `unrefSleepClock`; a host that never disposes exits
    // on an empty loop as before, with whatever the queue holds unsent.
    //
    // Detached on purpose: a flush belongs to the lane, not to the tick that
    // scheduled it. `sendNextBatch` takes the batch before the request goes
    // out, and an interrupt landing there would abort the request without
    // failing it, so nothing would requeue what was taken. Running the flush
    // on its own fiber keeps a dispose (or re-initialize) that lands mid-send
    // from reaching it: dispose waits behind the send on the lane instead.
    // The flush ends with its drain and is observed by nothing else.
    const tick = Clock.clockWith((clock) =>
      Effect.sleep(Duration.millis(this.config.flushIntervalMs)).pipe(
        Effect.provideService(Clock.Clock, unrefSleepClock(clock)),
      ),
    );
    this.flushTimer = runtime.runFork(
      Effect.forever(
        tick.pipe(Effect.andThen(Effect.forkDetach(this.backgroundFlush()))),
      ),
    );
  }

  dispose(): Promise<void> {
    return effectRuntime().runPromise(this.shutdown());
  }

  private readonly shutdown = Effect.fn('UsageLogService.dispose')(function* (
    this: UsageLogServiceImpl,
  ) {
    if (this.flushTimer) {
      yield* Fiber.interrupt(this.flushTimer);
      this.flushTimer = null;
    }
    this.config.enabled = false;

    // An in-flight flush — a caller's or the timer's — is waited for without
    // bound; past the deadline the wait is reported, not abandoned. The
    // warning is withdrawn the moment the lane is ours.
    const warning = yield* Effect.forkChild(
      Effect.sleep(Duration.millis(DISPOSE_WARNING_TIMEOUT_MS)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            log.warn('Dispose timeout waiting for in-flight flush');
          }),
        ),
      ),
    );
    yield* this.flushLane.withPermit(
      Fiber.interrupt(warning).pipe(Effect.andThen(this.drain())),
    );

    log.debug('UsageLogService disposed');
  });
}

export const UsageLogService = new UsageLogServiceImpl();
