/**
 * Tool-use pipeline — replaces the 3 outer node classes
 * (ToolUsePrepareNode, ToolUseCycleNode, ToolUseWaitNode)
 * with plain async functions.
 *
 * The inner ToolUseCycleFlow (model invocation, tool dispatch, continuation)
 * is still a proper node graph — only the outer orchestration is flattened.
 */

import { STREAM_STATUS } from '@shared/schemas';
import type { TodoItem } from '@shared/schemas';
import { createRunState } from '@agent/core/AgentState';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import {
  createToolUseCycleFlow,
  createToolUseCycleShared,
} from '@agent/core/flows/ToolUseCycleFlow';
import { buildCycleServices } from '@agent/core/flows/CycleServices';
import { DELEGATION_TOOLS } from '@shared/constants/delegationTools';
import { StreamStatusService } from '@agent/runtime/StreamStatusService';
import { formatProviderHttpError } from '@common/errors';
import { buildInitialToolUsePrompts } from '@utils/prompt';
import { bus } from '@eventBus/ProgressEventBus';

import type { ToolUseServices } from './ToolUseServices';
import type { ToolUseRunShared, StateSlicesSnapshot } from './nodes/types';

// ---------------------------------------------------------------------------
// Step 1: Prepare (was ToolUsePrepareNode)
// ---------------------------------------------------------------------------

/**
 * Initialize the tool-use session. On snapshot resume, restores state and
 * skips the first cycle. On fresh start, builds prompts and messages.
 *
 * Mutates `shared` in place.
 */
export async function prepareToolUse<C>(
  shared: ToolUseRunShared,
  services: ToolUseServices<C>,
): Promise<void> {
  const { userVarChannels, logger, snapshot } = services;

  if (snapshot) {
    logger.debug('Resuming tool-use session from saved state.');
    const workspaceState = AgentWorkspaceState.fromSnapshot(snapshot.workspace);
    shared.messages = snapshot.messages;
    shared.shouldSkipCycle = true;
    shared.stateSlices = {
      runStateSnapshot: snapshot.run,
      workspaceSnapshot: workspaceState.toSnapshot(),
      userChannels: {
        input: Object.freeze({ ...snapshot.user.input }),
        transient: { ...snapshot.user.transient },
      },
    };
    services.onProgress?.({ kind: 'started' });
    return;
  }

  const runState = createRunState();
  const workspaceState = AgentWorkspaceState.create();
  const memoryEnabled = services.resolvedTools.some(
    (t) => t.name === 'memory',
  );
  const hasDelegationTools = services.resolvedTools.some((t) =>
    DELEGATION_TOOLS.has(t.name),
  );

  const { systemPrompt, userPrefix, userRequest, instructionSuffix } =
    await buildInitialToolUsePrompts(
      services.prompt,
      userVarChannels.transient,
      logger,
      {
        memoryEnabled,
        hasDelegationTools,
        isSubagent: services.isSubagent,
      },
    );

  const systemMessage = systemPrompt
    ? `${systemPrompt}\n${instructionSuffix}`
    : instructionSuffix;
  const messages = await services.modelHandler.initializeMessages(
    userPrefix,
    userRequest,
    undefined,
    systemMessage,
  );

  shared.messages = [...messages];
  shared.shouldSkipCycle = false;
  shared.stateSlices = {
    runStateSnapshot: runState,
    workspaceSnapshot: workspaceState.toSnapshot(),
    userChannels: userVarChannels,
  };

  services.onProgress?.({ kind: 'started' });
}

// ---------------------------------------------------------------------------
// Step 2: Run cycle (was ToolUseCycleNode)
// ---------------------------------------------------------------------------

type CycleOutcome =
  | { outcome: 'completed' }
  | { outcome: 'skipped' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; message: string; retryable?: boolean };

/**
 * Run one tool-use cycle (model call → tool dispatch loop).
 * Mutates `shared` in place. Returns the outcome for the caller to decide
 * whether to wait for a follow-up or finalize.
 */
