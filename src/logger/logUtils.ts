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

// Cache for initialized channels to avoid repeated registry.ensure() calls
// This eliminates the overhead of Map lookup + string interpolation on every log
const initializedChannels = new Map<
  ChannelKey,
  ReturnType<typeof registry.ensure>
>();

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

function getContextByKey(key: ChannelKey): ChannelContext | undefined {
  const store = getStore();
  return store.get(key);
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

  if (!context?.stack.length) {
    store.delete(key);
  } else {
    // Remove the specific groupId from stack (supports non-LIFO group endings)
    const newStack = context.stack.filter((id) => id !== groupId);
    if (newStack.length === 0) {
      store.delete(key);
    } else {
      store.set(key, { stack: newStack });
    }
  }

  contextStorage.enterWith(store);
}

function resolveActiveGroupByKey(
  key: ChannelKey,
  groupId: string | undefined,
): string | undefined {
  if (groupId) {
    return groupId;
  }

  const context = getContextByKey(key);
  return context?.stack.at(-1);
}

function resolveActiveGroup(
  channel: string,
  groupId: string | undefined,
  isAgent: boolean,
): string | undefined {
  return resolveActiveGroupByKey(getChannelKey(channel, isAgent), groupId);
}

/**
 * Get a cached channel entry by pre-computed key.
 * Returns undefined if the entry doesn't exist.
 */
function getCachedEntryByKey(
  key: ChannelKey,
): ReturnType<typeof registry.ensure> | undefined {
  return initializedChannels.get(key);
}

/**
 * Get or create a cached channel entry.
 * Single source of truth for channel initialization - eliminates repeated registry.ensure() calls.
 */
function getCachedEntry(
  channel: string,
  isAgent: boolean,
): ReturnType<typeof registry.ensure> {
  const key = getChannelKey(channel, isAgent);
  let entry = initializedChannels.get(key);
  if (!entry) {
    entry = registry.ensure(channel, { isAgent });
    initializedChannels.set(key, entry);
  }
  return entry;
}

function getTransport(
  channel: string,
  isAgent = false,
): VSCodeTransport | undefined {
  const key = getChannelKey(channel, isAgent);
  return (
    initializedChannels.get(key)?.transport ??
    registry.getTransport(channel, { isAgent })
  );
}

function getOrCreateTransport(
  channel: string,
  isAgent: boolean,
): VSCodeTransport {
  return getCachedEntry(channel, isAgent).transport;
}

function logWithGroup(
  channel: string,
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  options: LogUtilsOptions = {},
): void {
  const isAgent = options.isAgent ?? false;
  // Compute key once and reuse for both entry lookup and group resolution
  const key = getChannelKey(channel, isAgent);
  const entry = getCachedEntryByKey(key) ?? getCachedEntry(channel, isAgent);
  const activeGroupId = resolveActiveGroupByKey(key, options.groupId);

  // DEBUG: trace groupId resolution for file loading messages
  if (message.includes('Loading') && message.includes('Files')) {
    const context = contextStorage.getStore()?.get(key);
    console.log(
      `[DEBUG logWithGroup] message="${message}" key="${key}" activeGroupId=${activeGroupId} contextStack=${JSON.stringify(context?.stack)}`,
    );
  }

  entry.logger.log(level, message, {
    groupId: activeGroupId,
    messageType: options.messageType,
    data: options.data,
  });
}

export function initialize(channel: string, isAgent = false): void {
  getCachedEntry(channel, isAgent);
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
  // DEBUG: trace Init group creation
  if (groupName === 'Init') {
    const key = getChannelKey(channel, isAgent);
    console.log(
      `[DEBUG startGroup] groupName="${groupName}" groupId=${groupId} key="${key}" channel="${channel}" isAgent=${isAgent}`,
    );
  }
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
  // DEBUG: trace runWithGroupContext calls
  const key = getChannelKey(channel, isAgent);
  const contextBefore = contextStorage.getStore()?.get(key);
  console.log(
    `[DEBUG runWithGroupContext] ENTER groupId=${groupId} key="${key}" stackBefore=${JSON.stringify(contextBefore?.stack)}`,
  );
  pushGroupContext(channel, groupId, isAgent);
  const contextAfter = contextStorage.getStore()?.get(key);
  console.log(
    `[DEBUG runWithGroupContext] AFTER PUSH stackAfter=${JSON.stringify(contextAfter?.stack)}`,
  );
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
