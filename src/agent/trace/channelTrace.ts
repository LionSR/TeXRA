/**
 * AgentTrace adapters for channel-backed logging without a transcript.
 */

// Local imports
import {
  createChannelWriter,
  disposeAgentChannel,
  type ChannelWriter,
} from '@logger/logUtils';
import { MESSAGE_TYPES, type LogLevel } from '@shared/schemas';

// Local file imports
import { noopTrace } from './noopTrace';
import type {
  AgentTrace,
  AgentTraceSubscriber,
  LogOptions,
} from './AgentTrace';
import type { AgentEvent } from './events';

/** Bind a functional logger call to one channel. */
function toChannelLog(
  writer: ChannelWriter,
  level: LogLevel,
): (message: string, options?: LogOptions) => void {
  return (message: string, options: LogOptions = {}): void => {
    if (options.messageType === MESSAGE_TYPES.INTERNAL) return;
    writer(level, message, options.data);
  };
}

/**
 * Produce a log-only trace for module-level work outside an agent run.
 * Structured events, stages, and streams remain inert through `noopTrace`.
 */
export function createChannelTrace(name: string): AgentTrace {
  const writer = createChannelWriter(name, false);

  return {
    ...noopTrace,
    debug: toChannelLog(writer, 'debug'),
    info: toChannelLog(writer, 'info'),
    warn: toChannelLog(writer, 'warn'),
    error: toChannelLog(writer, 'error'),
  };
}

interface ChannelSubscriberOptions {
  /** Channel name used for the per-channel output sink. */
  readonly channel: string;
  /** Whether to route writes to the agent-specific output channel. */
  readonly isAgent: boolean;
}

/** Route a trace's public log events to a channel sink. */
export function attachChannelSubscriber(
  trace: AgentTrace,
  options: ChannelSubscriberOptions,
): () => void {
  const writer = createChannelWriter(options.channel, options.isAgent);

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    if (event.type !== 'log') return;
    if (event.messageType === MESSAGE_TYPES.INTERNAL) return;

    writer(event.level, event.message, event.data);
  };

  const unsubscribe = trace.subscribe(subscriber);
  // Run-once: a second invocation after a same-name re-attach (resumed runs
  // reuse their stream ID) must not dispose the new owner's channel.
  let released = false;
  return () => {
    unsubscribe();
    if (released) return;
    released = true;
    // A per-run agent channel dies with its run; without this every run leaks
    // a live host output channel. Shared channels outlive the subscriber.
    if (options.isAgent) disposeAgentChannel(options.channel);
  };
}
