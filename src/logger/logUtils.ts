/**
 * Channel-keyed logging primitives.
 *
 * Functional callers use `debug/info/warn/error(channel, message, options)`.
 * Protocol adapters use `createChannelWriter(channel, isAgent)` to reach the
 * same sink without making this module depend on their event types.
 *
 * Output-channel creation is host-injected via {@link setOutputChannelFactory};
 * the VS Code extension provides a factory that returns VS Code
 * `OutputChannel`s, tests/CLI fall back to a console-backed sink.
 *
 * Secret redaction is a host responsibility, by design. This module does NOT
 * redact at emit time — the trade-off is cost/flexibility (most channel output
 * is product-internal and never persisted off-box). Hosts that persist or ship
 * logs off the machine MUST run text through {@link redactSecrets} in their sink
 * (see `desktopAppLog.ts` for the reference redacting wiring) before writing.
 * SDK consumers wiring a custom {@link setOutputChannelFactory} take on the same
 * contract; a sink that forgets it can leak API keys/paths into logs. (The CLI
 * stdout/stderr sinks in `logSinks.ts` are a deliberate non-redacting exception —
 * they target the operator's own terminal, not a persisted/exported artifact.)
 */
import { format } from 'date-fns';

import { LOG_LEVELS, type LogLevel } from '@shared/schemas';
import { getConfig } from '@utils/config';
import { serializeError } from '@utils/core';

export interface LogUtilsOptions {
  data?: unknown;
}

const LEVEL_TAG: Record<LogLevel, string> = {
  [LOG_LEVELS.ERROR]: 'ERROR',
  [LOG_LEVELS.WARN]: 'WARN ',
  [LOG_LEVELS.INFO]: 'INFO ',
  [LOG_LEVELS.DEBUG]: 'DEBUG',
};

interface OutputSink {
  appendLine(message: string): void;
  dispose?(): void;
}

type OutputChannelFactory = (name: string) => OutputSink;

const channels = new Map<string, OutputSink>();
let mainOutputChannel: OutputSink | null = null;
let outputChannelFactory: OutputChannelFactory | null = null;

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getTimestamp(): string {
  return format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS');
}

function createConsoleSink(channel: string): OutputSink {
  return {
    appendLine(message: string) {
      console.info(`[${channel}] ${message}`);
    },
  };
}

function createOutputChannel(channel: string, isAgent: boolean): OutputSink {
  const name = isAgent ? `TeXRA ${channel}` : 'TeXRA';
  return outputChannelFactory?.(name) ?? createConsoleSink(name);
}

function ensureChannel(channel: string, isAgent: boolean): OutputSink {
  const key = getKey(channel, isAgent);
  const existing = channels.get(key);
  if (existing) return existing;

  const output = isAgent
    ? createOutputChannel(channel, true)
    : (mainOutputChannel ??= createOutputChannel(channel, false));
  channels.set(key, output);
  return output;
}

/**
 * Single owner of the `texra.logger.debugMode` setting (config key + default).
 * Gates the verbose data line below, the transcript recorder's `verbose` flag,
 * and the webview debug-mode delivery, so the key and its default live in one
 * place.
 */
export function isDebugModeEnabled(): boolean {
  return getConfig<boolean>('texra.logger.debugMode', false);
}

/**
 * Write one line to the per-channel sink. Single emission point for both the
 * functional logger API and channel writers.
 */
function writeLine(
  level: LogLevel,
  channel: string,
  isAgent: boolean,
  message: string,
  data: unknown,
): void {
  const sink = ensureChannel(channel, isAgent);
  const prefix = isAgent ? '' : `[${channel}] `;
  sink.appendLine(
    `${LEVEL_TAG[level]} [${getTimestamp()}] ${prefix}${message}`,
  );

  if (data === null || data === undefined) return;
  if (!isDebugModeEnabled()) return;

  const normalizedData = normalizeLogData(data);
  sink.appendLine(
    typeof normalizedData === 'string'
      ? normalizedData
      : JSON.stringify(normalizedData, null, 2),
  );
}

export type ChannelWriter = (
  level: LogLevel,
  message: string,
  data?: unknown,
) => void;

/**
 * Create a protocol-neutral writer for one shared or agent channel.
 * Channel creation is eager, matching `initialize`.
 */
export function createChannelWriter(
  channel: string,
  isAgent: boolean,
): ChannelWriter {
  ensureChannel(channel, isAgent);
  return (level, message, data) =>
    writeLine(level, channel, isAgent, message, data);
}

/** Errors don't survive `JSON.stringify`, so flatten them before emit. */
function normalizeLogData(
  data: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (data instanceof Error) return serializeError(data);
  if (Array.isArray(data)) {
    if (seen.has(data)) return '[Circular]';
    seen.add(data);
    const result = data.map((item) => normalizeLogData(item, seen));
    seen.delete(data);
    return result;
  }
  if (typeof data !== 'object' || data === null) return data;

  const prototype = Object.getPrototypeOf(data);
  if (prototype !== Object.prototype && prototype !== null) return data;
  if (seen.has(data)) return '[Circular]';
  seen.add(data);

  const result = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      normalizeLogData(value, seen),
    ]),
  );
  seen.delete(data);
  return result;
}

function logAt(
  level: LogLevel,
  channel: string,
  message: string,
  options: LogUtilsOptions,
): void {
  // Functional callers write to the shared output channel.
  writeLine(level, channel, /* isAgent */ false, message, options.data);
}

export function initialize(channel: string, isAgent = false): void {
  ensureChannel(channel, isAgent);
}

export function setOutputChannelFactory(
  factory: OutputChannelFactory | null,
): void {
  const sinks = new Set<OutputSink>(channels.values());
  if (mainOutputChannel) sinks.add(mainOutputChannel);
  for (const sink of sinks) sink.dispose?.();

  outputChannelFactory = factory;
  channels.clear();
  mainOutputChannel = null;
}

type LogFn = (
  channel: string,
  message: string,
  options?: LogUtilsOptions,
) => void;

/** Build a level-bound forwarder onto {@link logAt}. */
function makeLogFn(level: LogLevel): LogFn {
  return (channel, message, options = {}) =>
    logAt(level, channel, message, options);
}

export const debug = makeLogFn(LOG_LEVELS.DEBUG);
export const info = makeLogFn(LOG_LEVELS.INFO);
export const warn = makeLogFn(LOG_LEVELS.WARN);
export const error = makeLogFn(LOG_LEVELS.ERROR);
