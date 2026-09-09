/**
 * AgentTrace adapters for channel-backed logging without a transcript.
 */

// Local imports
import { createChannelWriter, type ChannelWriter } from '@logger/logUtils';
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
  const writer = createChannelWriter(name);

  return {
    ...noopTrace,
    debug: toChannelLog(writer, 'debug'),
    info: toChannelLog(writer, 'info'),
    warn: toChannelLog(writer, 'warn'),
    error: toChannelLog(writer, 'error'),
  };
}

/**
 * Route a trace's public log events to one diagnostic channel.
 *
 * A run's trace does not use this: its log events already reach the durable
 * transcript through `runEventDraft`, which every host renders, so a second
 * per-run output channel would be the same facts in a worse place. This
 * remains for a trace with no session behind it — a model handler's default
 * emitter before a run swaps in the real trace.
 */
export function attachChannelSubscriber(
  trace: AgentTrace,
  channel: string,
): () => void {
  const writer = createChannelWriter(channel);

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    if (event.type !== 'log') return;
    if (event.messageType === MESSAGE_TYPES.INTERNAL) return;

    writer(event.level, event.message, event.data);
  };

  return trace.subscribe(subscriber);
}
