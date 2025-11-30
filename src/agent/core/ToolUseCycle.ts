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
import { bus } from '@eventBus/ProgressEventBus';

// Local file imports
import { AgentSharedStore } from './AgentSharedStore';
import {
  createToolUseCycleFlow,
  type ToolUseCycleShared,
  type ToolUseCycleState,
} from './flows/ToolUseCycleFlow';
import { createRetryState, type RetryCallbacks } from './flows/RetryState';

// Import and re-export from single source of truth
import type { ToolUseCycleOptions } from './flows/CycleServices';
export type { ToolUseCycleOptions };

export interface ToolUseCycleInput<C = unknown> {
  options: ToolUseCycleOptions<C>;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

export interface ToolUseCycleResult {
  /** Callbacks for triggering manual retry from UI. */
  retryCallbacks: RetryCallbacks;
}

/**
 * Executes a tool-use cycle for interactive agents.
 *
 * Tool-use cycles operate on messages in-place and continue until
 * user follow-up is required. They don't return a value because
 * control flow is managed by the interactive session lifecycle.
 *
 * This is used by BaseToolUseAgent for reactive, session-based execution
 * where the agent responds to tools and waits for user input.
 *
 * @param input - Cycle input with options, messages, and store
 * @returns Result with retry callbacks for UI to trigger manual retry
 * @see runResponseCycle for workflow-based cycle execution that returns control flags
 */
export async function runToolUseCycle<C = unknown>(
  input: ToolUseCycleInput<C>,
): Promise<ToolUseCycleResult> {
  // Initialize retry callbacks - these will be populated by RetryWaitNode
  // and can be called by the UI to trigger manual retry
  const retryCallbacks: RetryCallbacks = {};

  // Shared state contains only mutable data that flows through nodes.
  // Services (options, store) are injected via setParams().
  const shared: ToolUseCycleShared<C> = {
    state: {
      messages: input.messages,
      shouldStop: false,
      response: undefined,
      responseTime: undefined,
      toolCalls: undefined,
      text: undefined,
      stopReason: undefined,
    } satisfies ToolUseCycleState,
    retryState: createRetryState(),
    retryCallbacks,
  };

  const flow = createToolUseCycleFlow<C>();
  // Inject immutable services via params (PocketFlow pattern)
  flow.setParams({ services: { options: input.options, store: input.store } });
  await flow.run(shared);

  // Emit edited files to the progress view
  emitEditedFiles(input);

  return { retryCallbacks };
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
  const interactions = store.workspace.interactions.toJSON();

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
