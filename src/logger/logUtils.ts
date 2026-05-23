/**
 * Channel-keyed logging primitives.
 *
 * Two surfaces:
 *
 *   1. Functional `debug/info/warn/error(channel, message, options)` — used
 *      by ~70 non-trace callers (utils, housekeeping, common, auth, etc.)
 *      that just want to write a line to a per-channel output sink.
 *
 *   2. `attachChannelSubscriber(trace, { channel, isAgent })` — subscribes
 *      the same sink machinery to an {@link AgentTrace}. Used by
 *      `createChannelTrace` / `createRunTrace` so the trace channel
 *      converges on the same output sinks. Replaces the former
 *      `consoleSubscriber.ts` pass-through.
 *
 * Output-channel creation is host-injected via {@link setOutputChannelFactory};
 * the VS Code extension provides a factory that returns VS Code
 * `OutputChannel`s, tests/CLI fall back to a console-backed sink.
 */
import type {
  AgentEvent,
  AgentTrace,
  AgentTraceSubscriber,
} from '@agent/trace';
import {
  LOG_LEVELS,
  MESSAGE_TYPES,
  type LogLevel,
  type MessageType,
} from '@shared/schemas';
import { getConfig } from '@utils/config';
import { serializeError } from '@utils/core';

export interface LogUtilsOptions {
  groupId?: string;
  messageType?: MessageType;
  data?: unknown;
  isAgent?: boolean;
}

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
let mainOutputChannel: OutputSink | null = null;
let outputChannelFactory: OutputChannelFactory | null = null;

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string =>
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

/**
 * Write one line to the per-channel sink. Single emission point — both the
 * functional logger API and the trace subscriber funnel through this.
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
    `${EMOJI_BY_LEVEL[level]} [${getTimestamp()}] ${prefix}${message}`,
  );

  if (data === null || data === undefined) return;
  if (!getConfig<boolean>('texra.logger.debugMode', false)) return;

  sink.appendLine(
    typeof data === 'string' ? data : JSON.stringify(data, null, 2),
  );
}

function logAt(
  level: LogLevel,
  channel: string,
  message: string,
  options: LogUtilsOptions,
): void {
  const data =
    options.data instanceof Error
      ? serializeError(options.data)
      : options.data;
  writeLine(level, channel, options.isAgent ?? false, message, data);
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

// ─── Trace subscriber ────────────────────────────────────────────────────

export interface ChannelSubscriberOptions {
  /** Channel name used for the per-channel output sink. */
  readonly channel: string;
  /** Whether to route writes to the agent-specific output channel. */
  readonly isAgent: boolean;
}

/**
 * Subscribe to a trace and route every `log` event to the per-channel
 * output sink. Non-log events are ignored — they are for structured
 * subscribers (transcript recorder, Supabase, SDK consumers).
 *
 * Replaces the former `attachConsoleSubscriber` shim: there is no longer
 * a `consoleSubscriber.ts` module sitting between the trace and the
 * sink-write boundary.
 */
export function attachChannelSubscriber(
  trace: AgentTrace,
  options: ChannelSubscriberOptions,
): () => void {
  ensureChannel(options.channel, options.isAgent);

  const subscriber: AgentTraceSubscriber = (event: AgentEvent) => {
    if (event.type !== 'log') return;
    // Internal-tagged log lines never reach the console — they exist for
    // upstream subscribers (debug telemetry, transcript) that opt in.
    if (event.messageType === MESSAGE_TYPES.INTERNAL) return;

    const data =
      event.data instanceof Error ? serializeError(event.data) : event.data;
    writeLine(
      event.level,
      options.channel,
      options.isAgent,
      event.message,
      data,
    );
  };

  return trace.subscribe(subscriber);
}
