import { randomUUID } from 'node:crypto';

import ky from 'ky';
import pTimeout from 'p-timeout';

import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from '@auth/config';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import type { UsageRoute } from '@shared/schemas';
import { CODING_PLAN_SUBSCRIPTIONS } from '@shared/codingPlanSubscriptions';
import { DEFAULT_CORE_SETTINGS } from '@shared/schemas/coreSettings';
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

/** Config key backing the usage-logging opt-out. */
export const TELEMETRY_ENABLED_KEY = 'texra.telemetry.enabled';

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
 * Routes whose records meter what the user consumed against their plan.
 *
 * The relay reads a database aggregate populated by `log-usage` to enforce the
 * monthly spend cap, and the subscription routes are accounted the same way. A
 * record on one of these routes is therefore not telemetry — dropping it lets
 * hosted calls continue against a stale total, past the cap. They are sent
 * regardless of {@link TELEMETRY_ENABLED_KEY}; the opt-out governs the
 * `api-key` (bring-your-own-key) rounds, which cost TeXRA nothing and exist
 * only as analytics.
 */
const PLAN_ACCOUNTING_ROUTES = new Set<UsageRoute>([
  'relay',
  'chatgpt-subscription',
  'xai-subscription',
  ...CODING_PLAN_SUBSCRIPTIONS.map((plan) => plan.usageRoute),
]);

function isPlanAccounting(
  entry: Pick<UsageLogEntry, 'usedRelay' | 'usageRoute'>,
): boolean {
  return (
    entry.usedRelay === true ||
    (entry.usageRoute != null && PLAN_ACCOUNTING_ROUTES.has(entry.usageRoute))
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
 */
function isTelemetryEnabledBySetting(): boolean {
  // Checked before the config read so the kill switch also holds on a host that
  // has not initialized its platform yet.
  if (isTelemetryDisabledByEnv()) return false;

  const inspection = platform().config.inspect<unknown>(TELEMETRY_ENABLED_KEY);
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
  return configuredValues.length > 0
    ? true
    : DEFAULT_CORE_SETTINGS.telemetry.enabled;
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

class UsageLogServiceImpl {
  private queue: UsageLogEntry[] = [];
  private retryBatch: UsageLogBatch | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<UsageLogFlushOutcome> | null = null;
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
    if (!isPlanAccounting(entry) && !isTelemetryEnabledBySetting()) return;

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      log.warn('Queue full, dropping oldest entry');
      this.queue.shift();
    }

    this.queue.push({
      ...entry,
      timestamp: new Date().toISOString(),
      extensionVersion: this.extensionVersion,
      editorType: this.editorType,
    });
    log.debug(`Queued usage entry (queue size: ${this.queue.length})`);

    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<UsageLogFlushOutcome> {
    let finalOutcome: UsageLogFlushOutcome = USAGE_LOG_FLUSH_OUTCOME.ACCEPTED;

    while (this.retryBatch || this.queue.length > 0 || this.activeFlush) {
      let batchOutcome: UsageLogFlushOutcome;
      if (this.activeFlush) {
        batchOutcome = await this.activeFlush;
      } else {
        this.activeFlush = this.flushQueuedBatch();
        try {
          batchOutcome = await this.activeFlush;
        } finally {
          this.activeFlush = null;
        }
      }

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
  }

  private async flushQueuedBatch(): Promise<UsageLogFlushOutcome> {
    let batch: UsageLogBatch | null = null;
    try {
      const token = await SupabaseClient.getRelayAccessToken();
      if (!token) {
        log.debug('Skipping flush - user not authenticated');
        return USAGE_LOG_FLUSH_OUTCOME.PENDING;
      }

      batch = this.retryBatch;
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

      // Re-read the setting here rather than on entry: the token lookup above is
      // an await, so a user who opts out while it is in flight would otherwise
      // have this continuation ship the batch anyway. Applied after the batch is
      // taken so it also drops optional rounds queued before the opt-out instead
      // of leaving the timer to send them.
      if (!isTelemetryEnabledBySetting()) {
        const kept = batch.entries.filter(isPlanAccounting);
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
      }

      log.debug(
        `Flushing ${batch.entries.length} entries (batch: ${batch.batchId})`,
      );

      const response = await this.sendBatch(batch, token);
      if (!response.success) {
        const message = response.error ?? 'Usage batch was rejected';
        if (response.retryable === false) {
          this.reportPermanentRejection(batch, message);
          return USAGE_LOG_FLUSH_OUTCOME.REJECTED;
        }
        throw new Error(message);
      }
      log.debug(
        `Batch ${batch.batchId} sent successfully (${response.accepted} entries)`,
      );
      return USAGE_LOG_FLUSH_OUTCOME.ACCEPTED;
    } catch (error) {
      const requeued = batch?.entries.length ?? 0;
      if (batch) this.retryBatch = batch;
      const requeuedMessage =
        requeued > 0 ? `; requeued ${requeued} entries` : '';
      log.warn(
        `Failed to send usage batch${requeuedMessage}: ${toErrorMessage(error)}`,
      );
      return USAGE_LOG_FLUSH_OUTCOME.PENDING;
    }
  }

  private reportPermanentRejection(batch: UsageLogBatch, reason: string): void {
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

  private async sendBatch(
    batch: UsageLogBatch,
    token: string,
  ): Promise<UsageLogResponse> {
    // ky's `timeout` only guards until response headers arrive (it clears the
    // timer once fetch settles), so a server that stalls mid-body would hang the
    // subsequent `.json()` read indefinitely, wedging activeFlush and dispose().
    // AbortSignal.timeout stays armed through the body read, like the previous
    // manual AbortController did.
    const httpResponse = await ky.post(USAGE_LOG_ENDPOINT, {
      json: batch,
      headers: { Authorization: `Bearer ${token}` },
      timeout: false,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      throwHttpErrors: false,
    });
    const data = await httpResponse.json<unknown>();
    const response = UsageLogResponseSchema.parse(data);
    if (!response.success) return response;
    if (!httpResponse.ok) {
      throw new Error(
        `Usage endpoint returned HTTP ${httpResponse.status} with a success acknowledgement`,
      );
    }
    if (response.accepted !== batch.entries.length) {
      throw new Error(
        `Usage batch acknowledgement accepted ${response.accepted} of ${batch.entries.length} entries`,
      );
    }
    return response;
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    // Don't let the periodic flush keep a short-lived host (the CLI) alive: an
    // active run keeps the loop running so the interval still fires, but at exit
    // dispose() flushes and clears it rather than the timer blocking shutdown.
    this.flushTimer.unref?.();
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async waitForFlushQuiescence(): Promise<void> {
    while (this.activeFlush) {
      await Promise.allSettled([this.activeFlush]);
    }
  }

  async dispose(): Promise<void> {
    this.stopFlushTimer();
    this.config.enabled = false;

    await pTimeout(this.waitForFlushQuiescence(), {
      milliseconds: DISPOSE_WARNING_TIMEOUT_MS,
      fallback: () => {
        log.warn('Dispose timeout waiting for in-flight flush');
      },
    });

    await this.flush();

    log.debug('UsageLogService disposed');
  }
}

export const UsageLogService = new UsageLogServiceImpl();
