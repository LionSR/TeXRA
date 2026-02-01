// Shared imports
import { sortStreams } from '@shared/streams/streamSort';
import {
  isToolUseState,
  isWorkflowState,
  type ProgressState,
  type ToolUseStreamState,
  type WorkflowStreamState,
} from './store';
import type {
  InstructionUpdate,
  LogMessageData,
  OutputFileInfo,
  StreamTabId,
  StreamTabInfo,
  TaskGroup,
} from '@shared/schemas';

// Local imports
import type { FrontendEventHandlerContext } from './eventHandlers';

/**
 * Updates a nested Record<runId, Record<round, T[]>> structure.
 * Handles reset semantics: full reset, run-specific reset, or merge.
 */
export function updateNestedRounds<T>(
  current: Record<string, Record<string, T[]>>,
  update: { runId?: string; rounds?: Record<string, T[]>; reset?: boolean },
): Record<string, Record<string, T[]>> {
  const { runId, rounds, reset } = update;

  // Full reset - clear all runs
  if (reset && !runId) return {};

  // No target run - no change
  if (!runId) return current;

  // Reset specific run without new data - remove this run
  if (reset && !rounds) {
    const { [runId]: _, ...rest } = current;
    return rest;
  }

  // No rounds data - no change
  if (!rounds) return current;

  // Merge rounds into the run
  const base = reset ? { ...current } : current;
  const existingRounds = reset ? {} : (base[runId] ?? {});
  return {
    ...base,
    [runId]: { ...existingRounds, ...rounds },
  };
}

/**
 * Get filtered streams based on current filter setting.
 */
export function getFilteredStreams(state: ProgressState): StreamTabInfo[] {
  const sorted = sortStreams(state.streams, state.streamSort);
  if (state.streamFilter === 'all') return sorted;
  return sorted.filter((stream) => stream.agentCategory === state.streamFilter);
}

/** Run group info for the run selector */
export interface RunGroup {
  id: string;
  name: string;
  startTime: number;
}

/**
 * Extract run groups from task groups for the run selector.
 * Returns root groups (runs) with their metadata.
 * Uses a single pass to avoid extra array allocations from filter().map().
 */
export function getRunGroups(groups: TaskGroup[]): RunGroup[] {
  const result: RunGroup[] = [];
  for (const group of groups) {
    if (!group.parentGroupId) {
      result.push({
        id: group.id,
        name: group.name,
        startTime: group.startTime,
      });
    }
  }
  return result;
}

/**
 * Check if any output files exist in the run files record.
 * Returns true as soon as a non-empty array is found.
 * More efficient than Object.values().flat().length > 0 which allocates arrays.
 */
export function hasOutputFiles(
  runFiles: Record<string, OutputFileInfo[]> | undefined,
): boolean {
  if (!runFiles) return false;
  for (const key in runFiles) {
    if (Object.hasOwn(runFiles, key)) {
      const files = runFiles[key];
      if (files && files.length > 0) return true;
    }
  }
  return false;
}

/**
 * Prepend instruction as a userMessage for tool-use agents if not already present.
 * Tool-use agents may not have their initial instruction in the message stream,
 * so we inject it as a synthetic userMessage for display consistency.
 *
 * @param messages - The log messages to potentially prepend to (will be mutated if needed)
 * @param runInstructions - The run instructions record
 * @param streamId - The stream ID for generating a unique message ID
 * @returns The same messages array (possibly with instruction prepended)
 */
export function prependInstructionForToolUse(
  messages: LogMessageData[],
  runInstructions: Record<string, InstructionUpdate> | null | undefined,
  streamId: string | null | undefined,
): LogMessageData[] {
  if (messages.length === 0) return messages;

  const firstMsg = messages[0];
  const hasUserMessageFirst = firstMsg.messageType === 'userMessage';
  if (hasUserMessageFirst || !runInstructions) return messages;

  const instruction = Object.values(runInstructions)[0];
  if (!instruction?.text) return messages;

  const timestamp =
    instruction.timestamp ?? (firstMsg.timestamp ?? Date.now()) - 1;

  messages.unshift({
    id: `compat-instruction-${streamId ?? 'unknown'}`,
    messageType: 'userMessage',
    text: instruction.text,
    timestamp,
    level: 'info',
  });

  return messages;
}

// =============================================================================
// Typed State Updaters
// =============================================================================

/**
 * Update tool-use stream state with type narrowing.
 * If the stream is not a tool-use stream, returns previous state unchanged.
 */
export function updateToolUseState(
  ctx: FrontendEventHandlerContext,
  stream: StreamTabId,
  updater: (prev: ToolUseStreamState) => ToolUseStreamState,
): void {
  ctx.setStreamState(stream, (prev) => {
    if (!isToolUseState(prev)) return prev;
    return updater(prev);
  });
}

/**
 * Update workflow stream state with type narrowing.
 * If the stream is not a workflow stream, returns previous state unchanged.
 */
export function updateWorkflowState(
  ctx: FrontendEventHandlerContext,
  stream: StreamTabId,
  updater: (prev: WorkflowStreamState) => WorkflowStreamState,
): void {
  ctx.setStreamState(stream, (prev) => {
    if (!isWorkflowState(prev)) return prev;
    return updater(prev);
  });
}
