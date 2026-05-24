import { randomUUID } from 'crypto';

import { SupabaseClient } from '@auth/SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from '@auth/config';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';

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
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
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

  async flush(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) return;

    this.isFlushing = true;
    try {
      const token = await SupabaseClient.getAccessToken();
      if (!token) {
        logger.debug(CHANNEL, 'Skipping flush - user not authenticated');
        return;
      }

      const entries = this.queue;
      this.queue = [];

      const batch: UsageLogBatch = {
        entries,
        batchId: randomUUID(),
      };

      logger.debug(
        CHANNEL,
        `Flushing ${entries.length} entries (batch: ${batch.batchId})`,
      );

      const response = await this.sendBatch(batch, token);
      if (response.success) {
        logger.debug(
          CHANNEL,
          `Batch ${batch.batchId} sent successfully (${response.accepted} entries)`,
        );
      } else {
        logger.warn(CHANNEL, `Batch rejected: ${response.error}`);
      }
    } catch (error) {
      logger.warn(
        CHANNEL,
        `Failed to send usage batch: ${toErrorMessage(error)}`,
      );
    } finally {
      this.isFlushing = false;
    }
  }

  private async sendBatch(
    batch: UsageLogBatch,
    token: string,
  ): Promise<UsageLogResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(USAGE_LOG_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(batch),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      return UsageLogResponseSchema.catch({
        success: true,
        accepted: batch.entries.length,
      }).parse(data);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
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
    while (this.isFlushing && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.isFlushing) {
      logger.warn(CHANNEL, 'Dispose timeout waiting for in-flight flush');
    }

    await this.flush();

    logger.debug(CHANNEL, 'UsageLogService disposed');
  }
}

export const UsageLogService = new UsageLogServiceImpl();
