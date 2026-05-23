/**
 * Console subscriber — writes plain `log` events to a per-channel
 * structured logger via logUtils. Replaces the direct `logger.{level}()`
 * calls that AgentLogger used to make inline so the trace channel becomes
 * the single emission point.
 *
 * Non-log events are silently ignored — they're for structured subscribers
 * (TexraTranscriptRecorder, Supabase, SDK consumers).
 */
import type {
  AgentEvent,
  AgentTrace,
  AgentTraceSubscriber,
} from '@agent/trace';
import { serializeError } from '@utils/core';


import * as logger from './logUtils';

export interface ConsoleSubscriberOptions {
  /** Channel name used for the per-channel output sink. */
  readonly channel: string;
  /** Whether to route writes to the agent-specific output channel. */
  readonly isAgent: boolean;
}

/**
 * Attach a console subscriber to a trace. Returns an unsubscribe handle.
 */
export function attachConsoleSubscriber(
  trace: AgentTrace,
  options: ConsoleSubscriberOptions,
): () => void {
  logger.initialize(options.channel, options.isAgent);

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    if (event.type !== 'log') return;
    const data =
      event.data instanceof Error ? serializeError(event.data) : event.data;
    logger[event.level](options.channel, event.message, {
      groupId: event.stageId,
      messageType: event.messageType,
      isAgent: options.isAgent,
      data,
    });
  };

  return trace.subscribe(subscriber);
}
