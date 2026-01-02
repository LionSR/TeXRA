/**
 * Unified execution registry for agent interruption.
 *
 * This module provides a single registry for all interruptible executions,
 * primarily tool-use flow contexts. The registry enables unified interrupt
 * handling from agentCommands.
 */

// Local imports - agent
import type { ToolUseFlowContext } from '@agent/implementations/flows/tooluse';
import type { StreamTabId } from '@agent/types/IdentifierTypes';

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

// Unified registry for all interruptible executions
const registry = new Map<StreamTabId, IInterruptible>();

// ============================================================================
// Core Registry Operations
// ============================================================================

/**
 * Register an interruptible execution by stream ID.
 * Used by both flow contexts and agent classes.
 */
export function registerInterruptible(
  streamTabId: StreamTabId,
  interruptible: IInterruptible,
): void {
  registry.set(streamTabId, interruptible);
}

/**
 * Unregister an execution from the registry.
 */
export function unregisterInterruptible(streamTabId: StreamTabId): void {
  registry.delete(streamTabId);
}

/**
 * Get the interruptible execution for a stream.
 */
export function getInterruptible(
  streamTabId: StreamTabId,
): IInterruptible | undefined {
  return registry.get(streamTabId);
}

// ============================================================================
// Tool-Use Flow Context (Type-Specific Access)
// ============================================================================

/**
 * Get a tool-use flow context by stream ID.
 * Returns undefined if the entry is not a ToolUseFlowContext.
 */
export function getToolUseFlowContext(
  streamTabId: StreamTabId,
): ToolUseFlowContext<any> | undefined {
  const entry = registry.get(streamTabId);
  // Type guard: check if it's a ToolUseFlowContext (has 'session' property with appendFollowUp method)
  // This is more specific than checking 'services', which is shared by all BaseFlowContext subclasses
  if (
    entry &&
    'session' in entry &&
    typeof entry.session === 'object' &&
    entry.session !== null &&
    'appendFollowUp' in entry.session
  ) {
    return entry as ToolUseFlowContext<any>;
  }
  return undefined;
}

// ============================================================================
// Cleanup
// ============================================================================

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
