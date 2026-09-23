/**
 * Channel-keyed logging primitives for subsystems that are still synchronous
 * or Promise-based and so cannot reach `Effect.log*`.
 *
 * Functional callers use `debug/info/warn/error(channel, message, options)`.
 *
 * Both this module and the Effect logger layer write the same structured entry
 * to the one host sink in `@logger/logSink`; hosts install that sink and own
 * all rendering. This module carries no destination state of its own and is
 * deleted with the last caller that cannot yield an Effect.
 */
// Local imports
import * as loggerSelf from '@logger/logUtils';
import {
  LOG_CHANNEL,
  LOG_DATA,
  writeLogEntry,
  type LogEntry,
} from '@logger/logSink';
import { LOG_LEVELS, type LogLevel } from '@shared/schemas';

export interface LogUtilsOptions {
  data?: unknown;
}

/** This module's four levels as the names Effect's structured entry uses. */
const ENTRY_LEVEL: Record<LogLevel, string> = {
  [LOG_LEVELS.ERROR]: 'ERROR',
  [LOG_LEVELS.WARN]: 'WARN',
  [LOG_LEVELS.INFO]: 'INFO',
  [LOG_LEVELS.DEBUG]: 'DEBUG',
};

/**
 * Build one entry and hand it to the host sink. Single emission point for both
 * the functional logger API and channel writers. `fiberId` and `spans` are
 * empty because this path has no fiber to read them from — that identity
 * arrives only with `Effect.log*`. The `data` payload rides the entry raw;
 * the write path in `@logger/logSink` renders and bounds it once, for every
 * producer.
 */
function writeLine(
  level: LogLevel,
  channel: string,
  message: string,
  data: unknown,
): void {
  const annotations: Record<string, unknown> = { [LOG_CHANNEL]: channel };
  if (data != null) {
    annotations[LOG_DATA] = data;
  }
  const entry: LogEntry = {
    level: ENTRY_LEVEL[level],
    fiberId: '',
    timestamp: new Date().toISOString(),
    message,
    cause: undefined,
    annotations,
    spans: {},
  };
  writeLogEntry(entry);
}

type LogFn = (
  channel: string,
  message: string,
  options?: LogUtilsOptions,
) => void;

/** Build a level-bound writer onto the shared application channel. */
function makeLogFn(level: LogLevel): LogFn {
  return (channel, message, options = {}) =>
    writeLine(level, channel, message, options.data);
}

export const debug = makeLogFn(LOG_LEVELS.DEBUG);
export const info = makeLogFn(LOG_LEVELS.INFO);
export const warn = makeLogFn(LOG_LEVELS.WARN);
export const error = makeLogFn(LOG_LEVELS.ERROR);

/** A channel-bound view of the four level writers. */
export interface Log {
  debug(message: string, options?: LogUtilsOptions): void;
  info(message: string, options?: LogUtilsOptions): void;
  warn(message: string, options?: LogUtilsOptions): void;
  error(message: string, options?: LogUtilsOptions): void;
}

/**
 * Bind the four level writers to one channel so a module names its channel
 * once instead of threading it through every call:
 * `const log = createLog('X'); log.warn(message)`.
 *
 * Each method delegates to the exported `debug/info/warn/error` **through the
 * module's own namespace** (`loggerSelf`), read fresh on every call rather than
 * captured at bind time. That indirection is deliberate: it preserves the
 * observable seam that tests spy on — `vi.spyOn(logger, 'warn')` patches the
 * namespace binding, and because the lookup is per-call a `log.warn(...)` made
 * by a module-level `createLog(...)` (bound at import, before the spy exists)
 * is still intercepted. `options` is forwarded only when present so the spied
 * argument list matches a direct `warn(channel, msg)` call. Behavior is
 * otherwise identical to the free functions.
 */
export function createLog(channel: string): Log {
  const bind =
    (level: LogLevel) =>
    (message: string, options?: LogUtilsOptions): void => {
      if (options === undefined) loggerSelf[level](channel, message);
      else loggerSelf[level](channel, message, options);
    };
  return {
    debug: bind('debug'),
    info: bind('info'),
    warn: bind('warn'),
    error: bind('error'),
  };
}
