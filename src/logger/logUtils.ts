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
import {
  LOG_CHANNEL,
  LOG_DATA,
  writeLogEntry,
  type LogEntry,
} from '@logger/logSink';
import { LOG_LEVELS, type LogLevel } from '@shared/schemas';

interface LogUtilsOptions {
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
