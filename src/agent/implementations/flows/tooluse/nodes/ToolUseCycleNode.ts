import PQueue from 'p-queue';

import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import {
  createToolUseRoundFlow,
  type ToolUseRoundShared,
} from '@agent/core/flows/ToolUseRoundFlow';
import { withModelClient } from '@agent/core/flows/CycleServices';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { buildFailedRetryInfo } from '@common/errors';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type RetryErrorInfo,
  type RunOutcome,
} from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';

import {
  type ToolUseRunShared,
  type CyclePrepResult,
  assertPreparedShared,
} from './types';
import type { ToolUseServices } from '../ToolUseServices';

type ToolUseCycleOutcome =
  | { outcome: 'completed'; messages: ProviderMessage[] }
  | { outcome: 'skipped' }
  | { outcome: 'cancelled' }
  | { outcome: 'failed'; lastError: RetryErrorInfo };

export class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<CyclePrepResult> {
    assertPreparedShared(shared);

    return {
      shouldSkipCycle: shared.shouldSkipCycle,
      messages: shared.messages,
      runState: shared.stateSlices.runStateSnapshot,
      // stateSlices.workspaceSnapshot was produced by this same node's own
      // toSnapshot() last round (or by ToolUsePrepareNode's one-time
      // hydration) — never raw persisted/legacy data — so re-deriving it
      // here uses the canonical-only path (see AgentWorkspaceState.fromCanonicalSnapshot).
      workspaceState: AgentWorkspaceState.fromCanonicalSnapshot(
        shared.stateSlices.workspaceSnapshot,
      ),
      userChannels: shared.stateSlices.userChannels,
      systemPrompt: shared.systemPrompt,
    };
  }

  async exec(prepRes: CyclePrepResult): Promise<ToolUseCycleOutcome> {
    const { modelHandler, runScope } = this.services;
    const { streamId } = runScope;

    if (prepRes.shouldSkipCycle) {
      const { todos, plan } = prepRes.workspaceState.workPlan;
      if (todos.length) {
        emitRunFact(this.services.logger, 'updateTodos', { streamId, todos });
      }
      if (plan) {
        emitRunFact(this.services.logger, 'updatePlan', { streamId, plan });
      }
      return { outcome: 'skipped' };
    }

    const finalTool =
      modelHandler.supportsForcedToolChoice &&
      this.services.setting.tools.length === 1 &&
      this.services.setting.tools[0]?.name === this.services.finalTool?.name
        ? this.services.finalTool
        : undefined;

    const roundShared: ToolUseRoundShared = {
      messages: prepRes.messages,
      shouldStop: false,
      endTurn: false,
      roundIndex: prepRes.runState.totalRounds,
      roundResponseTimeMs: 0,
      systemPrompt: prepRes.systemPrompt,
      currentUserInstruction:
        typeof prepRes.userChannels.transient.INSTRUCTION === 'string'
          ? prepRes.userChannels.transient.INSTRUCTION
          : undefined,
      finalTool,
      finalToolAttempted: finalTool !== undefined,
    };

    const flow = createToolUseRoundFlow<C>();
    flow.setServices(
      await withModelClient(
        {
          ...this.services,
          run: prepRes.runState,
          workspace: prepRes.workspaceState,
        },
        modelHandler,
      ),
    );

    const { onProgress, persistTodos } = this.services;
    const todoPersistQueue = new PQueue({ concurrency: 1 });
    prepRes.workspaceState.workPlan.setOnUpdate({
      onTodosUpdate: (todos) => {
        emitRunFact(this.services.logger, 'updateTodos', { streamId, todos });
        if (persistTodos) {
          void todoPersistQueue.add(async () => {
            try {
              await persistTodos(todos);
            } catch (err: unknown) {
              // Best-effort todo persistence — log so swallowed write
              // failures are diagnosable without disrupting the update
              // stream.
              this.services.logger.debug('Failed to persist todos', {
                data: err,
              });
            }
          });
        }
        onProgress?.({ kind: 'todos', todos });
      },
      onPlanUpdate: (plan) => {
        emitRunFact(this.services.logger, 'updatePlan', { streamId, plan });
        onProgress?.({ kind: 'plan', plan });
      },
    });

    const roundStage = this.services.logger.openStage(
      `r${roundShared.roundIndex}`,
      {
        kind: 'round',
        index: roundShared.roundIndex,
      },
    );

    let roundOutcome: RunOutcome = RUN_OUTCOME.FAILED;
    try {
      await roundStage.within(() => flow.run(roundShared));

      const lastError = roundShared.shouldStop
        ? roundShared.lastError
        : undefined;
      roundOutcome = deriveRunOutcome({
        failed: lastError !== undefined,
        cancelled: roundShared.shouldStop && !roundShared.endTurn,
      });

      if (lastError) {
        return {
          outcome: 'failed',
          lastError,
        };
      }
      if (roundOutcome === RUN_OUTCOME.CANCELLED) {
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed', messages: roundShared.messages };
    } finally {
      roundStage.end(roundOutcome);
      if (roundShared.currentUserInstruction !== undefined) {
        prepRes.userChannels.transient.INSTRUCTION =
          roundShared.currentUserInstruction;
      }
      prepRes.workspaceState.workPlan.clearOnUpdate();
      // Drain in-flight persist writes before returning so they don't
      // race with the projection's writeTodos after this node completes.
      await todoPersistQueue.onIdle();
    }
  }

  async execFallback(
    _prepRes: CyclePrepResult,
    error: Error,
  ): Promise<ToolUseCycleOutcome> {
    const { lastError } = buildFailedRetryInfo(error);
    this.services.logger.error(lastError.message, {
      messageType: MESSAGE_TYPES.ERROR,
    });
    return { outcome: 'failed', lastError };
  }

  async post(
    shared: ToolUseRunShared,
    prepRes: CyclePrepResult,
    execRes: ToolUseCycleOutcome,
  ): Promise<string | undefined> {
    if (prepRes.shouldSkipCycle) {
      shared.shouldSkipCycle = false;
    }

    const workspaceSnapshot = prepRes.workspaceState.toSnapshot({
      excludeAssemblyStrings: true,
    });
    shared.stateSlices = {
      runStateSnapshot: prepRes.runState,
      workspaceSnapshot,
      userChannels: prepRes.userChannels,
    };
    shared.lastResponse =
      prepRes.workspaceState.assembly.lastResponse || shared.lastResponse;

    if (execRes.outcome === 'completed') {
      const { interactions } = prepRes.workspaceState;
      const cost = prepRes.runState.usageAccumulator.totals.totalCost;
      this.services.onProgress?.({
        kind: 'overview',
        toolCallCount: interactions.toolCallCount,
        filesChanged: interactions.editedFilePaths,
        cost: cost > 0 ? cost : undefined,
      });
    }

    // All outcomes continue to WaitNode (FlowTransition.DEFAULT).
    // Tool-use agents are conversational — the user can send a
    // follow-up to retry after a failure, unlike workflows.
    switch (execRes.outcome) {
      case 'completed': {
        shared.messages = execRes.messages;
        const structured = this.services.getPendingStructuredOutput?.();
        if (structured !== undefined) shared.structured = structured;
        break;
      }
      case 'skipped':
        break;
      case 'failed':
        // Inner invocation failures are logged by RetryState. This boundary
        // logs only exceptions converted by execFallback above.
        shared.lastError = execRes.lastError;
        break;
      case 'cancelled':
        shared.userCancelledRetry = true;
        break;
    }

    return FlowTransition.DEFAULT;
  }
}
