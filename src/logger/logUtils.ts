import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import * as vscode from 'vscode';

import { type EndGroupStatus, type LogLevel } from '@shared/schemas';
import { getConfig } from '@utils/config';
import { serializeError } from '@utils/core';

import { getColorForLevel } from './utils';
import type { LogUtilsOptions } from './logOptions';

const contextStorage = new AsyncLocalStorage<Map<string, string[]>>();

const channels = new Map<string, vscode.OutputChannel>();
let mainOutputChannel: vscode.OutputChannel | null = null;

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getTimestamp(): string {
  const now = new Date();
  const pad = (value: number, width: number = 2) =>
    value.toString().padStart(width, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function ensureChannel(
  channel: string,
  isAgent: boolean,
): vscode.OutputChannel {
  const key = getKey(channel, isAgent);
  const existing = channels.get(key);
  if (existing) return existing;

  const output = isAgent
    ? vscode.window.createOutputChannel(`TeXRA ${channel}`)
    : (mainOutputChannel ??= vscode.window.createOutputChannel('TeXRA'));
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
  channel: vscode.OutputChannel,
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

export function startGroup(
  _channel: string,
  _groupName: string,
  id?: string,
  _parentGroupId?: string,
  _isAgent = false,
): string {
  return id ?? randomUUID();
}

export function endGroup(
  _channel: string,
  _groupId: string,
  _status: EndGroupStatus,
  _isAgent = false,
): void {
  // Group lifecycle is handled by AgentLogger + StreamLogStore.
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
