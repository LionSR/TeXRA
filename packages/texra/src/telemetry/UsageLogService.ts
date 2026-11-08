import { randomUUID } from 'node:crypto';

import {
  Cause,
  DateTime,
  Duration,
  Effect,
  Fiber,
  Layer,
  Predicate,
  Queue,
  Result,
  Schedule,
  Schema,
} from 'effect';
import { HttpClient, HttpClientError, HttpClientRequest } from 'effect/http';

import {
  UsageLog,
  UsageLogEntrySchema,
  type UsageLogEntry,
} from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import { envFlag } from '@texra-ai/harness/node';
import { extractErrorMessage, toErrorMessage } from '@texra-ai/harness/schemas';
import { readOrCreateInstallId } from '@telemetry/installId';
import { TELEMETRY_ENABLED_SETTING } from '@texra/shared/settingsView/texraSettings';
import type { AppState, ConfigProvider } from '@texra-ai/harness/host';

const CHANNEL = 'UsageLogService';

const USAGE_LOG_ENDPOINT = 'https://remote.texra.ai/functions/v1/log-usage-v2';

/** One request body of the `log-usage-v2` edge function. */
interface UsageLogBatch {
  readonly entries: readonly UsageLogEntry[];
  readonly batchId: string;
}

/** The edge function's answer to a batch. */
const UsageLogResponseSchema = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    accepted: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.optional(Schema.String),
    /** The edge's stable rejection code (`BATCH_REJECTED`, `INVALID_JSON`). */
    errorCode: Schema.optional(Schema.String),
    /** Only an explicit false: the endpoint will never accept this batch. */
    retryable: Schema.optional(Schema.Boolean),
    /** The fields a rejected batch failed on, without their values. */
    issues: Schema.optional(
      Schema.Array(
        Schema.Struct({
          path: Schema.Array(Schema.String),
          message: Schema.String,
        }),
      ),
    ),
  }),
]);

type UsageLogRejection = Extract<
  typeof UsageLogResponseSchema.Type,
  { success: false }
>;

/** The endpoint's reason for refusing a batch: its code, its message and
 *  the fields it named. */
const rejectionReason = (rejection: UsageLogRejection): string => {
  const cause =
    [rejection.errorCode, rejection.error]
      .filter(Predicate.isNotUndefined)
      .join(': ') || 'no reason given';
  const issues = (rejection.issues ?? []).map(
    ({ path, message }) => `${path.join('.')}: ${message}`,
  );
  return issues.length > 0 ? `${cause} (${issues.join('; ')})` : cause;
};

const decodeEntry = Schema.decodeUnknownResult(UsageLogEntrySchema);

const MAX_QUEUE_SIZE = 1000;
/** A queue this long asks for a flush before the periodic one. */
const BATCH_SIZE = 10;
/** The periodic flush, and the first wait between retries. */
export const FLUSH_INTERVAL = Duration.seconds(30);
const REQUEST_TIMEOUT_MS = 10000;
const DISPOSE_WARNING_TIMEOUT_MS = 5000;
/** The longest wait between retries of an undelivered batch. */
const MAX_RETRY_DELAY = Duration.minutes(30);

/**
 * Environment variables that switch usage logging off without editing config.
 * `TEXRA_NO_TELEMETRY` is ours; `DO_NOT_TRACK` is the cross-tool console
 * convention, honoured so a user who exports it once opts out of every tool
 * that respects it. Either one overrides {@link TELEMETRY_ENABLED_SETTING.key} — an
 * environment that says "do not send" wins over a stored `true`, never the
 * reverse, so neither can be used to force logging back on.
 */
const TELEMETRY_OPT_OUT_ENV_VARS = [
  'TEXRA_NO_TELEMETRY',
  'DO_NOT_TRACK',
] as const;

/** The variable that opts usage logging out, in the process's environment
 *  or in the recording run's (its project's `.env` over the process's):
 *  either one opting out suffices, so a project can never turn it back on.
 *  The process's is read live from `process.env`, not through a
 *  `ConfigProvider`, so the kill switch holds before any runtime is built. */
const telemetryOptOutEnvVar = Effect.fnUntraced(function* (
  env?: Readonly<Record<string, string | undefined>>,
) {
  for (const name of TELEMETRY_OPT_OUT_ENV_VARS) {
    if (
      (yield* envFlag(name, process.env)) ||
      (env !== undefined && (yield* envFlag(name, env)))
    )
      return name;
  }
  return undefined;
});

