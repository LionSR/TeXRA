/**
 * Shared terminal-result construction for native subagent strategies
 * (tool-use and workflow). The typed result owns workflow diff construction;
 * XML formatting is a separate boundary operation over that same result.
 */

import {
  buildAgentFinalResult,
  type AgentFinalResult,
} from '@agent/runtime/AgentFinalResult';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';

import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  computeAndWriteWorkflowDiffs,
  type DiffFileInfo,
} from './subagentDiffs';
import {
  buildSubagentResultMeta,
  formatSubagentDelivery,
  type SubagentResultMeta,
} from './subagentResults';

const LOG_CHANNEL = 'subagentDelivery';

export interface BuiltSubagentResult {
  readonly result: AgentFinalResult;
  readonly resultMeta: SubagentResultMeta;
  readonly wallTimeMs: number;
}

/**
 * Build a subagent's typed terminal result and persistence record.
 * For workflow results, computes latexdiffs and writes them as files to the
 * execution's run directory first — the delivery references diff file paths
 * so the orchestrator can read them on demand via /executions/{id}/files/.
 */
export async function buildSubagentResult(
  executionId: ExecutionId,
  agentName: string,
  result: AgentFlowResult,
  options: {
    readonly startedAt: number;
    readonly parentExecutionId?: ExecutionId;
  },
): Promise<BuiltSubagentResult> {
  let diffInfos: Map<string, DiffFileInfo> | undefined;
  let diffsUnavailable: string | undefined;
  if (result.category === 'workflow' && result.outputs.length > 0) {
    try {
      diffInfos = await computeAndWriteWorkflowDiffs(
        executionId,
        result.outputs,
      );
    } catch (err) {
      // Diff computation failure is non-fatal: deliver without diffs, but tell
      // the orchestrator to read the output files directly.
      diffsUnavailable = toErrorMessage(err);
      logger.warn(
        LOG_CHANNEL,
        `Diff computation failed for ${executionId}: ${diffsUnavailable}`,
      );
    }
  }

  const wallTimeMs = Date.now() - options.startedAt;
  const diffs =
    result.category === 'workflow' && diffInfos
      ? result.outputs.flatMap((output) => {
          const diff = diffInfos.get(output.absolutePath);
          return diff ? [{ path: output.absolutePath, ...diff }] : [];
        })
      : undefined;
  const finalResult = buildAgentFinalResult({
    flowResult: result,
    diffs,
    diffsUnavailable,
    structured: result.category === 'toolUse' ? result.structured : undefined,
  });
  return {
    result: finalResult,
    resultMeta: buildSubagentResultMeta(agentName, finalResult, wallTimeMs, {
      parentExecutionId: options.parentExecutionId,
    }),
    wallTimeMs,
  };
}

/** Build the model-facing XML only at the follow-up/tool-result boundary. */
export function formatBuiltSubagentDelivery(
  executionId: ExecutionId,
  agentName: string,
  result: AgentFlowResult,
  built: BuiltSubagentResult,
  workingDirectory?: string,
): string {
  return formatSubagentDelivery(agentName, built.result, {
    executionId,
    memoryMisses: result.memoryMisses,
    wallTimeMs: built.wallTimeMs,
    workingDirectory,
  });
}
