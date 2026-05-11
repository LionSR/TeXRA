import { type LogLevel } from '@shared/schemas';
import { getConfig } from '@utils/config';
import { serializeError } from '@utils/core';

import {
  createStructuredLogger,
  type Logger,
  type LogRecord,
  type LogSink as StructuredLogSink,
} from './structuredLogger';
import { getColorForLevel } from './utils';
import type { LogUtilsOptions } from './logOptions';

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

class LegacyOutputChannelSink implements StructuredLogSink {
  constructor(
    private readonly output: OutputSink,
    private readonly channel: string,
    private readonly isAgent: boolean,
  ) {}

  write(record: LogRecord): void {
    writeLine(this.output, this.channel, this.isAgent, record);
  }
}

function writeLine(
  output: OutputSink,
  streamId: string,
  isAgent: boolean,
  record: LogRecord,
): void {
  const prefix = isAgent ? '' : `[${streamId}] `;
  output.appendLine(
    `${getColorForLevel(record.level)} [${getTimestamp()}] ${prefix}${record.message}`,
  );

  const includeStructuredData = getConfig<boolean>(
    'texra.logger.debugMode',
    false,
  );
  const data = record.fields.data;
  if (!includeStructuredData || data === null || data === undefined) return;

  const payload =
    typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  output.appendLine(payload);
}

function ensureLegacyLogger(channel: string, isAgent: boolean): Logger {
  const key = getKey(channel, isAgent);
  const existing = legacyLoggers.get(key);
  if (existing) return existing;

  const output = ensureChannel(channel, isAgent);
  const logger = createStructuredLogger(
    new LegacyOutputChannelSink(output, channel, isAgent),
  ).child({ streamId: channel, isAgent });
  legacyLoggers.set(key, logger);
  return logger;
}

function logWithGroup(
  channel: string,
  level: LogLevel,
  message: string,
  options: LogUtilsOptions = {},
): void {
  const isAgent = options.isAgent ?? false;
  const resolvedData =
    options.data instanceof Error ? serializeError(options.data) : options.data;
  const legacyLogger = ensureLegacyLogger(channel, isAgent);
  const activeGroupId = legacyLogger.activeGroupId();
  legacyLogger[level](message, {
    groupId: options.groupId ?? activeGroupId,
    data: resolvedData,
  });
}

export function initialize(channel: string, isAgent = false): void {
  ensureLegacyLogger(channel, isAgent);
}

export function setOutputChannelFactory(
  factory: OutputChannelFactory | null,
): void {
  const sinks = new Set<OutputSink>(channels.values());
  if (mainOutputChannel) {
    sinks.add(mainOutputChannel);
  }
  for (const sink of sinks) {
    sink.dispose?.();
  }
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
  logWithGroup(channel, 'debug', message, options);
}

export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'info', message, options);
}

export function warn(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'warn', message, options);
}

export function error(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'error', message, options);
}
