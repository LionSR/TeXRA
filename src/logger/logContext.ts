// Standard library imports
import { AsyncLocalStorage } from 'async_hooks';

interface LogContextState {
  readonly groups: Map<string, string | undefined>;
}

const storage = new AsyncLocalStorage<LogContextState>();

function cloneStateWithUpdate(
  channelId: string,
  groupId: string | undefined,
  baseState: LogContextState | undefined,
): LogContextState {
  const nextGroups = new Map(baseState?.groups ?? []);
  if (groupId === undefined) {
    nextGroups.delete(channelId);
  } else {
    nextGroups.set(channelId, groupId);
  }
  return { groups: nextGroups };
}

/**
 * Run the provided callback within a context that sets the active log group
 * for the specified channel. Nested calls correctly shadow previously active
 * groups for the duration of the callback.
 */
export function runWithChannelGroup<T>(
  channelId: string,
  groupId: string | undefined,
  callback: () => T,
): T {
  const parentState = storage.getStore();
  const nextState = cloneStateWithUpdate(channelId, groupId, parentState);
  return storage.run(nextState, callback);
}

/**
 * Resolve the currently active group identifier for a channel from the async
 * context if one has been set.
 */
export function getContextGroupId(channelId: string): string | undefined {
  const state = storage.getStore();
  return state?.groups.get(channelId);
}
