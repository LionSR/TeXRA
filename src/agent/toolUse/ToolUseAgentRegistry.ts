// Local imports - agent
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

// Use `any` for client type to accept any BaseToolUseAgent<C>
const registry = new Map<StreamTabId, BaseToolUseAgent<any>>();

export function registerToolUseAgent(
  streamTabId: StreamTabId,
  agent: BaseToolUseAgent<any>,
): void {
  registry.set(streamTabId, agent);
}

export function unregisterToolUseAgent(streamTabId: StreamTabId): void {
  registry.delete(streamTabId);
}

export function getToolUseAgent(
  streamTabId: StreamTabId,
): BaseToolUseAgent<any> | undefined {
  return registry.get(streamTabId);
}

/**
 * Remove registry entries for streams that no longer have an active tool-use session.
 */
export function cleanupInactiveAgents(activeStreams: Set<StreamTabId>): void {
  for (const streamId of registry.keys()) {
    if (!activeStreams.has(streamId)) {
      registry.delete(streamId);
    }
  }
}
