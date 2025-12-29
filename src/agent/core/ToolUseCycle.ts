/**
 * @file ToolUseCycle.ts
 *
 * Tool-use cycle execution for interactive agents.
 *
 * Operates on messages in-place and continues until user follow-up is required.
 * Used by BaseToolUseAgent for reactive, session-based execution.
 *
 * @see ResponseCycle for workflow-based cycle execution
 */

// Standard library imports
import * as path from 'path';

// Local imports - agent components
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { OutputFileInfo } from '@agent/output/types';
import { pathToLocation } from '@utils/files';
import type { TodoItem } from '@eventBus/schemas';
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
  type ToolUseCycleState,
} from './flows/ToolUseCycleFlow';
import { createRetryState } from './flows/RetryState';
import { interpretCycleCompletion } from './flows/CommonCycleTypes';
import type { FileInteractionStateSnapshot } from './AgentWorkspaceState';

// Import and re-export from single source of truth
import type { ToolUseCycleOptions } from './flows/CycleServices';
export type { ToolUseCycleOptions };

export interface ToolUseCycleInput<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

export interface ToolUseCycleResult {
  /** True if the cycle stopped due to an error (not user cancellation). */
  failedWithError: boolean;
  /** Error message if failedWithError is true. */
  errorMessage?: string;
  /** True if the user cancelled the retry wait (should stop gracefully). */
  userCancelled: boolean;
}

/**
 * Executes a tool-use cycle for interactive agents.
 *
 * Tool-use cycles operate on messages in-place and continue until
 * user follow-up is required or an error/cancellation occurs.
 *
 * This is used by BaseToolUseAgent for reactive, session-based execution
 * where the agent responds to tools and waits for user input.
 *
 * @param input - Cycle input with options, messages, and store
 * @returns Result with failedWithError and userCancelled flags
 * @see runResponseCycle for workflow-based cycle execution
 */
export async function runToolUseCycle<C = unknown>(
  input: ToolUseCycleInput<C>,
): Promise<ToolUseCycleResult> {
  const { options, store } = input;
  const { context } = options;

  // Set up todo update callback to emit changes to the progress view
  // This callback is invoked when the todo_write tool updates todos
  store.workspace.todos.setOnUpdate((todos: TodoItem[]) => {
    bus.emit('updateTodos', {
      stream: context.streamId,
      executionId: context.executionId,
      todos,
    });
  });

  // Shared state contains only mutable data that flows through nodes.
  // Services (options, store) are injected via setParams().
  const shared: ToolUseCycleShared = {
    state: {
      messages: input.messages,
      shouldStop: false,
      response: undefined,
      responseTimeMs: undefined,
      toolCalls: undefined,
      text: undefined,
      stopReason: undefined,
      endTurn: false, // Will be set to true if cycle completes normally
    } satisfies ToolUseCycleState,
    retryState: createRetryState(),
  };

  const flow = createToolUseCycleFlow<C>();
  // Inject immutable services via params (PocketFlow pattern)
  flow.setParams({
    services: { options: input.options, store: input.store },
  });

  try {
    await flow.run(shared);
  } finally {
    // Clear the todo update callback to prevent memory leaks
    // The callback holds references to context that would otherwise be GC'd
    store.workspace.todos.clearOnUpdate();
  }

  // Emit edited files to the progress view
  emitEditedFiles(input);

  // Interpret cycle completion - shared logic with ResponseCycle
  return interpretCycleCompletion(shared.state, shared.retryState);
}

/**
 * Emits edited files from tool-use cycle to the progress view.
 * Converts tracked file edits into OutputFileInfo format and emits
 * them via the event bus so they appear in the "Generated files" section.
 *
 * For tool-use agents, we emit a simple file list without lineage or diff
 * stats since there's no meaningful base file to compare against.
 *
 * ## Storage Key for Tool-Use Agents
 * Tool-use agents use context.storageKey which equals their executionId
 * (since they don't create task groups). This is computed once at execution
 * start and used consistently across all storage operations.
 *
 * @see ExecutionIdentity for the unified identity model
 */
function emitEditedFiles<C>(input: ToolUseCycleInput<C>): void {
  const { options, store } = input;
  const interactions: FileInteractionStateSnapshot =
    store.workspace.interactions.toSnapshot();

  if (interactions.edits.length === 0) {
    return;
  }

  const { context } = options;
  const stream = context.streamId;
  const storageKey = context.storageKey;
  const executionId = context.executionId;
  const roundIndex = store.round.roundIndex;

  // Deduplicate by path in case the same file was edited multiple times
  const uniquePaths = [...new Set(interactions.edits.map((e) => e.path))];
  const fileInfos: OutputFileInfo[] = uniquePaths.map((editPath) => ({
    source: path.basename(editPath),
    location: pathToLocation(editPath),
    lineage: null,
    diff: null,
  }));

  bus.emit('addOutputFiles', {
    stream,
    storageKey,
    executionId,
    filesByRound: { [roundIndex]: fileInfos },
  });

  options.logger.debug(
    `addOutputFiles emitted for tool-use round ${roundIndex}: ${fileInfos.length} files`,
  );
}
