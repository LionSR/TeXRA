/**
 * Session-scoped coordinator for manual retry handling.
 */

import type { AgentTrace } from '@agent/trace';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProviderErrorPartial } from '@shared/schemas';

export type RetryResult =
  | { action: 'retry'; feedback?: string }
  | { action: 'cancel' }
  | { action: 'timeout' };

export interface RetryRequestOptions {
  /** Name of the operation that failed (e.g. "Model invocation"). */
  operation: string;
  /** Error message to display to the user. */
  errorMessage?: string;
  /** Model name for context. */
  model?: string;
  /** Logger for debug messages. */
  logger: AgentTrace;
  /** Timeout in milliseconds (default: wait indefinitely). */
  timeoutMs?: number;
  /** Structured error details for expandable display. */
  errorDetails?: ProviderErrorPartial;
}

type RuntimeHostProvider = () => AgentRuntimeHost;
type CoordinatorRuntimeHost = AgentRuntimeHost | RuntimeHostProvider;

function toRuntimeHostProvider(
  runtimeHost: CoordinatorRuntimeHost,
): RuntimeHostProvider {
  return typeof runtimeHost === 'function' ? runtimeHost : () => runtimeHost;
}

export class RetryRequestCoordinatorImpl {
  private readonly getRuntimeHost: RuntimeHostProvider;

  /** Per-stream logger captured during waitForRetry, consulted by trigger/cancel. */
  private readonly loggers = new Map<string, AgentTrace>();

  constructor(runtimeHost: CoordinatorRuntimeHost) {
    this.getRuntimeHost = toRuntimeHostProvider(runtimeHost);
  }

  private get runtimeHost(): AgentRuntimeHost {
    return this.getRuntimeHost();
  }

  waitForRetry(
    streamId: string,
    options: RetryRequestOptions,
  ): Promise<RetryResult> {
    const { logger, operation, errorMessage, model, timeoutMs, errorDetails } =
      options;
    this.loggers.set(streamId, logger);
    logger.debug('Waiting for manual retry', {
      data: errorMessage ?? 'unknown error',
    });

    const interaction = this.runtimeHost.interactions?.requestRetry?.(
      { streamId, operation, model, errorMessage, errorDetails },
      { timeoutMs },
    );
    if (!interaction) {
      this.loggers.delete(streamId);
      throw new Error('HostInteractions.requestRetry is required');
    }

    return interaction.finally(() => this.loggers.delete(streamId));
  }

  /** Resolve with 'retry'. Returns true if a pending request was resolved. */
  triggerRetry(streamId: string, feedback?: string): boolean {
    this.loggers.get(streamId)?.debug('Retry requested');
    this.loggers.delete(streamId);
    return (
      this.runtimeHost.interactions?.resolve(streamId, {
        kind: 'retry',
        action: 'retry',
        feedback,
      }) ?? false
    );
  }

  /** Resolve with 'cancel'. Returns true if a pending request was resolved. */
  cancelRetry(streamId: string): boolean {
    this.loggers.get(streamId)?.debug('Retry cancelled');
    this.loggers.delete(streamId);
    return (
      this.runtimeHost.interactions?.resolve(streamId, {
        kind: 'retry',
        action: 'cancel',
      }) ?? false
    );
  }

  clearRequest(streamId: string): void {
    this.loggers.delete(streamId);
    this.runtimeHost.interactions?.cancelForStream(
      streamId,
      'Retry request cleared.',
    );
  }

  clearAll(): void {
    for (const streamId of this.loggers.keys()) {
      this.runtimeHost.interactions?.cancelForStream(
        streamId,
        'Retry request cleared.',
      );
    }
    this.loggers.clear();
  }
}
