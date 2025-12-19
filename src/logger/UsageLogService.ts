/**
 * Usage Log Service - Sends API usage data to Supabase for analytics.
 *
 * Design principles:
 * - Non-blocking: Never delays the main execution flow
 * - Failure-tolerant: Errors are logged but never thrown to callers
 * - Batched: Collects events and flushes periodically to reduce requests
 * - Retry with backoff: Handles transient network failures gracefully
 *
 * Usage data includes:
 * - Token counts (input, output, cached, reasoning)
 * - Cost calculations
 * - Model/provider information
 * - Response times
 */
import { randomUUID } from 'crypto';

import * as logger from '@logger/logUtils';
import { SupabaseClient } from '@/auth/SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from '@/auth/config';

import { UsageLogResponseSchema } from './UsageLogTypes';
import type {
  UsageLogEntry,
  UsageLogBatch,
  UsageLogResponse,
} from './UsageLogTypes';

const CHANNEL = 'UsageLogService';
logger.initialize(CHANNEL);

/** Edge function endpoint for usage logging */
const USAGE_LOG_ENDPOINT = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/log-usage`;

/** Configuration for the usage log service */
interface UsageLogConfig {
  /** Maximum entries to batch before flushing (default: 10) */
  batchSize: number;

  /** Flush interval in milliseconds (default: 30000 = 30 seconds) */
  flushIntervalMs: number;

  /** Maximum retry attempts (default: 3) */
  maxRetries: number;

  /** Base delay for exponential backoff in ms (default: 1000) */
  baseRetryDelayMs: number;

  /** Whether logging is enabled (default: true) */
  enabled: boolean;
}

const DEFAULT_CONFIG: UsageLogConfig = {
  batchSize: 10,
  flushIntervalMs: 30000,
  maxRetries: 3,
  baseRetryDelayMs: 1000,
  enabled: true,
};

/**
 * Singleton service for logging API usage to the backend.
 *
 * Automatically batches and flushes usage entries with retry support.
 * Completely non-blocking - errors are logged but never propagate.
 */
class UsageLogServiceImpl {
  private queue: UsageLogEntry[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private config: UsageLogConfig = { ...DEFAULT_CONFIG };
  private extensionVersion: string | undefined;

  /**
   * Initialize the service with optional configuration.
   */
  initialize(
    config?: Partial<UsageLogConfig>,
    extensionVersion?: string,
  ): void {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.extensionVersion = extensionVersion;

    // Start the flush timer
    this.startFlushTimer();

    logger.debug(
      CHANNEL,
      `UsageLogService initialized (batchSize=${this.config.batchSize}, flushIntervalMs=${this.config.flushIntervalMs}, enabled=${this.config.enabled})`,
    );
  }

  /**
   * Queue a usage entry for logging.
   * Non-blocking - returns immediately.
   */
  log(entry: Omit<UsageLogEntry, 'timestamp' | 'extensionVersion'>): void {
    if (!this.config.enabled) {
      return;
    }

    const fullEntry: UsageLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      extensionVersion: this.extensionVersion,
    };

    this.queue.push(fullEntry);
    logger.debug(CHANNEL, `Queued usage entry (queue size: ${this.queue.length})`);

    // Flush immediately if batch size reached
    if (this.queue.length >= this.config.batchSize) {
      void this.flush();
    }
  }

  /**
   * Manually flush all queued entries.
   * Called automatically on batch size or interval.
   */
  async flush(): Promise<void> {
    if (this.isFlushing || this.queue.length === 0) {
      return;
    }

    // Check authentication before attempting to send
    const isAuth = await SupabaseClient.isAuthenticated();
    if (!isAuth) {
      logger.debug(CHANNEL, 'Skipping flush - user not authenticated');
      return;
    }

    this.isFlushing = true;

    // Take current queue and reset
    const entries = [...this.queue];
    this.queue = [];

    const batch: UsageLogBatch = {
      entries,
      batchId: randomUUID(),
    };

    logger.debug(CHANNEL, `Flushing ${entries.length} entries (batch: ${batch.batchId})`);

    try {
      await this.sendWithRetry(batch);
    } catch (error) {
      // Log error but don't re-throw - this is fire-and-forget
      logger.warn(
        CHANNEL,
        `Failed to send usage batch after retries: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      // Don't re-queue failed entries to avoid infinite loops
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Send batch to backend with exponential backoff retry.
   */
  private async sendWithRetry(batch: UsageLogBatch): Promise<UsageLogResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.config.maxRetries; attempt++) {
      try {
        const response = await this.sendBatch(batch);

        if (response.success) {
          logger.debug(
            CHANNEL,
            `Batch ${batch.batchId} sent successfully (${response.accepted} entries)`,
          );
          return response;
        } else {
          // Server rejected the batch - don't retry
          logger.warn(CHANNEL, `Batch rejected: ${response.error}`);
          return response;
        }
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry on auth errors
        if (lastError.message.includes('401') || lastError.message.includes('403')) {
          throw lastError;
        }

        // Exponential backoff: 1s, 2s, 4s, ...
        const delayMs = this.config.baseRetryDelayMs * Math.pow(2, attempt);
        logger.debug(
          CHANNEL,
          `Retry ${attempt + 1}/${this.config.maxRetries} in ${delayMs}ms: ${lastError.message}`,
        );

        await this.sleep(delayMs);
      }
    }

    throw lastError || new Error('Max retries exceeded');
  }

  /**
   * Send a batch to the edge function.
   */
  private async sendBatch(batch: UsageLogBatch): Promise<UsageLogResponse> {
    const token = await SupabaseClient.getAccessToken();
    if (!token) {
      throw new Error('No auth token available');
    }

    const response = await fetch(USAGE_LOG_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    const parsed = UsageLogResponseSchema.safeParse(data);

    if (!parsed.success) {
      logger.warn(CHANNEL, `Invalid response from server: ${parsed.error.message}`);
      // Return a default success response if parsing fails but HTTP was OK
      return { success: true, accepted: batch.entries.length };
    }

    return parsed.data;
  }

  /**
   * Start the periodic flush timer.
   */
  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
  }

  /**
   * Stop the periodic flush timer.
   */
  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Dispose the service - flush remaining entries and stop timer.
   */
  async dispose(): Promise<void> {
    this.stopFlushTimer();
    await this.flush();
    logger.debug(CHANNEL, 'UsageLogService disposed');
  }

  /**
   * Get current queue size (for testing/monitoring).
   */
  getQueueSize(): number {
    return this.queue.length;
  }

  /**
   * Enable or disable logging at runtime.
   */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    logger.info(CHANNEL, `Usage logging ${enabled ? 'enabled' : 'disabled'}`);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Singleton instance */
export const UsageLogService = new UsageLogServiceImpl();
