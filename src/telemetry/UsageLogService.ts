import { randomUUID } from 'node:crypto';

import ky from 'ky';

import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from '@auth/config';
import * as logger from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { delay } from '@utils/core';

import { UsageLogResponseSchema } from './UsageLogTypes';
import type {
  UsageLogEntry,
  UsageLogBatch,
  UsageLogResponse,
} from './UsageLogTypes';

const CHANNEL = 'UsageLogService';
logger.initialize(CHANNEL);

const USAGE_LOG_ENDPOINT = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/log-usage`;
const MAX_QUEUE_SIZE = 1000;
const REQUEST_TIMEOUT_MS = 10000;

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

class UsageLogServiceImpl {
  private queue: UsageLogEntry[] = [];
  private retryBatch: UsageLogBatch | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private activeFlush: Promise<boolean> | null = null;
  private config: UsageLogConfig = DEFAULT_CONFIG;
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

    logger.debug(
      CHANNEL,
      `UsageLogService initialized (batchSize=${this.config.batchSize}, flushIntervalMs=${this.config.flushIntervalMs}, enabled=${this.config.enabled})`,
    );
  }

  log(
    entry: Omit<UsageLogEntry, 'timestamp' | 'extensionVersion' | 'editorType'>,
  ): void {
    if (!this.config.enabled) return;

    if (this.queue.length >= MAX_QUEUE_SIZE) {
      logger.warn(CHANNEL, 'Queue full, dropping oldest entry');
      this.queue.shift();
    }

    this.queue.push({
      ...entry,
      timestamp: new Date().toISOString(),
      extensionVersion: this.extensionVersion,
      editorType: this.editorType,
    });
    logger.debug(
      CHANNEL,
      `Queued usage entry (queue size: ${this.queue.length})`,
    );

    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  async flush(): Promise<boolean> {
    while (this.retryBatch || this.queue.length > 0 || this.activeFlush) {
      if (this.activeFlush) {
        const madeProgress = await this.activeFlush;
        if (!madeProgress) return false;
        continue;
      }

      this.activeFlush = this.flushQueuedBatch();
      try {
        const madeProgress = await this.activeFlush;
        if (!madeProgress) return false;
      } finally {
        this.activeFlush = null;
      }
    }

    return true;
  }

  private async flushQueuedBatch(): Promise<boolean> {
    let batch: UsageLogBatch | null = null;
    try {
      const token = await SupabaseClient.getRelayAccessToken();
      if (!token) {
        logger.debug(CHANNEL, 'Skipping flush - user not authenticated');
        return false;
      }

      batch = this.retryBatch;
      if (batch) {
        this.retryBatch = null;
      } else {
        const entries = this.queue;
        this.queue = [];
        if (entries.length === 0) return false;

        batch = {
          entries,
          batchId: randomUUID(),
        };
      }

      logger.debug(
        CHANNEL,
        `Flushing ${batch.entries.length} entries (batch: ${batch.batchId})`,
      );

      const response = await this.sendBatch(batch, token);
      if (response.success) {
        logger.debug(
          CHANNEL,
          `Batch ${batch.batchId} sent successfully (${response.accepted} entries)`,
        );
      } else {
        logger.warn(
          CHANNEL,
          `Batch rejected; dropped ${batch.entries.length} queued entries: ${response.error}`,
        );
      }
      return true;
    } catch (error) {
      const requeued = batch?.entries.length ?? 0;
      if (batch) this.retryBatch = batch;
      const requeuedMessage =
        requeued > 0 ? `; requeued ${requeued} entries` : '';
      logger.warn(
        CHANNEL,
        `Failed to send usage batch${requeuedMessage}: ${toErrorMessage(error)}`,
      );
      return false;
    }
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
    const data = await ky
      .post(USAGE_LOG_ENDPOINT, {
        json: batch,
        headers: { Authorization: `Bearer ${token}` },
        timeout: false,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      .json<unknown>();
    return UsageLogResponseSchema.catch({
      success: true,
      accepted: batch.entries.length,
    }).parse(data);
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

  async dispose(): Promise<void> {
    this.stopFlushTimer();
    this.config.enabled = false;

    const deadline = Date.now() + 5000;
    while (this.activeFlush && Date.now() < deadline) {
      await delay(50);
    }

    if (this.activeFlush) {
      logger.warn(CHANNEL, 'Dispose timeout waiting for in-flight flush');
    }

    await this.flush();

    logger.debug(CHANNEL, 'UsageLogService disposed');
  }
}

export const UsageLogService = new UsageLogServiceImpl();
