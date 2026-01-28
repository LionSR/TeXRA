import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

import { END_GROUP_STATUS, type EndGroupStatus } from '@shared/schemas';
import { registry } from './LogChannelRegistry';
import type { LogUtilsOptions } from './logOptions';

type ChannelKey = string;

interface ChannelContext {
  stack: string[];
}

const contextStorage = new AsyncLocalStorage<Map<ChannelKey, ChannelContext>>();

function getChannelKey(channel: string, isAgent: boolean): ChannelKey {
  return `${channel}::${isAgent ? 'agent' : 'shared'}`;
}

function getStore(): Map<ChannelKey, ChannelContext> {
  let store = contextStorage.getStore();
  if (!store) {
    store = new Map();
    contextStorage.enterWith(store);
  }
  return store;
}

function pushGroupContext(
  channel: string,
  groupId: string,
  isAgent: boolean,
): void {
  const store = getStore();
  const key = getChannelKey(channel, isAgent);
  const context = store.get(key) ?? { stack: [] };

  store.set(key, { stack: [...context.stack, groupId] });
  contextStorage.enterWith(store);
}

function popGroupContext(
  channel: string,
  groupId: string,
  isAgent: boolean,
): void {
  const store = getStore();
  const key = getChannelKey(channel, isAgent);
  const context = store.get(key);

  if (!context?.stack.length) return;

  const lastIndex = context.stack.lastIndexOf(groupId);
  if (lastIndex === -1) return;

  const newStack = context.stack.toSpliced(lastIndex, 1);
  if (newStack.length === 0) {
    store.delete(key);
  } else {
    store.set(key, { stack: newStack });
  }
  contextStorage.enterWith(store);
}

function getActiveGroup(key: ChannelKey): string | undefined {
  return getStore().get(key)?.stack.at(-1);
}

function logWithGroup(
  channel: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  options: LogUtilsOptions = {},
): void {
  const isAgent = options.isAgent ?? false;
  const key = getChannelKey(channel, isAgent);
  const entry = registry.ensure(channel, { isAgent });
  const activeGroupId = options.groupId ?? getActiveGroup(key);

  entry.logger.log(level, message, {
    groupId: activeGroupId,
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
  pushGroupContext(channel, groupId, isAgent);
  return transport.startGroup(groupName, groupId, parentGroupId);
}

export function endGroup(
  channel: string,
  groupId: string,
  status: EndGroupStatus = END_GROUP_STATUS.STOPPED,
  isAgent = false,
): void {
  registry.getTransport(channel, isAgent)?.endGroup(groupId, status);
  popGroupContext(channel, groupId, isAgent);
}

export function getActiveGroupId(
  channel: string,
  isAgent = false,
): string | undefined {
  return getActiveGroup(getChannelKey(channel, isAgent));
}

export async function runWithGroupContext<T>(
  channel: string,
  groupId: string,
  isAgent: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  pushGroupContext(channel, groupId, isAgent);
  try {
    return await fn();
  } finally {
    popGroupContext(channel, groupId, isAgent);
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