/**
 * The user's usage-logging opt-out, read live rather than snapshotted when
 * the service starts.
 *
 * Reading it on each queue and send is what makes turning the setting off take
 * effect immediately instead of at the next launch — and lets the flush path
 * drop rounds recorded before the opt-out rather than shipping one last
 * batch.
 *
 * `config` is the workspace's configuration the consent is read from: the
 * recording run's session roots, or the one captured with a queued entry.
 */
const isTelemetryEnabledBySetting = Effect.fnUntraced(function* (
  config: ConfigProvider,
  env?: Readonly<Record<string, string | undefined>>,
): Effect.fn.Return<boolean> {
  // Checked before the config read so the kill switch also holds on a host
  // that has not initialized its platform yet. `env` is the recording
  // run's, so a project's `.env` opt-out holds for its runs.
  if (yield* telemetryOptOutEnvVar(env)) return false;

  // Which scope answers is the config store's rule (`projectValueIgnored`):
  // a project file may opt out but never opt in. The config files are
  // hand-edited raw JSON, so a mistyped `"false"` must not read as consent.
  const value = config.get<unknown>(TELEMETRY_ENABLED_SETTING.key);
  if (typeof value === 'boolean') return value;
  return yield* Effect.logWarning(
    `Ignoring non-boolean ${TELEMETRY_ENABLED_SETTING.key} (got ${typeof value}); treating usage logging as disabled`,
  ).pipe(withLogChannel(CHANNEL), Effect.as(false));
});

/** Why usage logging is off, or `null` when it is on. */
export type UsageLoggingOptOut =
  | { readonly source: 'environment'; readonly envVar: string }
  | { readonly source: 'setting' }
  | null;

/**
 * The opt-out as a user-facing fact, for surfaces that report what TeXRA is
 * doing (`texra doctor`). Derived from the same gate the send path uses, so a
 * report of "off" cannot drift from the behaviour.
 */
export const usageLoggingOptOut = Effect.fnUntraced(function* (
  config: ConfigProvider,
): Effect.fn.Return<UsageLoggingOptOut> {
  const envVar = yield* telemetryOptOutEnvVar();
  if (envVar) return { source: 'environment', envVar };
  const enabled = yield* isTelemetryEnabledBySetting(config);
  return enabled ? null : { source: 'setting' };
});

/**
 * A queued entry with the configuration of the workspace it was recorded in.
 * The flush runs on a timer or at shutdown, outside any run: re-reading
 * consent from the ambient roots there would consult the process roots (on
 * the desktop, the no-workspace session) instead of the project that produced
 * the entry, and miss that project's opt-out.
 */
