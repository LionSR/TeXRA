/**
 * Shared terminal-result formatting for native subagent strategies
 * (tool-use and workflow): compute workflow diffs (when applicable), then
 * format both the delivery XML and the structured result manifest from the
 * same diff pass so neither strategy pays for diff computation twice.
 */

import type { ResultMeta } from '@agent/storage';
import { buildAgentFinalResult } from '@agent/runtime/AgentFinalResult';
import type { AgentFlowResult } from '@agent/runtime/AgentFlowResult';
import * as logger from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';

import {
  computeAndWriteWorkflowDiffs,
  type DiffFileInfo,
} from '@tools/subagentDiffs';
import {
  buildSubagentResultMeta,
  formatSubagentDelivery,
} from '@tools/subagentResults';
import { toErrorMessage } from '@utils/errors/errorMessage';

const LOG_CHANNEL = 'subagentDelivery';

/**
 * Format a subagent result for delivery to the orchestrator.
 * For workflow results, computes latexdiffs and writes them as files to the
 * execution's run directory first — the delivery references diff file paths
 * so the orchestrator can read them on demand via /executions/{id}/files/.
 */
export async function subagentDeliveryMessage(
  executionId: ExecutionId,
  agentName: string,
  result: AgentFlowResult,
  options: {
    readonly startedAt: number;
    readonly workingDirectory?: string;
  },
): Promise<{ msg: string; resultMeta: ResultMeta }> {
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
  });
  return {
    msg: formatSubagentDelivery(agentName, finalResult, {
      executionId,
      memoryMisses: result.memoryMisses,
      wallTimeMs,
      workingDirectory: options.workingDirectory,
    }),
    resultMeta: buildSubagentResultMeta(agentName, finalResult, wallTimeMs),
  };
}
