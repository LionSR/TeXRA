import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import { END_GROUP_STATUS, type EndGroupStatus } from '@shared/schemas';
import { registry } from './LogChannelRegistry';
import type { LogUtilsOptions } from './logOptions';

const contextStorage = new AsyncLocalStorage<Map<string, string[]>>();

function getKey(channel: string, isAgent: boolean): string {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getStore(): Map<string, string[]> {
  const existing = contextStorage.getStore();
  if (existing) return existing;

  const store = new Map<string, string[]>();
  contextStorage.enterWith(store);
  return store;
}

function pushGroup(channel: string, groupId: string, isAgent: boolean): void {
  const store = getStore();
  const key = getKey(channel, isAgent);
  store.set(key, [...(store.get(key) ?? []), groupId]);
  contextStorage.enterWith(store);
}

function popGroup(channel: string, groupId: string, isAgent: boolean): void {
  const store = getStore();
  const key = getKey(channel, isAgent);
  const stack = store.get(key);
  if (!stack?.length) return;

  const idx = stack.lastIndexOf(groupId);
  if (idx === -1) return;

  const newStack = stack.toSpliced(idx, 1);
  if (newStack.length) {
    store.set(key, newStack);
  } else {
    store.delete(key);
  }
  contextStorage.enterWith(store);
}

function logWithGroup(
  channel: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  options: LogUtilsOptions = {},
): void {
  const isAgent = options.isAgent ?? false;
  const key = getKey(channel, isAgent);
  const entry = registry.ensure(channel, { isAgent });

  entry.logger.log(level, message, {
    groupId: options.groupId ?? getStore().get(key)?.at(-1),
    messageType: options.messageType,
    data: options.data,
  });
}

export function initialize(channel: string, isAgent = false): void {
  registry.ensure(channel, { isAgent });
}

export function startGroup(
  channel: string,
  groupName: string,
  id?: string,
  parentGroupId?: string,
  isAgent = false,
): string {
  const transport = registry.ensure(channel, { isAgent }).transport;
  const groupId = id ?? randomUUID();
  pushGroup(channel, groupId, isAgent);
  return transport.startGroup(groupName, groupId, parentGroupId);
}

export function endGroup(
  channel: string,
  groupId: string,
  status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  isAgent = false,
): void {
  registry.getTransport(channel, isAgent)?.endGroup(groupId, status);
  popGroup(channel, groupId, isAgent);
}

export function getActiveGroupId(
  channel: string,
  isAgent = false,
): string | undefined {
  return getStore().get(getKey(channel, isAgent))?.at(-1);
}

export async function runWithGroupContext<T>(
  channel: string,
  groupId: string,
  isAgent: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  pushGroup(channel, groupId, isAgent);
  try {
    return await fn();
  } finally {
    popGroup(channel, groupId, isAgent);
  }
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
