import { resolveChildRunOutput } from '@agent/storage';
import type { WorkflowAgentRunner } from '@agent/workflowScript';
import { getCurrentToolCallContext } from '@agent/followUp/ToolFileInteractionContext';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@shared/schemas';
import { filterNotNullish } from '@utils/core';
import { runStorageLocationFromAnyAbsolutePath } from '@utils/files/taskRunStorage';

import { executeSubagentInBand } from './inBandSubagentExecution';
import {
  requireVisibleAgent,
  selectAvailableDelegationModel,
} from './proposalFlow';
import { assertWorkflowFilesExist } from './workflowFileValidation';

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
      return (await resolveChildRunOutput(parentExecutionId, file))
        ?.absolutePath;
    }),
  );
  return resolved.filter(filterNotNullish);
}

/** Build the production `agent()` adapter for one workflow-script run. */
export function createWorkflowScriptAgentRunner(
  parent: LaunchRunContext,
  defaultAgentName: string,
): WorkflowAgentRunner {
  const { runScope } = parent;
  const recordSubagentCost =
    getCurrentToolCallContext()?.hooks?.recordSubagentCost;

  return async (invocation) => {
    const requestedAgent = invocation.options.agentName ?? defaultAgentName;
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

    const { result } = await executeSubagentInBand({
      configPayload,
      agentName: agent.name,
      parentExecutionId: runScope.executionId,
      parentStreamId: runScope.streamId,
      runtimeHost: runScope.runtimeHost,
      session: runScope.session,
      signal: invocation.signal,
      approvalPromptsUnavailable: parent.approvalPromptsUnavailable,
      runtimeUnavailableTools: parent.runtimeUnavailableTools,
      ...(recordSubagentCost && {
        onCost: (cost: number | undefined) => recordSubagentCost(cost ?? 0),
      }),
    });
    return result;
  };
}
