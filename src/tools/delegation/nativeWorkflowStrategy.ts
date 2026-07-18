/**
 * Native workflow child-run strategy over the shared `childRunLoop`.
 * Terminal-only: workflow flows have no WAITING boundary, so `launch` is the
 * whole run and every turn is terminal. No `runTurn` — the loop never calls
 * it for a strategy whose first turn always reports terminal.
 */

import type { ResultMeta } from '@agent/storage';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import { executeAgent } from '@agent/runtime/executeAgent';
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentRunHandle } from '@agent/runtime/ExecutionHandle';
import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

import {
  buildSubagentFailureResultMeta,
  formatSubagentError,
} from '@tools/subagentResults';
import { subagentDeliveryMessage } from './subagentDeliveryFormat';

export interface NativeWorkflowStrategyParams {
  readonly configPayload: AgentConfigPayload;
  readonly executionId: ExecutionId;
  readonly agentName: string;
  readonly orchestratorStreamId: StreamTabId;
  readonly parentSession: SessionHandle;
  readonly runtimeHost: AgentRuntimeHost;
  readonly startedAt: number;
  readonly workingDirectory?: string;
  readonly approvalPromptsUnavailable?: boolean;
  readonly runtimeUnavailableTools?: readonly string[];
  readonly onStreamResolved: (streamId: StreamTabId) => void;
}

export function createNativeWorkflowStrategy(
  params: NativeWorkflowStrategyParams,
): ChildRunStrategy<AgentFlowResult> {
  let runHandle: AgentRunHandle | undefined;
  let lastErr: unknown;
  let cachedDelivery: { msg: string; resultMeta: ResultMeta } | undefined;

  const resolveDeliveryTarget = (): StreamTabId | undefined =>
    runHandle ? runHandle.deliveryTargetStreamId : params.orchestratorStreamId;

  const buildDelivery = async (
    turn: AgentFlowResult,
  ): Promise<{ msg: string; resultMeta: ResultMeta }> => {
    cachedDelivery ??= await subagentDeliveryMessage(
      params.executionId,
      params.agentName,
      turn,
      {
        startedAt: params.startedAt,
        workingDirectory: params.workingDirectory,
      },
    );
    return cachedDelivery;
  };

  return {
    stageLabel: 'Native workflow subagent',

    launch: async (ports) => {
      const result = await executeAgent(
        params.configPayload,
        params.executionId,
        {
          runtimeHost: params.runtimeHost,
          session: params.parentSession,
          isSubagent: true,
          enforceCategory: true,
          parentStreamId: params.orchestratorStreamId,
          approvalPromptsUnavailable: params.approvalPromptsUnavailable,
          runtimeUnavailableTools: params.runtimeUnavailableTools,
          onStreamResolved: params.onStreamResolved,
          onProgress: (update) => ports.notify(update),
          onRunError: (err) => {
            lastErr = err;
          },
          onRun: (handle) => {
            runHandle = handle;
          },
        },
      );
      // The run's total cost to date (including nested subagents), not a
      // per-turn delta — the loop commits the latest value to the parent
      // exactly once, when the child's run ends.
      ports.recordCost(result.totalCostUsd);
      return result;
    },

    isTerminal: () => true,
    isTurnError: () => lastErr !== undefined,

    resolveDeliveryTarget,

    formatDelivery: async (turn) => (await buildDelivery(turn)).msg,

    formatError: (turn, err) =>
      formatSubagentError(
        params.executionId,
        params.agentName,
        lastErr ?? err,
        {
          wallTimeMs: Date.now() - params.startedAt,
          workingDirectory: params.workingDirectory,
          memoryMisses: turn?.memoryMisses,
        },
      ),

    buildResultMeta: async (turn, isError) => {
      if (isError || turn === null) {
        return buildSubagentFailureResultMeta(
          params.agentName,
          'workflow',
          turn ?? undefined,
          Date.now() - params.startedAt,
        );
      }
      return (await buildDelivery(turn)).resultMeta;
    },
  };
}
