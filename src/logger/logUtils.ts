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
 *      `createRunTrace` so the real per-run trace channel converges on the
 *      same output sinks. Replaces the former `consoleSubscriber.ts`
 *      pass-through. (`createChannelTrace`'s module-level singletons close
 *      over surface 1 directly — no `AgentTrace` subscriber involved.)
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
// Type-only imports from the leaf trace modules (not the `@agent/trace`
// barrel, which pulls in TraceEmitter and would cycle back into this logger).
import { format } from 'date-fns';

import type { AgentTrace, AgentTraceSubscriber } from '@agent/trace/AgentTrace';
import type { AgentEvent } from '@agent/trace/events';
import { LOG_LEVELS, MESSAGE_TYPES, type LogLevel } from '@shared/schemas';
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
  // Functional callers (housekeeping, utils, common) never write to the
  // per-stream agent channels — that's exclusively the trace subscriber
  // path via `attachChannelSubscriber`.
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

    writeLine(
      event.level,
      options.channel,
      options.isAgent,
      event.message,
      event.data,
    );
  };

  return trace.subscribe(subscriber);
}
