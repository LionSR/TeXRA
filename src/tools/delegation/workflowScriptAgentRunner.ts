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
import type { ExecutionId, StreamTabId } from '@shared/schemas';
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

/**
 * Identity of the detached workflow-run that owns this script's `agent()`
 * grandchildren. Re-rooting them here (instead of the orchestrator) gives a
 * clean 3-level tree — orchestrator → run → agent — so killing the run
 * cascades to its in-flight child. Both fields are stable across relaunch:
 * `executionId` is derived deterministically from the checkpoint identity, so
 * the grandchild execution ids and run-storage lineage stay consistent when a
 * timed-out run is resumed under the same `meta.name`.
 */
export interface WorkflowRunIdentity {
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
}

/** Build the production `agent()` adapter for one workflow-script run. */
export function createWorkflowScriptAgentRunner(
  parent: LaunchRunContext,
  defaultAgentName: string,
  checkpointId: string,
  run: WorkflowRunIdentity,
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
        executionId: deriveExecutionId({
          checkpointId,
          key: invocation.key,
          parentExecutionId: run.executionId,
        }),
        parentExecutionId: run.executionId,
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
              run.executionId,
              invocation.options.inputFiles ?? [],
            ),
          ]);
          // Surface the resolved child model so the engine can attach it to
          // this call's `agent:end` progress event.
          invocation.reportModel?.(model);
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
            parentExecutionId: run.executionId,
            parentStreamId: run.streamId,
            runtimeHost: runScope.runtimeHost,
            session: runScope.session,
            signal: invocation.signal,
            approvalPromptsUnavailable: parent.approvalPromptsUnavailable,
            runtimeUnavailableTools: parent.runtimeUnavailableTools,
            // Live per-kind ancestry, matching LLM delegation: bash and
            // tool-edit each follow the parent's own bypass; proposal stays
            // unlinked so a child's own delegations still prompt. The run's own
            // stream inherits from the orchestrator, so this stays transitive.
            onStreamResolved: (resolvedStreamId) => {
              configureDelegatedChildApprovals(
                resolvedStreamId,
                run.streamId,
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
