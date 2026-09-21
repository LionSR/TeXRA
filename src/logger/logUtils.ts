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
// Third-party imports
import safeStringify from 'safe-stable-stringify';

// Local imports
import * as loggerSelf from '@logger/logUtils';
import { LOG_CHANNEL, writeLogEntry, type LogEntry } from '@logger/logSink';
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
 * The one configuration read this module makes, as the port its consumer
 * declares: a `ConfigProvider` satisfies it structurally, and the logger keeps
 * no import of `@platform` for it — the logger subsystem depends on no host.
 */
export interface DebugModeConfig {
  get(path: string, defaultValue: boolean): boolean;
}

/**
 * The configuration `texra.logger.debugMode` is read from: process-wide, like
 * the sink in `@logger/logSink`, because a log line has no session to take a
 * provider from. Installed by the composition root beside its sink; absent
 * until then, so startup reporting that precedes the host's configuration
 * logs as if debug mode were off rather than reaching for an ambient record.
 */
let debugModeConfig: DebugModeConfig | undefined;

/** Install (or, with `null`, uninstall) the configuration `isDebugModeEnabled`
 *  reads. A composition root calls this once, with its own workspace roots'
 *  provider. */
export function setDebugModeConfig(config: DebugModeConfig | null): void {
  debugModeConfig = config ?? undefined;
}

/**
 * Single owner of the `texra.logger.debugMode` setting (config key + default).
 * Gates the verbose data annotation below, the transcript recorder's `verbose`
 * flag, and the webview debug-mode delivery, so the key and its default live in
 * one place. Read on each call, so a host that changes the setting while it
 * runs takes effect at the next entry.
 */
export function isDebugModeEnabled(): boolean {
  return debugModeConfig?.get('texra.logger.debugMode', false) ?? false;
}

/**
 * Flatten an `Error` into the plain object `JSON.stringify` would otherwise
 * render as `{}`: its three non-enumerable display fields, its `cause` (also
 * non-enumerable when set through the constructor option), and its own
 * enumerable properties (e.g. `statusCode`, `requestId`). A nested `cause`
 * that is itself an `Error` reaches this function again through the replacer
 * below, so a cause chain flattens whole. The spread comes first so the named
 * fields are not reported as overwritten; the values are identical either way,
 * since reading `error.name` returns an own enumerable `name` when one exists.
 *
 * `flattened` is what keeps a cycle finite. `safe-stable-stringify` detects a
 * cycle by looking for the *post-replacer* value on its own stack, so handing
 * it a fresh object for each visit of the same `Error` would defeat that check
 * and recurse until the stack overflows. One object per `Error` per render
 * makes the identity it tests stable, and a self-referential property or a
 * `cause` cycle renders `"[Circular]"`.
 */
function serializeError(
  error: Error,
  flattened: WeakMap<Error, Record<string, unknown>>,
): Record<string, unknown> {
  const existing = flattened.get(error);
  if (existing !== undefined) return existing;
  const flat: Record<string, unknown> = {};
  flattened.set(error, flat);
  Object.assign(flat, error, {
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
  if (error.cause !== undefined) flat['cause'] = error.cause;
  return flat;
}

/**
 * Render a debug payload for display. Errors don't survive `JSON.stringify`,
 * so they're flattened here, each `Error` to one object for the whole render
 * so `safe-stable-stringify` still renders a cycle as `"[Circular]"`. Shared
 * with `@logger/effectLog`, so an entry carries the same rendered payload
 * whichever producer wrote it.
 */
export function formatLogData(data: unknown): string {
  if (typeof data !== 'object' || data === null) return String(data);
  const flattened = new WeakMap<Error, Record<string, unknown>>();
  return (
    safeStringify(
      data,
      (_key, value) =>
        value instanceof Error ? serializeError(value, flattened) : value,
      2,
    ) ?? String(data)
  );
}

/**
 * Build one entry and hand it to the host sink. Single emission point for both
 * the functional logger API and channel writers. `fiberId` and `spans` are
 * empty because this path has no fiber to read them from — that identity
 * arrives only with `Effect.log*`.
 */
function writeLine(
  level: LogLevel,
  channel: string,
  message: string,
  data: unknown,
): void {
  const annotations: Record<string, unknown> = { [LOG_CHANNEL]: channel };
  if (data != null && isDebugModeEnabled()) {
    annotations['data'] = formatLogData(data);
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
    (level: 'debug' | 'info' | 'warn' | 'error') =>
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
