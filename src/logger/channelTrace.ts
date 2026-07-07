/**
 * Factory for module-level singleton traces that need per-channel debug
 * output and nothing else (no transcript).
 *
 * The transcript-wired agent-run trace (`createRunTrace`) lives in
 * `@transcript` so this package stays free of any product/transcript
 * dependency and can be reused by SDK consumers that only want channel
 * logging.
 *
 * A thin closure over the functional `@logger/logUtils` logger, not a
 * `TraceEmitter` — these module-level singletons only ever call
 * debug/info/warn/error, so there is no subscriber set or ALS stage scope
 * to allocate. Everything else on `AgentTrace` no-ops, borrowed from
 * `noopTrace` (leaf imports, not the `@agent/trace` barrel, which pulls in
 * `TraceEmitter` and would cycle back into this logger).
 *
 * Note: unlike the trace-subscriber path (`attachChannelSubscriber`, used
 * by the real per-run trace), this does not suppress `messageType:
 * INTERNAL` lines — `LogUtilsOptions` has no `messageType` field for it to
 * read. None of these channel-only callers set it.
 */
import { noopTrace } from '@agent/trace/noopTrace';
import type { AgentTrace } from '@agent/trace/AgentTrace';

import * as logUtils from './logUtils';

/**
 * Produce a trace that writes log events to a per-channel output sink and
 * no-ops everything else. Used by module-level singletons that exist
 * outside any agent run.
 */
export function createChannelTrace(name: string): AgentTrace {
  return {
    ...noopTrace,
    debug: (message, options) =>
      logUtils.debug(name, message, { data: options?.data }),
    info: (message, options) =>
      logUtils.info(name, message, { data: options?.data }),
    warn: (message, options) =>
      logUtils.warn(name, message, { data: options?.data }),
    error: (message, options) =>
      logUtils.error(name, message, { data: options?.data }),
  };
}
