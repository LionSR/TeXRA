/**
 * AgentTrace adapters for channel-backed logging without a transcript.
 */

// Local imports
import { createLog, type Log } from '@logger/logUtils';
import { MESSAGE_TYPES } from '@shared/schemas';

// Local file imports
import { noopTrace } from './noopTrace';
import type {
  AgentTrace,
  AgentTraceSubscriber,
  LogOptions,
} from './AgentTrace';
import type { AgentEvent } from './events';

/** One log fact, in the shape both the sugar methods and the events carry. */
interface LogFact {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly data?: unknown;
  readonly messageType?: string;
}

/** Write one fact to the channel, dropping the internal-only ones. */
function forward(log: Log, fact: LogFact): void {
  if (fact.messageType === MESSAGE_TYPES.INTERNAL) return;
  log[fact.level](fact.message, { data: fact.data });
}

/**
 * Produce a log-only trace for module-level work outside an agent run.
 * Structured events, stages, and runs remain inert through `noopTrace`.
 */
export function createChannelTrace(name: string): AgentTrace {
  const log = createLog(name);
  const bind =
    (level: LogFact['level']) =>
    (message: string, options: LogOptions = {}): void =>
      forward(log, { ...options, level, message });

  return {
    ...noopTrace,
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
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
  const log = createLog(channel);
  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    if (event.type !== 'log') return;
    forward(log, event);
  };
  return trace.subscribe(subscriber);
}
