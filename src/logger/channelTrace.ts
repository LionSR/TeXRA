/**
 * Factory for module-level singleton traces that need per-channel debug
 * output and nothing else (no transcript).
 *
 * The transcript-wired agent-run trace (`createRunTrace`) lives in
 * `@transcript` so this package stays free of any product/transcript
 * dependency and can be reused by SDK consumers that only want channel
 * logging.
 */
import { TraceEmitter, type AgentTrace } from '@agent/trace';

import { attachChannelSubscriber } from './logUtils';

/**
 * Produce a trace that writes log events to a per-channel output sink and
 * ignores everything else. Used by module-level singletons that exist
 * outside any agent run.
 */
export function createChannelTrace(name: string): AgentTrace {
  const trace = new TraceEmitter();
  attachChannelSubscriber(trace, { channel: name, isAgent: false });
  return trace;
}
