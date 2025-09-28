// Local imports - agent
import type { BaseToolUseAgent } from '@agent/implementations/BaseToolUseAgent';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

const registry = new Map<StreamTabId, BaseToolUseAgent>();

export function registerToolUseAgent(
  streamTabId: StreamTabId,
  agent: BaseToolUseAgent,
): void {
  registry.set(streamTabId, agent);
}

export function unregisterToolUseAgent(streamTabId: StreamTabId): void {
  registry.delete(streamTabId);
}

export function getToolUseAgent(
  streamTabId: StreamTabId,
): BaseToolUseAgent | undefined {
  return registry.get(streamTabId);
}

export function clearToolUseAgents(): void {
  registry.clear();
}
