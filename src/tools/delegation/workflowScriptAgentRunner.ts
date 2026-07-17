// Local imports - agent runtime and shared utilities
import { resolveChildRunOutput } from '@agent/storage';
import {
  WorkflowRunAbortError,
  type WorkflowAgentInvocation,
  type WorkflowAgentRunner,
} from '@agent/workflowScript';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { formatError } from '@common/errors';
import { AgentCategory } from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { deriveExecutionId } from '@utils/core/idHash';
import { runStorageLocationFromAnyAbsolutePath } from '@utils/files/taskRunStorage';

// Local imports - delegation
import {
  executeStableSubagentInBand,
  SubagentDurabilityError,
} from './inBandSubagentExecution';
import {
  requireVisibleAgent,
  selectAvailableDelegationModel,
} from './proposalFlow';
import { assertWorkflowFilesExist } from './workflowFileValidation';

function workflowChildExecutionId(
  parentExecutionId: LaunchRunContext['runScope']['executionId'],
  checkpointId: string,
  key: string,
): LaunchRunContext['runScope']['executionId'] {
  return deriveExecutionId({ checkpointId, key, parentExecutionId });
}

async function resolveInvocationInputFiles(
  parentExecutionId: LaunchRunContext['runScope']['executionId'],
  files: readonly string[],
): Promise<string[]> {
  const references = files.map((file) => ({
    file,
    runStorage: runStorageLocationFromAnyAbsolutePath(file) !== undefined,
  }));
  const workspaceFiles = references
    .filter((reference) => !reference.runStorage)
    .map((reference) => reference.file);
  await assertWorkflowFilesExist([
    { label: 'Input file', files: workspaceFiles },
  ]);
  const resolved = await Promise.all(
    references.map(async ({ file, runStorage }) => {
      if (!runStorage) return file;
      let output: Awaited<ReturnType<typeof resolveChildRunOutput>>;
      try {
        output = await resolveChildRunOutput(parentExecutionId, file);
      } catch (error) {
        throw new WorkflowRunAbortError(
          formatError(
            `Workflow run-storage input could not be resolved: ${file}`,
            error,
          ),
          { cause: error },
        );
      }
      if (!output) {
        throw new WorkflowRunAbortError(
          `Workflow run-storage input could not be resolved: ${file}; ` +
            'pass options.inputFiles with files that still exist.',
        );
      }
      return output.absolutePath;
    }),
  );
  return resolved;
}

/** Build the production `agent()` adapter for one workflow-script run. */
export function createWorkflowScriptAgentRunner(
  parent: LaunchRunContext,
  defaultAgentName: string,
  checkpointId: string,
  hooks?: {
    /** Fires per live child on success and failure with its total cost. */
    readonly onCost?: (
      invocation: WorkflowAgentInvocation,
      totalCostUsd: number | undefined,
    ) => void;
  },
): WorkflowAgentRunner {
  const { runScope } = parent;

  return async (invocation) => {
    try {
      const { result } = await executeStableSubagentInBand({
        executionId: workflowChildExecutionId(
          runScope.executionId,
          checkpointId,
          invocation.key,
        ),
        parentExecutionId: runScope.executionId,
        signal: invocation.signal,
        prepare: async () => {
          const requestedAgent =
            invocation.options.agentName ?? defaultAgentName;
          const agent = requireVisibleAgent(
            AgentCategory.Workflow,
            requestedAgent,
            runScope.delegationAgentScope ?? undefined,
          );
          const [model, inputFiles] = await Promise.all([
            selectAvailableDelegationModel({
              parentModel: parent.model,
              agentCategory: AgentCategory.Workflow,
            }),
            resolveInvocationInputFiles(
              runScope.executionId,
              invocation.options.inputFiles ?? [],
            ),
          ]);
          // Run-storage references can disappear during recovery. Validate
          // the resolved inputs, not merely the paths supplied by the script,
          // so a stale reference cannot launch a useless empty-envelope run.
          // Run-fatal, not a per-call failure: a plain error would resolve
          // this agent() to null inside parallel()/pipeline(), silently
          // filtering away the very misuse this guard exists to surface.
          if (
            inputFiles.length === 0 &&
            (agent.defaultOutputFiles ?? []).length === 0
          ) {
            throw new WorkflowRunAbortError(
              `Workflow agent '${agent.name}' edits files: pass options.inputFiles ` +
                `with files that still exist (its result carries output files and ` +
                `diffs, not response text).`,
            );
          }
          const configPayload: AgentConfigPayload = {
            agent: agent.name,
            agentSource: agent.source,
            agentCategory: AgentCategory.Workflow,
            model,
            instruction: invocation.prompt,
            inputFiles,
            ...(runScope.workingDirectory !== undefined && {
              workingDirectory: runScope.workingDirectory,
            }),
            ...(runScope.delegationAgentScope && {
              delegationAgentScope: runScope.delegationAgentScope,
            }),
          };
          return {
            configPayload,
            agentName: agent.name,
            parentExecutionId: runScope.executionId,
            parentStreamId: runScope.streamId,
            runtimeHost: runScope.runtimeHost,
            session: runScope.session,
            signal: invocation.signal,
            approvalPromptsUnavailable: parent.approvalPromptsUnavailable,
            runtimeUnavailableTools: parent.runtimeUnavailableTools,
            // Live per-kind ancestry, matching LLM delegation: bash and
            // tool-edit each follow the parent's own bypass; proposal stays
            // unlinked so a child's own delegations still prompt.
            onStreamResolved: (resolvedStreamId) => {
              configureDelegatedChildApprovals(
                resolvedStreamId,
                runScope.streamId,
                'inherit',
                runScope.session,
              );
            },
            onCost: (totalCostUsd) => hooks?.onCost?.(invocation, totalCostUsd),
          };
        },
      });
      if (result.outcome !== 'completed') {
        throw new Error(
          `Workflow subagent ended with ${result.outcome} outcome.`,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof SubagentDurabilityError) {
        throw new WorkflowRunAbortError(error.message, { cause: error });
      }
      throw error;
    }
  };
}
