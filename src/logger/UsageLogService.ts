/**
 * Usage Log Service - Sends API usage data to Supabase for analytics.
 *
 * Design principles:
 * - Non-blocking: Never delays the main execution flow
 * - Failure-tolerant: Errors are logged but never thrown to callers
 * - Batched: Collects events and flushes periodically to reduce requests
 * - Fire-and-forget: If it fails, it fails - no retries
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

  /** Whether logging is enabled (default: true) */
  enabled: boolean;
}

const DEFAULT_CONFIG: UsageLogConfig = {
  batchSize: 10,
  flushIntervalMs: 30000,
  enabled: true,
};

/** Maximum queue size to prevent memory leaks if flush fails repeatedly */
const MAX_QUEUE_SIZE = 1000;

/** Request timeout in milliseconds */
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Singleton service for logging API usage to the backend.
 *
 * Automatically batches and flushes usage entries.
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

    // Prevent memory leaks if flush fails repeatedly
    if (this.queue.length >= MAX_QUEUE_SIZE) {
      logger.warn(CHANNEL, 'Queue full, dropping oldest entry');
      this.queue.shift();
    }

    const fullEntry: UsageLogEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
      extensionVersion: this.extensionVersion,
    };

    this.queue.push(fullEntry);
    logger.debug(
      CHANNEL,
      `Queued usage entry (queue size: ${this.queue.length})`,
    );

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

    // Set flushing flag BEFORE any async operations to prevent concurrent flushes
    this.isFlushing = true;

    try {
      // Get auth token
      const token = await SupabaseClient.getAccessToken();
      if (!token) {
        logger.debug(CHANNEL, 'Skipping flush - user not authenticated');
        return;
      }

      // Take current queue and reset atomically
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
      // Log error but don't re-throw - this is fire-and-forget
      logger.warn(
        CHANNEL,
        `Failed to send usage batch: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      // Don't re-queue failed entries to avoid infinite loops
    } finally {
      this.isFlushing = false;
    }
  }

  /**
   * Send a batch to the edge function with timeout.
   */
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
      // Parse with fallback - if response is invalid, assume success since HTTP was OK
      return UsageLogResponseSchema.catch({
        success: true,
        accepted: batch.entries.length,
      }).parse(data);
    } finally {
      clearTimeout(timeoutId);
    }
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
   * Waits for any in-flight flush to complete (with timeout) before flushing remaining entries.
   */
  async dispose(): Promise<void> {
    this.stopFlushTimer();
    this.config.enabled = false; // Prevent new entries during disposal

    // Wait for any in-flight flush to complete (max 5 seconds)
    const maxWaitMs = 5000;
    const startTime = Date.now();
    while (this.isFlushing && Date.now() - startTime < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (this.isFlushing) {
      logger.warn(CHANNEL, 'Dispose timeout waiting for in-flight flush');
    }

    // Flush remaining entries (flush() doesn't check enabled flag)
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
}

/** Singleton instance */
export const UsageLogService = new UsageLogServiceImpl();