interface QueuedUsageEntry {
  readonly entry: UsageLogEntry;
  readonly config: ConfigProvider;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** A batch that failed to send, kept with its consent sources for the retry. */
interface RetryBatch {
  readonly batchId: string;
  readonly entries: readonly QueuedUsageEntry[];
}

/**
 * The batch could not be delivered or acknowledged and must be sent again:
 * the install-ID read, the request, its body, its parse, a refusal the
 * endpoint does not call permanent (a 5xx, a 401), or an acknowledgement
 * that does not cover the batch. The sender keeps the batch for the retry
 * (`retryBatch`) before failing with this.
 */
class UsageBatchUndelivered extends Schema.TaggedError<UsageBatchUndelivered>()(
  'UsageBatchUndelivered',
  { reason: Schema.String },
) {}

/**
 * Deliver one batch. Succeeds with the acknowledgement, or with the
 * endpoint's permanent rejection (`retryable: false`) for the caller to
 * drop; everything else is {@link UsageBatchUndelivered} with the batch to
 * keep.
 */
const sendBatch = Effect.fn('UsageLogService.sendBatch')(function* (
  batch: RetryBatch,
  installId: string,
) {
  const undelivered = (reason: string) => new UsageBatchUndelivered({ reason });
  const wire: UsageLogBatch = {
    batchId: batch.batchId,
    entries: batch.entries.map(({ entry }) => entry),
  };
  const client = yield* HttpClient.HttpClient;
  // One request is one fiber. The body read sits inside the same timed
  // effect as the request, because a server that answers headers and then
  // stalls mid-body would otherwise hang the read indefinitely, wedging
  // the sender and dispose(). The timeout interrupts the effect, and
  // `HttpClient.withScope` turns that interruption into an abort on the
  // underlying fetch.
  // A non-2xx status is not a failure here: the endpoint answers a
  // rejection with a body the acknowledgement checks below read.
  const { status, data } = yield* Effect.gen(function* () {
    // The random install ID rides a header, lowercase UUIDv4, with no
    // Authorization: the endpoint keys anonymous usage on it.
    const request = yield* HttpClientRequest.post(USAGE_LOG_ENDPOINT, {
      headers: { 'X-TeXRA-Install-Id': installId },
    }).pipe(HttpClientRequest.bodyJson(wire));
    const response = yield* HttpClient.withScope(client).execute(request);
    const data = yield* response.json;
    return { status: response.status, data };
  }).pipe(
    Effect.scoped,
    Effect.mapError((error) => {
      if (!HttpClientError.isHttpClientError(error)) {
        // `bodyJson` fails with `HttpBodyError`, which carries `reason`
        // and `cause` but no message, so `toErrorMessage` renders it as
        // the empty string — an undelivered billing batch with a blank
        // reason. Fall back to the tag so this can never be silent.
        return undelivered(extractErrorMessage(error) ?? String(error));
      }
      // The wrapper's message names the request that failed; only its
      // cause names the transport failure (a refused connection, a reset
      // socket). A billing warning is worth both.
      const { cause } = error.reason;
      return undelivered(
        cause === undefined
          ? error.message
          : `${error.message}: ${toErrorMessage(cause)}`,
      );
    }),
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
  const response = yield* Schema.decodeUnknownEffect(UsageLogResponseSchema)(
    data,
  ).pipe(Effect.mapError((error) => undelivered(error.message)));
  if (!response.success) {
    if (response.retryable === false) return response;
    return yield* undelivered(
      `Usage endpoint refused the batch: ${rejectionReason(response)}`,
    );
  }
  if (status < 200 || status >= 300) {
    return yield* undelivered(
      `Usage endpoint returned HTTP ${status} with a success acknowledgement`,
    );
  }
  if (response.accepted !== wire.entries.length) {
    return yield* undelivered(
      `Usage batch acknowledgement accepted ${response.accepted} of ${wire.entries.length} entries`,
    );
  }
  return response;
});

/** What a host stamps on its entries, and its own telemetry switch. */
export interface UsageLogOptions {
  /** This host's version, reported with every entry. */
  readonly version: string | undefined;
  /** The editor this process runs in: the CLI, the desktop app, or the
   *  editor's own name on the extension host. */
  readonly editorType: string | undefined;
  /** The host's own telemetry switch, read live on each queue and send: the
   *  extension passes `vscode.env.isTelemetryEnabled`. */
  readonly hostTelemetryEnabled?: () => boolean;
}

/**
 * Allocate and drain one queue for this layer's lifetime.
 *
 * One sender fiber sends the queued entries when a trigger asks (the
 * batch-size trigger and the periodic one), in order, one batch at a time;
 * an undelivered batch is retried on an exponential backoff from the flush
 * interval, capped at {@link MAX_RETRY_DELAY}. The layer's close stops
 * accepting entries, stops the sender (cutting a backoff short, never a
 * send), then tries each batch still waiting once.
 */
export const usageLogLayer = (
  options: UsageLogOptions,
): Layer.Layer<UsageLog, never, HttpClient.HttpClient | AppState> =>
  Layer.effect(
    UsageLog,
    Effect.gen(function* () {
      const { version, editorType } = options;
      const hostTelemetryEnabled = options.hostTelemetryEnabled ?? (() => true);
      /** Entries waiting for the next batch; past capacity the oldest goes.
       *  The close ends it: no entry is accepted after, and those queued
       *  remain for the final drain. */
      const queue = yield* Queue.sliding<QueuedUsageEntry, Cause.Done>(
        MAX_QUEUE_SIZE,
      );
      /** A flush asked for; asking again while one waits is the same ask. */
      const triggers = yield* Queue.dropping<void>(1);
      let retryBatch: RetryBatch | null = null;
      let warnedUndelivered = false;

      /** The host's own switch (VS Code's telemetry setting) and the user's opt-outs, read live. */
      const allowed = (
        config: ConfigProvider,
        env?: Readonly<Record<string, string | undefined>>,
      ): Effect.Effect<boolean> =>
        hostTelemetryEnabled()
          ? isTelemetryEnabledBySetting(config, env)
          : Effect.succeed(false);

      /** Ask the sender for a flush, synchronously; the sender does the I/O. */
      const requestFlush = (): void => {
        Queue.offerUnsafe(triggers, undefined);
      };

      /** Finish the next batch: sent, dropped, or failed with it kept. */
      const sendNextBatch = Effect.fn('UsageLogService.sendNextBatch')(
        function* () {
          let batch = retryBatch;
          if (batch) {
            retryBatch = null;
          } else {
            const entries = yield* Queue.clear(queue);
            if (entries.length === 0) return;

            batch = {
              entries,
              batchId: randomUUID(),
            };
          }

          // Re-read each entry's consent here rather than on entry, so a user who
          // opts out after queueing never has the batch shipped. Applied after
          // the batch is taken so it also drops rounds
          // queued before the opt-out instead of leaving the timer to send them,
          // and read from the workspace each entry was recorded in, since this
          // flush runs outside any run.
          const kept = yield* Effect.filter(batch.entries, ({ config, env }) =>
            allowed(config, env),
          );
          const dropped = batch.entries.length - kept.length;
          if (dropped > 0) {
            yield* Effect.logDebug(
              `Usage logging is disabled; dropped ${dropped} ${dropped === 1 ? 'entry' : 'entries'} without sending`,
            ).pipe(withLogChannel(CHANNEL));
          }
          if (kept.length === 0) return;
          batch = { ...batch, entries: kept };

          yield* Effect.logDebug(
            `Flushing ${batch.entries.length} entries (batch: ${batch.batchId})`,
          ).pipe(withLogChannel(CHANNEL));

          // From here on a failure keeps the batch for the retry.
          const pending = batch;
          const keepForRetry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.tapError(effect, () =>
              Effect.sync(() => {
                retryBatch = pending;
              }),
            );
          // The install ID is created only here, after every opt-out has passed.
          const installId = yield* readOrCreateInstallId().pipe(
            Effect.mapError(
              (error) =>
                new UsageBatchUndelivered({
                  reason: `install ID unavailable: ${toErrorMessage(error)}`,
                }),
            ),
            keepForRetry,
          );
          const response = yield* sendBatch(batch, installId).pipe(
            keepForRetry,
          );
          // The endpoint answered: a run of delivery failures is over.
          warnedUndelivered = false;
          if (!response.success) {
            // Every entry passed the endpoint's schema before it was
            // queued, so a permanent rejection means the deployed endpoint
            // and this build disagree. A retry cannot change that and would
            // hold back every entry behind it, so the batch is dropped.
            yield* Effect.logWarning(
              `Usage endpoint rejected batch ${batch.batchId} for good (${rejectionReason(response)}); dropped ${batch.entries.length} entries`,
            ).pipe(
              Effect.annotateLogs({
                data: {
                  batchId: batch.batchId,
                  entryCount: batch.entries.length,
                  errorCode: response.errorCode,
                  error: response.error,
                },
              }),
              withLogChannel(CHANNEL),
            );
            return;
          }
          yield* Effect.logDebug(
            `Batch ${batch.batchId} sent successfully (${response.accepted} entries)`,
          ).pipe(withLogChannel(CHANNEL));
        },
      );

      /** Send every batch that is due, one after another. An undelivered
       *  batch is kept for the retry and stops the drain. */
      const drain = Effect.fn('UsageLogService.drain')(function* () {
        while (retryBatch !== null || (yield* Queue.size(queue)) > 0) {
          // A batch taken from the queue is sent, discarded or kept before
          // the close can stop the sender: the request's own timeout still
          // ends a stalled send.
          yield* sendNextBatch().pipe(
            Effect.uninterruptible,
            Effect.tapError((error) =>
              Effect.suspend(() => {
                const requeued = retryBatch?.entries.length ?? 0;
                const requeuedMessage =
                  requeued > 0 ? `; requeued ${requeued} entries` : '';
                // Say so at warn when failures start, then at debug until
                // the endpoint answers again.
                const log = warnedUndelivered
                  ? Effect.logDebug
                  : Effect.logWarning;
                warnedUndelivered = true;
                return log(
                  `Failed to send usage batch${requeuedMessage}: ${error.reason}`,
                ).pipe(withLogChannel(CHANNEL));
              }),
            ),
          );
        }
      });

      const backoff = Schedule.exponential(FLUSH_INTERVAL).pipe(
        Schedule.modifyDelay(({ duration }) =>
          Effect.succeed(Duration.min(duration, MAX_RETRY_DELAY)),
        ),
      );

      /**
       * A flush nobody awaits: the periodic one and the batch-size trigger. An
       * undelivered batch is retried on the backoff. The schedule never ends,
       * so only a defect reaches the end, and it is reported by its owner
       * instead of ending a fiber nobody observes.
       */
      const backgroundFlush = Effect.fn('UsageLogService.backgroundFlush')(
        function* () {
          yield* drain().pipe(Effect.retry(backoff), Effect.orDie);
        },
        Effect.catchDefect((defect) =>
          Effect.logError(`Usage flush failed: ${toErrorMessage(defect)}`).pipe(
            withLogChannel(CHANNEL),
          ),
        ),
      );

      /** Queue one entry; `config` is the configuration of the workspace that
       *  recorded it (the run's session roots), read for consent now and again
       *  at flush. */
      const log = Effect.fn('UsageLogService.log')(function* (
        entry: Omit<
          UsageLogEntry,
          'timestamp' | 'extensionVersion' | 'editorType'
        >,
        config: ConfigProvider,
        env?: Readonly<Record<string, string | undefined>>,
      ) {
        if (!(yield* allowed(config, env))) return;

        // An entry the endpoint would reject would take its whole batch with
        // it: it is dropped here instead, naming the fields.
        const checked = decodeEntry(
          {
            ...entry,
            timestamp: DateTime.formatIso(yield* DateTime.now),
            extensionVersion: version,
            editorType,
          },
          { errors: 'all' },
        );
        if (Result.isFailure(checked)) {
          yield* Effect.logWarning(
            `Dropped a usage entry the endpoint would reject: ${checked.failure.message}`,
          );
          return;
        }

        const full = yield* Queue.isFull(queue);
        const queued = yield* Queue.offer(queue, {
          entry: checked.success,
          config,
          ...(env !== undefined && { env }),
        });
        // Refused only once the close has ended the queue.
        if (!queued) return;
        if (full) yield* Effect.logWarning('Queue full, dropping oldest entry');
        const size = yield* Queue.size(queue);
        yield* Effect.logDebug(`Queued usage entry (queue size: ${size})`);

        if (size >= BATCH_SIZE) requestFlush();
      }, withLogChannel(CHANNEL));

      /**
       * Stop accepting entries, stop the sender, then send what is already
       * queued, each batch once.
       */
      const drainAndStop = Effect.fn('UsageLogService.drainAndStop')(function* (
        sender: Fiber.Fiber<never>,
      ) {
        yield* Queue.end(queue);

        // The sender stops at once unless a send is in flight, which it
        // finishes: waited for without bound, but past the deadline the
        // wait is reported, not abandoned. The warning is withdrawn the
        // moment the sender has stopped.
        const warning = yield* Effect.forkChild(
          Effect.sleep(Duration.millis(DISPOSE_WARNING_TIMEOUT_MS)).pipe(
            Effect.andThen(
              Effect.logWarning(
                'Dispose timeout waiting for in-flight flush',
              ).pipe(withLogChannel(CHANNEL)),
            ),
          ),
        );
        yield* Fiber.interrupt(sender);
        yield* Fiber.interrupt(warning);
        yield* drain().pipe(
          // Already logged by the drain; nothing is left to retry it.
          Effect.catchTag('UsageBatchUndelivered', () => Effect.void),
        );

        yield* Effect.logDebug('UsageLogService drained').pipe(
          withLogChannel(CHANNEL),
        );
      });

      const sender = yield* Effect.forkScoped(
        Effect.forever(
          Queue.take(triggers).pipe(Effect.andThen(backgroundFlush())),
        ),
      );
      // `Effect.schedule` waits one interval before the first request. The
      // close leaves this ticker to the scope: a request it makes then has
      // no sender.
      yield* Effect.forkScoped(
        Effect.sync(requestFlush).pipe(
          Effect.schedule(Schedule.spaced(FLUSH_INTERVAL)),
        ),
        { startImmediately: true },
      );
      // It carries this build's context, which is where its HTTP client and
      // app state come from.
      yield* Effect.addFinalizer(() => drainAndStop(sender));

      if (yield* telemetryOptOutEnvVar()) {
        yield* Effect.logInfo(
          `Usage logging is disabled by the environment (${TELEMETRY_OPT_OUT_ENV_VARS.join(' / ')})`,
        ).pipe(withLogChannel(CHANNEL));
      }

      yield* Effect.logDebug('UsageLogService started').pipe(
        withLogChannel(CHANNEL),
      );
      return { log };
    }).pipe(Effect.withSpan('UsageLogService.start')),
  );