export async function runToolUseCycle<C>(
  shared: ToolUseRunShared,
  services: ToolUseServices<C>,
): Promise<CycleOutcome> {
  const slices = shared.stateSlices;
  if (!slices) {
    throw new Error('PrepareNode must run before CycleNode');
  }

  const workspaceState = AgentWorkspaceState.fromSnapshot(
    slices.workspaceSnapshot,
  );
  const runState = slices.runStateSnapshot;
  const userChannels = slices.userChannels;

  // Handle skip (snapshot resume — just emit todos)
  if (shared.shouldSkipCycle) {
    if (workspaceState.todos.todos.length > 0) {
      bus.emit('updateTodos', {
        streamId: services.streamId,
        todos: workspaceState.todos.todos,
      });
    }
    shared.shouldSkipCycle = false;
    writeBackState(shared, runState, workspaceState, userChannels);
    return { outcome: 'skipped' };
  }

  const { streamId, setting, resolvedTools, config } = services;

  const cycleShared = createToolUseCycleShared(
    shared.messages,
    runState.totalRounds,
  );

  const flow = createToolUseCycleFlow<C>();
  flow.setServices(
    await buildCycleServices(services, {
      setting: { ...setting, tools: resolvedTools },
      run: runState,
      workspace: workspaceState,
      modelName: config.model,
      agentName: config.agent,
    }),
  );

  const { onProgress } = services;
  workspaceState.todos.setOnUpdate((todos: TodoItem[]) => {
    bus.emit('updateTodos', { streamId, todos });
    onProgress?.({ kind: 'todos', todos });
  });

  try {
    await flow.run(cycleShared);

    if (cycleShared.shouldStop && cycleShared.lastError) {
      writeBackState(shared, runState, workspaceState, userChannels);
      return {
        outcome: 'failed',
        message: cycleShared.lastError.message,
        retryable: cycleShared.lastError.retryable,
      };
    }
    if (cycleShared.shouldStop && !cycleShared.endTurn) {
      writeBackState(shared, runState, workspaceState, userChannels);
      return { outcome: 'cancelled' };
    }

    shared.messages = cycleShared.messages;
    writeBackState(shared, runState, workspaceState, userChannels);

    if (onProgress) {
      const { interactions } = workspaceState;
      const cost = runState.usageAccumulator.totals.totalCost;
      onProgress({
        kind: 'overview',
        toolCallCount: interactions.toolCallCount,
        filesChanged: interactions.editedFilePaths,
        cost: cost > 0 ? cost : undefined,
      });
    }

    return { outcome: 'completed' };
  } catch (error) {
    writeBackState(shared, runState, workspaceState, userChannels);
    const formatted = formatProviderHttpError(error);
    return {
      outcome: 'failed',
      message: error instanceof Error ? error.message : String(error),
      retryable: formatted.retryable,
    };
  } finally {
    workspaceState.todos.clearOnUpdate();
  }
}

// ---------------------------------------------------------------------------
// Step 3: Wait for follow-up (was ToolUseWaitNode)
// ---------------------------------------------------------------------------

type WaitOutcome =
  | { kind: 'continue'; followUp: string }
  | { kind: 'stop' };

/**
 * Wait for a user follow-up message. Returns `stop` if interrupted or
 * no follow-up arrives.
 */
export async function waitForFollowUp<C>(
  shared: ToolUseRunShared,
  services: ToolUseServices<C>,
): Promise<WaitOutcome> {
  const {
    checkInterruption,
    session,
    streamId,
    modelHandler,
    onBeforeWaiting,
    logger,
  } = services;

  if (checkInterruption()) {
    return { kind: 'stop' };
  }

  // Notify orchestrator before entering wait (subagent mode)
  if (onBeforeWaiting) {
    const lastResponse = findLastAssistantText(shared.messages, (m) =>
      modelHandler.extractAssistantText(m),
    );
    await onBeforeWaiting(lastResponse);
  }

  if (!session.hasQueuedFollowUp()) {
    StreamStatusService.set(streamId, STREAM_STATUS.WAITING);
  }

  try {
    const followUp = await session.waitForFollowUp(checkInterruption);
    if (!followUp || checkInterruption()) {
      return { kind: 'stop' };
    }
    return { kind: 'continue', followUp };
  } catch (error) {
    logger.error(
      `Wait for follow-up error: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { kind: 'stop' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeBackState(
  shared: ToolUseRunShared,
  runState: StateSlicesSnapshot['runStateSnapshot'],
  workspaceState: AgentWorkspaceState,
  userChannels: StateSlicesSnapshot['userChannels'],
): void {
  shared.stateSlices = {
    runStateSnapshot: runState,
    workspaceSnapshot: workspaceState.toSnapshot(),
    userChannels,
  };
}

function findLastAssistantText(
  messages: ToolUseRunShared['messages'],
  extractAssistantText: (
    message: ToolUseRunShared['messages'][number],
  ) => string | undefined,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractAssistantText(messages[i]);
    if (text !== undefined) return text;
  }
  return undefined;
}
