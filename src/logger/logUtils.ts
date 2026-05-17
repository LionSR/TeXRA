import { LOG_LEVELS, type LogLevel } from '@shared/schemas';
import { getConfig } from '@utils/config';
import { serializeError } from '@utils/core';

import {
  createStructuredLogger,
  type Logger,
  type LogRecord,
  type LogSink as StructuredLogSink,
} from './structuredLogger';
import type { LogUtilsOptions } from './logOptions';

const EMOJI_BY_LEVEL: Record<LogLevel, string> = {
  [LOG_LEVELS.ERROR]: '🔴',
  [LOG_LEVELS.WARN]: '🟡',
  [LOG_LEVELS.INFO]: '🟢',
  [LOG_LEVELS.DEBUG]: '🔍',
};

interface OutputSink {
  appendLine(message: string): void;
  dispose?(): void;
}

type OutputChannelFactory = (name: string) => OutputSink;

const channels = new Map<string, OutputSink>();
const legacyLoggers = new Map<string, Logger>();
let mainOutputChannel: OutputSink | null = null;
let outputChannelFactory: OutputChannelFactory | null = null;

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width: number = 2) =>
    value.toString().padStart(width, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
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

function createLegacySink(
  output: OutputSink,
  channel: string,
  isAgent: boolean,
): StructuredLogSink {
  const prefix = isAgent ? '' : `[${channel}] `;
  return {
    write(record: LogRecord): void {
      output.appendLine(
        `${EMOJI_BY_LEVEL[record.level]} [${getTimestamp()}] ${prefix}${record.message}`,
      );

      const data = record.fields.data;
      if (data === null || data === undefined) return;
      if (!getConfig<boolean>('texra.logger.debugMode', false)) return;

      output.appendLine(
        typeof data === 'string' ? data : JSON.stringify(data, null, 2),
      );
    },
  };
}

function ensureLegacyLogger(channel: string, isAgent: boolean): Logger {
  const key = getKey(channel, isAgent);
  const existing = legacyLoggers.get(key);
  if (existing) return existing;

  const output = ensureChannel(channel, isAgent);
  const logger = createStructuredLogger(
    createLegacySink(output, channel, isAgent),
  ).child({ streamId: channel, isAgent });
  legacyLoggers.set(key, logger);
  return logger;
}

function logAt(
  level: LogLevel,
  channel: string,
  message: string,
  options: LogUtilsOptions,
): void {
  const legacyLogger = ensureLegacyLogger(channel, options.isAgent ?? false);
  legacyLogger[level](message, {
    groupId: options.groupId ?? legacyLogger.activeGroupId(),
    data:
      options.data instanceof Error
        ? serializeError(options.data)
        : options.data,
  });
}

export function initialize(channel: string, isAgent = false): void {
  ensureLegacyLogger(channel, isAgent);
}

export function setOutputChannelFactory(
  factory: OutputChannelFactory | null,
): void {
  const sinks = new Set<OutputSink>(channels.values());
  if (mainOutputChannel) sinks.add(mainOutputChannel);
  for (const sink of sinks) sink.dispose?.();

  outputChannelFactory = factory;
  channels.clear();
  legacyLoggers.clear();
  mainOutputChannel = null;
}

export function getActiveGroupId(
  channel: string,
  isAgent = false,
): string | undefined {
  return ensureLegacyLogger(channel, isAgent).activeGroupId();
}

export function runWithGroupContext<T>(
  channel: string,
  groupId: string,
  isAgent: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  return ensureLegacyLogger(channel, isAgent).withGroup(groupId, fn);
}

export function debug(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logAt('debug', channel, message, options);
}

export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logAt('info', channel, message, options);
}

export function warn(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logAt('warn', channel, message, options);
}

export function error(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logAt('error', channel, message, options);
}
