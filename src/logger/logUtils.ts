import { AsyncLocalStorage } from 'async_hooks';

import { type LogLevel } from '@shared/schemas';
import { getConfig } from '@utils/config';
import { serializeError } from '@utils/core';

import { getColorForLevel } from './utils';
import type * as vscode from 'vscode';
import type { LogUtilsOptions } from './logOptions';

const contextStorage = new AsyncLocalStorage<Map<string, string[]>>();

interface LogSink {
  appendLine(message: string): void;
}

const channels = new Map<string, LogSink>();
let mainOutputChannel: LogSink | null = null;
let vscodeApi: typeof vscode | null | undefined;

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width: number = 2) =>
    value.toString().padStart(width, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function loadVscodeApi(): typeof vscode | null {
  if (vscodeApi !== undefined) return vscodeApi;
  try {
    const requireFn = Function(
      'return typeof require === "function" ? require : undefined',
    )() as NodeRequire | undefined;
    vscodeApi = requireFn?.('vscode') as typeof vscode | undefined;
    vscodeApi ??= null;
  } catch {
    vscodeApi = null;
  }
  return vscodeApi;
}

function createConsoleSink(channel: string): LogSink {
  return {
    appendLine(message: string) {
      console.info(`[${channel}] ${message}`);
    },
  };
}

function createOutputChannel(channel: string, isAgent: boolean): LogSink {
  const api = loadVscodeApi();
  if (!api) return createConsoleSink(isAgent ? `TeXRA ${channel}` : 'TeXRA');
  return isAgent
    ? api.window.createOutputChannel(`TeXRA ${channel}`)
    : api.window.createOutputChannel('TeXRA');
}

function ensureChannel(channel: string, isAgent: boolean): LogSink {
  const key = getKey(channel, isAgent);
  const existing = channels.get(key);
  if (existing) return existing;

  const output = isAgent
    ? createOutputChannel(channel, true)
    : (mainOutputChannel ??= createOutputChannel(channel, false));
  channels.set(key, output);
  return output;
}

function getActiveGroupStack(
  channel: string,
  isAgent: boolean,
): string[] | undefined {
  return contextStorage.getStore()?.get(getKey(channel, isAgent));
}

function writeLine(
  channel: LogSink,
  streamId: string,
  level: LogLevel,
  message: string,
  isAgent: boolean,
  data: unknown,
): void {
  const prefix = isAgent ? '' : `[${streamId}] `;
  channel.appendLine(
    `${getColorForLevel(level)} [${getTimestamp()}] ${prefix}${message}`,
  );

  const includeStructuredData = getConfig<boolean>(
    'texra.logger.debugMode',
    false,
  );
  if (!includeStructuredData || data === null || data === undefined) return;

  const payload =
    typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  channel.appendLine(payload);
}

function logWithGroup(
  channel: string,
  level: LogLevel,
  message: string,
  options: LogUtilsOptions = {},
): void {
  const isAgent = options.isAgent ?? false;
  const output = ensureChannel(channel, isAgent);
  const resolvedData =
    options.data instanceof Error ? serializeError(options.data) : options.data;

  writeLine(output, channel, level, message, isAgent, resolvedData);
}

export function initialize(channel: string, isAgent = false): void {
  ensureChannel(channel, isAgent);
}

export function getActiveGroupId(
  channel: string,
  isAgent = false,
): string | undefined {
  return getActiveGroupStack(channel, isAgent)?.at(-1);
}

export function runWithGroupContext<T>(
  channel: string,
  groupId: string,
  isAgent: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  const parentStore = contextStorage.getStore() ?? new Map<string, string[]>();
  const childStore = new Map(parentStore);
  const key = getKey(channel, isAgent);
  const stack = childStore.get(key) ?? [];
  childStore.set(key, [...stack, groupId]);
  return contextStorage.run(childStore, () => Promise.resolve().then(fn));
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
