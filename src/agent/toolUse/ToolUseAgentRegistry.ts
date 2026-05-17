/** Unified execution registry for agent interruption. */

import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import type { StreamTabId } from '@shared/schemas';

/**
 * Common interface for anything that can be interrupted.
 * Implemented by:
 * - ToolUseFlowContext (via sessionLifecycle.interrupt())
 * - ReflectionFlowContext (via onInterrupt callback and retry coordinator)
 * - BaseAgent (via isInterrupted flag)
 */
export interface IInterruptible {
  /**
   * Request interruption of the execution.
   *
   * Implementations should:
   * - Invoke any onInterrupt callbacks to signal the interrupt manager
   * - Clear pending retry requests from the retry coordinator
   * - Cancel any pending follow-up waits (for tool-use sessions)
   *
   * This method may be called from the UI thread when the user stops a task.
   */
  interrupt(): void;
}

const registry = new Map<StreamTabId, IInterruptible>();

export function registerInterruptible(
  streamTabId: StreamTabId,
  interruptible: IInterruptible,
): void {
  registry.set(streamTabId, interruptible);
}

export function unregisterInterruptible(streamTabId: StreamTabId): void {
  registry.delete(streamTabId);
}

export function getInterruptible(
  streamTabId: StreamTabId,
): IInterruptible | undefined {
  return registry.get(streamTabId);
}

function isToolUseFlowContext(
  entry: IInterruptible | undefined,
): entry is ToolUseFlowContext {
  const session = (entry as ToolUseFlowContext | undefined)?.session;
  return session !== undefined && typeof session.appendFollowUp === 'function';
}

export function getToolUseFlowContext(
  streamTabId: StreamTabId,
): ToolUseFlowContext | undefined {
  const entry = registry.get(streamTabId);
  return isToolUseFlowContext(entry) ? entry : undefined;
}

export type SwitchToolUseModelResult =
  | { status: 'switched' }
  | { status: 'no_session' }
  | { status: 'unchanged' };

export async function switchToolUseModel(
  streamTabId: StreamTabId,
  model: string,
): Promise<SwitchToolUseModelResult> {
  const context = getToolUseFlowContext(streamTabId);
  if (!context) return { status: 'no_session' };
  if (context.model === model) return { status: 'unchanged' };
  await context.switchModel(model);
  return { status: 'switched' };
}

export function cleanupInactiveAgents(activeStreams: Set<StreamTabId>): void {
  for (const streamId of registry.keys()) {
    if (!activeStreams.has(streamId)) {
      registry.delete(streamId);
    }
  }
}
