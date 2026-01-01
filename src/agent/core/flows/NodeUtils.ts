/**
 * Utility functions for flow nodes to reduce duplication.
 *
 * These utilities consolidate common patterns found across ResponseCycleFlow
 * and ToolUseCycleFlow nodes.
 */

import { maybeSaveDebugObject } from '@agent/utils/debugMessageSaver';
import type { DebugObjectType } from '@agent/utils/debugMessageSaver';
import type { CycleDebugContext, CycleDebugFileOptions } from './CommonCycleTypes';

/**
 * Options for debug saving, used when debug info is available.
 */
export interface DebugInfo {
  context: CycleDebugContext;
  fileOptions: CycleDebugFileOptions;
}

/**
 * Safely check for interruption with optional skip condition.
 *
 * Consolidates the duplicate interruption check patterns found in:
 * - ResponsePrepNode
 * - ToolUsePrepNode
 * - ResponseContinuationNode
 * - ToolUseDispatchNode
 *
 * @param checkFn - Function that checks for interruption (can be sync or async)
 * @param shouldSkip - Optional condition to skip the check (avoids unnecessary I/O)
 * @returns true if interrupted, false otherwise (always false if shouldSkip is true)
 *
 * @example
 * // Simple check (always runs)
 * const interrupted = await checkInterruptionSafely(() => services.checkInterruption());
 *
 * @example
 * // Conditional check (only runs if not already skipping)
 * const shouldSkip = state.shouldStop || !state.toolCalls;
 * const interrupted = await checkInterruptionSafely(
 *   () => services.checkInterruption(),
 *   shouldSkip
 * );
 */
export async function checkInterruptionSafely(
  checkFn: () => unknown | Promise<unknown>,
  shouldSkip?: boolean,
): Promise<boolean> {
  // If shouldSkip is true or undefined (default to skip when not provided as boolean),
  // we skip the check. This matches the pattern: `!shouldSkip && Boolean(await checkInterruption())`
  if (shouldSkip) {
    return false;
  }

  return Boolean(await checkFn());
}

/**
 * Save debug object if debug info is available.
 *
 * Consolidates the duplicate debug saving patterns found in:
 * - ResponsePrepNode
 * - ResponseModelInvocationNode
 * - ToolUsePrepNode
 * - ToolUseCallNode
 *
 * This function handles both patterns:
 * 1. Conditional save (when debugInfo might be undefined)
 * 2. Direct save (when debugInfo is always present)
 *
 * @param object - The object to save (messages array or response object)
 * @param objectType - Type of object for file naming ('messages' or 'response')
 * @param debugInfo - Optional debug context and file options
 *
 * @example
 * // Conditional save (debugInfo may be undefined)
 * await saveDebugIfAvailable(state.messages, 'messages', state.debug);
 *
 * @example
 * // Direct save (debugInfo always present)
 * await saveDebugIfAvailable(
 *   successRes.response,
 *   'response',
 *   { context: successRes.debugContext, fileOptions: successRes.debugFileOptions }
 * );
 */
export async function saveDebugIfAvailable(
  object: unknown,
  objectType: DebugObjectType,
  debugInfo?: DebugInfo,
): Promise<void> {
  if (!debugInfo) {
    return;
  }

  await maybeSaveDebugObject({
    object,
    objectType,
    context: debugInfo.context,
    fileOptions: debugInfo.fileOptions,
  });
}
