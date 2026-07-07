/**
 * Factory for module-level singleton traces that need per-channel debug
 * output and nothing else (no transcript).
 *
 * The transcript-wired agent-run trace (`createRunTrace`) lives in
 * `@transcript` so this package stays free of any product/transcript
 * dependency and can be reused by SDK consumers that only want channel
 * logging.
 */
import type { AgentTrace, LogOptions } from '@agent/trace/AgentTrace';
import { noopTrace } from '@agent/trace/noopTrace';
import { MESSAGE_TYPES } from '@shared/schemas';

import { debug, error, info, initialize, warn } from './logUtils';
import type { LogUtilsOptions } from './logUtils';

type ChannelLogFn = (
  channel: string,
  message: string,
  options?: LogUtilsOptions,
) => void;

/**
 * Bind a functional `debug`/`info`/`warn`/`error` call to `channel`,
 * replicating the two behaviors `attachChannelSubscriber` gave the old
 * `TraceEmitter`-backed trace: writing through the same per-channel sink,
 * and suppressing `INTERNAL`-tagged lines (they exist for structured
 * subscribers — transcript, telemetry — that a plain channel trace never
 * has).
 */
function toChannelLog(channel: string, fn: ChannelLogFn) {
  return (message: string, options: LogOptions = {}): void => {
    if (options.messageType === MESSAGE_TYPES.INTERNAL) return;
    fn(channel, message, { data: options.data });
  };
}

/**
 * Produce a trace that writes log events to a per-channel output sink and
 * ignores everything else. Used by module-level singletons that exist
 * outside any agent run.
 *
 * Thin closure over the functional `@logger/logUtils` logger, not a full
 * `TraceEmitter` — every one of these call sites only ever invokes
 * debug/info/warn/error, so there is no reason to allocate a
 * Set-of-subscribers plus an ALS stage scope just to reach the same
 * `writeLine` sink the functional logger already reaches directly. The
 * non-log `AgentTrace` members (subscribe/emit/stages/streams) are inert
 * no-ops borrowed from `noopTrace`: nothing subscribes to or emits
 * structured events on a channel trace, so those members exist only to
 * satisfy the `AgentTrace` shape for callers that type a field as
 * `AgentTrace`.
 */
export function createChannelTrace(name: string): AgentTrace {
  initialize(name);

  return {
    ...noopTrace,
    debug: toChannelLog(name, debug),
    info: toChannelLog(name, info),
    warn: toChannelLog(name, warn),
    error: toChannelLog(name, error),
  };
}
