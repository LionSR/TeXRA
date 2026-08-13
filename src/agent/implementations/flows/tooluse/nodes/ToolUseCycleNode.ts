import { Node } from '@agent/node';
import { FlowTransition } from '@agent/core/flows/FlowTransitions';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import { AgentWorkspaceState } from '@agent/core/state/AgentWorkspaceState';
import { createToolUseRoundFlow } from '@agent/core/flows/ToolUseRoundFlow';
import type { ToolUseRoundShared } from '@agent/core/flows/toolUseRound/roundShared';
import type { ProviderMessage } from '@agent/types/ProviderMessage';
import { USER_VAR_INSTRUCTION } from '@agent/utils/userVars';
import { buildFailedRetryInfo } from '@common/errors/sdkError/providerErrorFormat';
import {
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type RetryErrorInfo,
  type RunOutcome,
} from '@shared/schemas';
import { deriveRunOutcome } from '@shared/streams/streamStatus';

import type { ToolUseRunShared, CyclePrepResult } from './types';
import type { ToolUseServices } from '../ToolUseServices';

type ToolUseCycleOutcome =
  | {
      outcome: 'completed';
      messages: ProviderMessage[];
      response?: string;
    }
  | { outcome: 'skipped' }
  | { outcome: 'cancelled'; response?: string }
  | { outcome: 'failed'; lastError: RetryErrorInfo; response?: string };

export class ToolUseCycleNode<C> extends Node<
  ToolUseRunShared,
  ToolUseServices<C>
> {
  async prep(shared: ToolUseRunShared): Promise<CyclePrepResult> {
    if (shared.stateSlices === null) {
      throw new Error('PrepareNode must run before CycleNode');
    }

    // stateSlices.workspaceSnapshot was produced by this same node's own
    // toSnapshot() last round (or by ToolUsePrepareNode's one-time
    // hydration) — never raw persisted/legacy data — so re-deriving it
    // here uses the canonical-only path (see AgentWorkspaceState.fromCanonicalSnapshot).
    const workspaceState = AgentWorkspaceState.fromCanonicalSnapshot(
      shared.stateSlices.workspaceSnapshot,
    );
    return {
      shouldSkipCycle: shared.shouldSkipCycle,
      messages: shared.messages,
      runState: shared.stateSlices.runStateSnapshot,
      workspaceState,
      cycleStartLastResponse: workspaceState.assembly.lastResponse,
      userChannels: shared.stateSlices.userChannels,
      systemPrompt: shared.systemPrompt,
    };
  }

  async exec(prepRes: CyclePrepResult): Promise<ToolUseCycleOutcome> {
    const { runScope } = this.services;
    const modelHandler = this.services.modelCell.handler;
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

    // A cycle is one user turn. Scrub any assembly strings accepted from a
    // persisted snapshot before model work starts, but never between this
    // cycle's tool rounds where they carry continuation state.
    prepRes.workspaceState.assembly.lastResponse = '';
    prepRes.workspaceState.assembly.accumulatedOutput = '';

    const finalTool =
      modelHandler.supportsForcedToolChoice &&
      this.services.setting.tools.length === 1 &&
      this.services.setting.tools[0]?.name === this.services.finalTool?.name
        ? this.services.finalTool
        : undefined;

    const instruction = prepRes.userChannels.transient[USER_VAR_INSTRUCTION];
    const roundShared: ToolUseRoundShared = {
      messages: prepRes.messages,
      shouldStop: false,
      endTurn: false,
      roundIndex: prepRes.runState.totalRounds,
      roundResponseTimeMs: 0,
      systemPrompt: prepRes.systemPrompt,
      currentUserInstruction:
        typeof instruction === 'string' ? instruction : undefined,
      finalTool,
      finalToolAttempted: finalTool !== undefined,
    };

    const flow = createToolUseRoundFlow<C>();
    // The spread copies the model cell by reference, so the round's nodes read
    // the handler and provider client the run is live on rather than a copy
    // taken when the round started.
    flow.setServices({
      ...this.services,
      run: prepRes.runState,
      workspace: prepRes.workspaceState,
    });

    const { onProgress } = this.services;
    prepRes.workspaceState.workPlan.setOnUpdate({
      onTodosUpdate: (todos) => {
        emitRunFact(this.services.logger, 'updateTodos', { streamId, todos });
        onProgress?.({ kind: 'todos', todos });
      },
      onPlanUpdate: (plan) => {
        emitRunFact(this.services.logger, 'updatePlan', { streamId, plan });
        onProgress?.({ kind: 'plan', plan });
      },
    });

    // This outer cycle is one session turn that may contain many model/tool
    // rounds. Keep it as a structural stage; only the inner invocations advance
    // runState.totalRounds, so classifying this span as round progress leaves a
    // stale badge that jumps by the hidden invocation count on the next turn.
    const sessionStage = this.services.logger.openStage('Tool-use turn', {
      kind: 'session',
    });

    let roundOutcome: RunOutcome = RUN_OUTCOME.FAILED;
    try {
      await sessionStage.within(() => flow.run(roundShared));

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
          response: roundShared.latestAssistantText,
        };
      }
      if (roundOutcome === RUN_OUTCOME.CANCELLED) {
        return {
          outcome: 'cancelled',
          response: roundShared.latestAssistantText,
        };
      }
      return {
        outcome: 'completed',
        messages: roundShared.messages,
        response: roundShared.latestAssistantText,
      };
    } catch (error) {
      // A later round can fail after an earlier tool round produced text. Carry
      // that structurally tracked text into execFallback unless the failing
      // round already left a newer partial response in assembly.
      if (
        !prepRes.workspaceState.assembly.lastResponse &&
        roundShared.latestAssistantText
      ) {
        prepRes.workspaceState.assembly.lastResponse =
          roundShared.latestAssistantText;
      }
      throw error;
    } finally {
      sessionStage.end(roundOutcome);
      if (roundShared.currentUserInstruction !== undefined) {
        prepRes.userChannels.transient[USER_VAR_INSTRUCTION] =
          roundShared.currentUserInstruction;
      }
      prepRes.workspaceState.workPlan.clearOnUpdate();
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
    const assemblyResponse = prepRes.workspaceState.assembly.lastResponse;
    const cycleResponse =
      execRes.outcome === 'skipped'
        ? undefined
        : (execRes.response ??
          // The assembly fallback exists for text written during THIS cycle
          // (the failure-path copy in exec). A value unchanged since prep is
          // a previous turn's response — an answerless cycle must not return
          // it as its result (#9531).
          (assemblyResponse !== prepRes.cycleStartLastResponse
            ? assemblyResponse
            : undefined));
    shared.lastResponse = cycleResponse;
    if (cycleResponse) {
      this.services.onCycleResponse?.(cycleResponse);
    }

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
