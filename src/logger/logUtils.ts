// Third-party imports
import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

// Local imports - logger
import { registry } from './LogChannelRegistry';

// Local imports - constants
import { END_GROUP_STATUS } from './messageTypes';

// Type imports
import type { EndGroupStatus } from './messageTypes';
import type { VSCodeTransport } from './transports/VSCodeTransport';
import type { LogUtilsOptions } from './logOptions';

// Re-export for convenience
export type { LogOptions } from './logOptions';

type ChannelKey = string;

interface ChannelContext {
  stack: string[];
}

const contextStorage = new AsyncLocalStorage<Map<ChannelKey, ChannelContext>>();
const previousStacks = new Map<string, string[]>();

function getChannelKey(channel: string, isAgent: boolean): ChannelKey {
  return `${isAgent ? 'agent' : 'default'}::${channel}`;
}

function getStore(): Map<ChannelKey, ChannelContext> {
  let store = contextStorage.getStore();
  if (!store) {
    store = new Map();
    contextStorage.enterWith(store);
  }
  return store;
}

function getContext(
  channel: string,
  isAgent: boolean,
): ChannelContext | undefined {
  const store = getStore();
  return store.get(getChannelKey(channel, isAgent));
}

function setContext(
  channel: string,
  isAgent: boolean,
  context: ChannelContext | undefined,
): void {
  const store = getStore();
  const key = getChannelKey(channel, isAgent);

  if (context) {
    store.set(key, context);
  } else {
    store.delete(key);
  }

  contextStorage.enterWith(store);
}

function pushGroupContext(
  channel: string,
  groupId: string,
  isAgent: boolean,
): void {
  const store = getStore();
  const key = getChannelKey(channel, isAgent);
  const context = store.get(key) ?? { stack: [] };

  previousStacks.set(`${key}:${groupId}`, [...context.stack]);

  const nextContext: ChannelContext = {
    stack: [...context.stack, groupId],
  };

  store.set(key, nextContext);
  contextStorage.enterWith(store);
}

function popGroupContext(
  channel: string,
  groupId: string,
  isAgent: boolean,
): void {
  const store = getStore();
  const key = getChannelKey(channel, isAgent);
  const previous = previousStacks.get(`${key}:${groupId}`);
  previousStacks.delete(`${key}:${groupId}`);

  if (!previous || previous.length === 0) {
    store.delete(key);
  } else {
    store.set(key, { stack: [...previous] });
  }

  contextStorage.enterWith(store);
}

function resolveActiveGroup(
  channel: string,
  groupId: string | undefined,
  isAgent: boolean,
): string | undefined {
  if (groupId) {
    return groupId;
  }

  const context = getContext(channel, isAgent);
  if (!context) {
    return undefined;
  }

  return context.stack.at(-1);
}

function getTransport(
  channel: string,
  isAgent = false,
): VSCodeTransport | undefined {
  return registry.getTransport(channel, { isAgent });
}

function getOrCreateTransport(
  channel: string,
  isAgent: boolean,
): VSCodeTransport {
  const entry = registry.ensure(channel, { isAgent });
  return entry.transport;
}

function logWithGroup(
  channel: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  options: LogUtilsOptions = {},
): void {
  const isAgent = options.isAgent ?? false;
  const entry = registry.ensure(channel, { isAgent });
  const { logger } = entry;
  const activeGroupId = resolveActiveGroup(channel, options.groupId, isAgent);

  logger.log(level, message, {
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
  const transport = getOrCreateTransport(channel, isAgent);
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
  const transport = getTransport(channel, isAgent);
  transport?.endGroup(groupId, status);
  popGroupContext(channel, groupId, isAgent);
}

export function getActiveGroupId(
  channel: string,
  isAgent = false,
): string | undefined {
  return resolveActiveGroup(channel, undefined, isAgent);
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

/**
 * Log a debug message with options object.
 */
export function debug(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'debug', message, options);
}

/**
 * Log an info message with options object.
 */
export function info(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'info', message, options);
}

/**
 * Log a warning message with options object.
 */
export function warn(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'warn', message, options);
}

/**
 * Log an error message with options object.
 */
export function error(
  channel: string,
  message: string,
  options: LogUtilsOptions = {},
): void {
  logWithGroup(channel, 'error', message, options);
}
