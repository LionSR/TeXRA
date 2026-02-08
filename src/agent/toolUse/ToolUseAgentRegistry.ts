/**
 * Unified execution registry for agent interruption.
 *
 * Supports hierarchical parent/child registrations for subagent execution.
 * Each stream has a stack of interruptibles — interrupting the top-level
 * entry propagates to all children.
 */

// Local imports - agent
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

/**
 * Stack of interruptibles per stream. The last entry is the active one
 * (innermost subagent). Interrupting a stream interrupts all entries in
 * the stack (parent + children).
 */
const registry = new Map<StreamTabId, IInterruptible[]>();

/**
 * Register an interruptible execution by stream ID.
 * Multiple registrations on the same stream form a stack (for subagents).
 */
export function registerInterruptible(
  streamTabId: StreamTabId,
  interruptible: IInterruptible,
): void {
  const stack = registry.get(streamTabId);
  if (stack) {
    stack.push(interruptible);
  } else {
    registry.set(streamTabId, [interruptible]);
  }
}

/**
 * Unregister the most recent interruptible for a stream.
 * Removes the stack entry when the last registration is popped.
 */
export function unregisterInterruptible(streamTabId: StreamTabId): void {
  const stack = registry.get(streamTabId);
  if (!stack) return;
  stack.pop();
  if (stack.length === 0) {
    registry.delete(streamTabId);
  }
}

/**
 * Get the active (innermost) interruptible execution for a stream.
 */
export function getInterruptible(
  streamTabId: StreamTabId,
): IInterruptible | undefined {
  const stack = registry.get(streamTabId);
  return stack?.[stack.length - 1];
}

/**
 * Interrupt all interruptibles registered for a stream (parent + children).
 * Interrupts in reverse order (innermost first).
 */
export function interruptAll(streamTabId: StreamTabId): void {
  const stack = registry.get(streamTabId);
  if (!stack) return;
  for (let i = stack.length - 1; i >= 0; i--) {
    stack[i].interrupt();
  }
}

/**
 * Type guard: ToolUseFlowContext has a session with appendFollowUp method.
 */
function isToolUseFlowContext(
  entry: IInterruptible | undefined,
): entry is ToolUseFlowContext<unknown> {
  const session = (entry as ToolUseFlowContext<unknown> | undefined)?.session;
  return session !== undefined && typeof session.appendFollowUp === 'function';
}

/**
 * Get a tool-use flow context by stream ID (active/innermost entry).
 * Returns undefined if the entry is not a ToolUseFlowContext.
 */
export function getToolUseFlowContext(
  streamTabId: StreamTabId,
): ToolUseFlowContext<unknown> | undefined {
  const entry = getInterruptible(streamTabId);
  return isToolUseFlowContext(entry) ? entry : undefined;
}

/**
 * Remove registry entries for streams that no longer have an active session.
 */
export function cleanupInactiveAgents(activeStreams: Set<StreamTabId>): void {
  for (const streamId of registry.keys()) {
    if (!activeStreams.has(streamId)) {
      registry.delete(streamId);
    }
  }
}
