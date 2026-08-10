/**
 * Channel-keyed logging primitives.
 *
 * Functional callers use `debug/info/warn/error(channel, message, options)`.
 * Channel-trace infrastructure and callers in `src/agent/trace/channelTrace.ts`
 * use `createChannelWriter(channel, isAgent)` to reach the same sink without
 * making this module depend on their event types.
 *
 * Output-channel creation is host-injected via {@link setOutputChannelFactory};
 * the VS Code extension provides a factory that returns VS Code
 * `OutputChannel`s, tests/CLI fall back to a console-backed sink.
 *
 * Sink output is secret-redacted by default. A host may opt out only for a
 * trusted operator terminal whose output is neither persisted nor exported.
 */
// Third-party imports
import { format } from 'date-fns';
import safeStringify from 'safe-stable-stringify';

// Local imports
import { redactSecrets } from '@logger/redaction';
import { LOG_LEVELS, type LogLevel } from '@shared/schemas/log';
import { serializeError } from '@utils/core';
import { getConfig } from '@utils/config/configUtils';

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

export interface OutputChannelFactoryOptions {
  /** Preserve raw output only for a local operator-controlled terminal. */
  readonly trusted?: boolean;
}

const channels = new Map<string, OutputSink>();
let mainOutputChannel: OutputSink | null = null;
let outputChannelFactory: OutputChannelFactory | null = null;
let outputSinksTrusted = false;

const redactingSinks = new WeakMap<OutputSink, OutputSink>();

function createRedactingSink(sink: OutputSink): OutputSink {
  const existing = redactingSinks.get(sink);
  if (existing) return existing;

  const redactingSink: OutputSink = {
    appendLine(message) {
      sink.appendLine(redactSecrets(message));
    },
    dispose() {
      sink.dispose?.();
    },
  };
  redactingSinks.set(sink, redactingSink);
  return redactingSink;
}

function createOutputChannel(channel: string, isAgent: boolean): OutputSink {
  const name = isAgent ? `TeXRA ${channel}` : 'TeXRA';
  const sink = outputChannelFactory?.(name) ?? {
    appendLine(message: string) {
      console.info(`[${name}] ${message}`);
    },
  };
  return outputSinksTrusted ? sink : createRedactingSink(sink);
}

function ensureChannel(channel: string, isAgent: boolean): OutputSink {
  const key = `${channel}::${isAgent ? 'agent' : 'shared'}`;
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
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss.SSS');
  const prefix = isAgent ? '' : `[${channel}] `;
  sink.appendLine(`${LEVEL_TAG[level]} [${timestamp}] ${prefix}${message}`);

  if (data == null) return;
  if (!isDebugModeEnabled()) return;

  sink.appendLine(normalizeLogData(data));
}

export type ChannelWriter = (
  level: LogLevel,
  message: string,
  data?: unknown,
) => void;

/**
 * Create a protocol-neutral writer for one shared or agent channel.
 * Channel creation is eager so the returned writer owns a ready sink.
 */
export function createChannelWriter(
  channel: string,
  isAgent: boolean,
): ChannelWriter {
  ensureChannel(channel, isAgent);
  return (level, message, data) =>
    writeLine(level, channel, isAgent, message, data);
}

/** Errors don't survive `JSON.stringify`, so flatten them before emit.
 *  `safe-stable-stringify` already handles circular references (rendered as
 *  `"[Circular]"`, matching the prior hand-rolled walker); this only adds the
 *  Error → plain-object mapping on top via its replacer hook. */
function normalizeLogData(data: unknown): string {
  if (typeof data !== 'object' || data === null) return String(data);
  return (
    safeStringify(
      data,
      (_key, value) => (value instanceof Error ? serializeError(value) : value),
      2,
    ) ?? String(data)
  );
}

/**
 * Replace the host sink factory and dispose all cached sinks. New sinks redact
 * secrets unless the host explicitly identifies a local operator terminal as
 * trusted.
 */
export function setOutputChannelFactory(
  factory: OutputChannelFactory | null,
  options: OutputChannelFactoryOptions = {},
): void {
  const sinks = new Set<OutputSink>(channels.values());
  if (mainOutputChannel) sinks.add(mainOutputChannel);
  for (const sink of sinks) sink.dispose?.();

  outputChannelFactory = factory;
  outputSinksTrusted = options.trusted === true;
  channels.clear();
  mainOutputChannel = null;
}

type LogFn = (
  channel: string,
  message: string,
  options?: LogUtilsOptions,
) => void;

/** Build a level-bound writer onto the shared output channel. */
function makeLogFn(level: LogLevel): LogFn {
  return (channel, message, options = {}) =>
    writeLine(level, channel, /* isAgent */ false, message, options.data);
}

export const debug = makeLogFn(LOG_LEVELS.DEBUG);
export const info = makeLogFn(LOG_LEVELS.INFO);
export const warn = makeLogFn(LOG_LEVELS.WARN);
export const error = makeLogFn(LOG_LEVELS.ERROR);
