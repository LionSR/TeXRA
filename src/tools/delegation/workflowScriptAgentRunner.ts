// Node imports
import { createHash } from 'node:crypto';
import * as path from 'node:path';

// Local imports
import { getExecutionStore, resolveChildRunOutput } from '@agent/storage';
import {
  WorkflowRunAbortError,
  type WorkflowAgentCallOptions,
  type WorkflowAgentInvocation,
  type WorkflowAgentRunner,
  type WorkflowScriptRunOptions,
} from '@agent/workflowScript';
import type { AgentEntry } from '@agent/index/agentEntry';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { formatError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import { AgentCategory } from '@shared/schemas';
import type {
  ExecutionId,
  RunStorageFileLocation,
  StreamTabId,
} from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { deriveExecutionId } from '@utils/core/idHash';
import { runStorageLocationFromAnyAbsolutePath } from '@utils/files/runStorageFs';

// Local file imports
import {
  executeStableSubagentInBand,
  SubagentDurabilityError,
} from './inBandSubagentExecution';
import {
  assertWorkflowFilesExist,
  rejectOversizedBibAttachments,
} from './inputFields';
import { selectAvailableDelegationModel } from './delegationAvailability';
import { requireVisibleAgent } from './proposalFlow';

const log = createLog('workflowScriptAgentRunner');

async function resolveInvocationFileList(
  parentExecutionId: LaunchRunContext['runScope']['executionId'],
  label: string,
  files: readonly string[],
): Promise<string[]> {
  const references = files.map((file) => {
    const runStorage =
      runStorageLocationFromAnyAbsolutePath(file) !== undefined;
    if (!runStorage && path.isAbsolute(file)) {
      const relative = path.relative(StorageFS.fullPath(''), file);
      if (!path.isAbsolute(relative) && relative.split(path.sep)[0] !== '..') {
        throw new WorkflowRunAbortError(
          `Workflow ${label} could not be resolved: ${file}; ` +
            'workspace-storage files must be declared outputs of a completed child run.',
        );
      }
    }
    return { file, runStorage };
  });
  const workspaceFiles = references
    .filter((reference) => !reference.runStorage)
    .map((reference) => reference.file);
  try {
    await assertWorkflowFilesExist([{ label, files: workspaceFiles }]);
  } catch (error) {
    throw new WorkflowRunAbortError(
      formatError(`Workflow ${label} files could not be resolved`, error),
      { cause: error },
    );
  }
  return await Promise.all(
    references.map(async ({ file, runStorage }) => {
      if (!runStorage) return file;
      let output: RunStorageFileLocation | undefined;
      try {
        output = await resolveChildRunOutput(parentExecutionId, file);
      } catch (error) {
        throw new WorkflowRunAbortError(
          formatError(
            `Workflow ${label} could not be resolved: ${file}`,
            error,
          ),
          { cause: error },
        );
      }
      if (!output) {
        throw new WorkflowRunAbortError(
          `Workflow ${label} could not be resolved: ${file}; ` +
            'pass a matching workflow file option whose files still exist.',
        );
      }
      return output.absolutePath;
    }),
  );
}

/** Hash the bytes behind every file option used by one workflow agent call. */
export async function fingerprintWorkflowAgentDependencies(
  parentExecutionId: LaunchRunContext['runScope']['executionId'],
  options: WorkflowAgentCallOptions,
): Promise<string> {
  const groups = [
    { kind: 'input', label: 'Input file', files: options.inputFiles ?? [] },
    {
      kind: 'context',
      label: 'Context file',
      files: options.contextFiles ?? [],
    },
    { kind: 'media', label: 'Media file', files: options.mediaFiles ?? [] },
  ] as const;
  if (groups.every((group) => group.files.length === 0)) {
    throw new WorkflowRunAbortError(
      'Cannot fingerprint a workflow agent call without file dependencies.',
    );
  }

  const hash = createHash('sha256');
  for (const { kind, label, files } of groups) {
    const resolved = await resolveInvocationFileList(
      parentExecutionId,
      label,
      files,
    );
    for (const [index, file] of resolved.entries()) {
      const bytes =
        runStorageLocationFromAnyAbsolutePath(file) !== undefined
          ? await AbsoluteFS.readBytes(file)
          : await WorkspaceFS.readBytes(file);
      hash.update(`${kind}\0${index}\0${bytes.length}\0`);
      hash.update(bytes);
    }
  }
  return hash.digest('hex');
}

async function workflowScriptModelSelection(
  invocation: Pick<WorkflowAgentInvocation, 'options'>,
  parent: LaunchRunContext,
): Promise<string> {
  const requestedModel = invocation.options.model;
  try {
    return await selectAvailableDelegationModel({
      ...(requestedModel !== undefined && { requestedModel }),
      parentModel: parent.model,
    });
  } catch (error) {
    // A declared model is workflow configuration, so its rejection must not
    // disappear as a nullable call inside parallel(). When the
    // script omits the field, preserve the established delegation failure
    // semantics; per-call model routing must not broaden that behavior.
    if (requestedModel === undefined) throw error;
    throw new WorkflowRunAbortError(
      formatError('Workflow model could not be selected', error),
      { cause: error },
    );
  }
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
interface WorkflowRunIdentity {
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
}

/**
 * Resolve what one issued `agent()` call actually runs — agent, model, result
 * contract, and files — from the options the script declared. One owner for
 * both the launch (`prepare`) and the per-call review a host shows before
 * admitting the call, so the card the user approves is the config that runs.
 */
async function resolveWorkflowCallConfig(
  call: Pick<WorkflowAgentInvocation, 'prompt' | 'options'>,
  parent: LaunchRunContext,
  defaultAgent: AgentEntry,
  runExecutionId: ExecutionId,
): Promise<{ configPayload: AgentConfigPayload; agentName: string }> {
  const { runScope } = parent;
  const sharedConfigFields = {
    instruction: call.prompt,
    ...(runScope.workingDirectory !== undefined && {
      workingDirectory: runScope.workingDirectory,
    }),
    ...(runScope.delegationAgentScope && {
      delegationAgentScope: runScope.delegationAgentScope,
    }),
  };
  let configPayload: AgentConfigPayload;
  let agentName: string;

  if (call.options.schema !== undefined) {
    const agent = requireVisibleAgent(
      AgentCategory.ToolUse,
      call.options.agentName,
      runScope.delegationAgentScope ?? undefined,
    );
    const model = await workflowScriptModelSelection(call, parent);
    agentName = agent.name;
    configPayload = {
      ...sharedConfigFields,
      agent: agent.name,
      agentSource: agent.source,
      model,
      agentCategory: AgentCategory.ToolUse,
      outputSchema: call.options.schema,
    };
  } else {
    const agent =
      call.options.agentName === undefined
        ? defaultAgent
        : requireVisibleAgent(
            AgentCategory.Workflow,
            call.options.agentName,
            runScope.delegationAgentScope ?? undefined,
          );
    if (agent.category !== AgentCategory.Workflow) {
      throw new WorkflowRunAbortError(
        `Agent '${agent.name}' is a ${agent.category} agent but was ` +
          `launched as workflow. Use delegate_agent instead.`,
      );
    }
    // Model resolves before any file I/O so an unavailable/invalid
    // declared model fails the call without touching the filesystem.
    const model = await workflowScriptModelSelection(call, parent);
    const [inputFiles, contextFiles, mediaFiles] = await Promise.all([
      resolveInvocationFileList(
        runExecutionId,
        'Input file',
        call.options.inputFiles ?? [],
      ),
      resolveInvocationFileList(
        runExecutionId,
        'Context file',
        call.options.contextFiles ?? [],
      ),
      resolveInvocationFileList(
        runExecutionId,
        'Media file',
        call.options.mediaFiles ?? [],
      ),
    ]);
    const oversizedBibRejection =
      await rejectOversizedBibAttachments(contextFiles);
    if (oversizedBibRejection) {
      throw new WorkflowRunAbortError(oversizedBibRejection.error);
    }
    // Run-storage references can disappear during recovery. Validate
    // the resolved inputs, not merely the paths supplied by the script,
    // so a stale reference cannot launch a useless empty-envelope run.
    // Run-fatal, not a per-call failure: a plain error would resolve
    // this agent() to null inside parallel(), silently
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
    agentName = agent.name;
    configPayload = {
      ...sharedConfigFields,
      agent: agent.name,
      agentSource: agent.source,
      model,
      inputFiles,
      contextFiles,
      mediaFiles,
      agentCategory: AgentCategory.Workflow,
    };
  }
  return { configPayload, agentName };
}

/** Build the production `agent()` adapter for one workflow-script run. */
export function createWorkflowScriptAgentRunner(
  parent: LaunchRunContext,
  defaultAgent: AgentEntry,
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
    const logicalExecutionId = deriveExecutionId({
      checkpointId,
      key: invocation.key,
      parentExecutionId: run.executionId,
    });
    // The id this attempt actually runs (and registers its child stream)
    // under: the logical id on attempt 0, an attempt-specific id after a
    // durable retry. A host targets the in-flight attempt by THIS id, so it is
    // the one reported to the engine; it also marks the attempt as live, which
    // durable recovery (which never fires the callback) is distinguished by.
    let activeExecutionId: ExecutionId | undefined;
    try {
      const completed = await executeStableSubagentInBand({
        executionId: logicalExecutionId,
        parentExecutionId: run.executionId,
        signal: invocation.signal,
        onActiveExecutionId: (executionId) => {
          activeExecutionId = executionId;
          invocation.report?.({ childExecutionId: executionId });
        },
        prepare: async () => {
          const { configPayload, agentName } = await resolveWorkflowCallConfig(
            invocation,
            parent,
            defaultAgent,
            run.executionId,
          );
          // Surface the resolved child model so the engine can attach it to
          // this call's `agent:end` progress event.
          invocation.report?.({ model: configPayload.model, agent: agentName });
          return {
            configPayload,
            agentName,
            parentStreamId: run.streamId,
            session: runScope.session,
            approvalPromptsUnavailable: parent.approvalPromptsUnavailable,
            onApprovalPolicyDenial: parent.onApprovalPolicyDenial,
            runtimeUnavailableTools: parent.runtimeUnavailableTools,
            // The engine settles the owning phase onto the call options before
            // handing them here (declared task phase, else the phase active at
            // call time), so this is a single-owner read rather than a
            // reconstruction of the engine's rule.
            workflowPhase: invocation.options.phase,
            // Live inherited bypass values, matching LLM delegation: each
            // approval follows the parent's corresponding bypass. The run's own
            // stream inherits from the orchestrator, so nested delegation remains
            // transitive.
            onStreamResolved: (resolvedStreamId) => {
              invocation.report?.({ childStreamId: resolvedStreamId });
              configureDelegatedChildApprovals(
                resolvedStreamId,
                run.streamId,
                'inherit',
                runScope.session,
              );
            },
            onCost: (totalCostUsd) => {
              hooks?.onCost?.(invocation, totalCostUsd);
              // Stamp progressive spend onto the live snapshot attempt so a
              // failed/cancelled/retried attempt still shows what it consumed
              // even when execution never reaches the success path below.
              if (totalCostUsd !== undefined) {
                invocation.report?.({ costUsd: totalCostUsd });
              }
            },
          };
        },
      });
      const recovered = activeExecutionId === undefined;
      if (recovered) {
        // Durable recovery never fires onActiveExecutionId; re-attach the
        // known child id (and stream when available) so /executions/{id}
        // can navigate to the child that supplied the result. The recovered
        // marker keeps these ids out of the engine's skip/retry map — the
        // recovered result is authoritative and must stay uncontrollable.
        invocation.report?.({
          childExecutionId: completed.executionId,
          recovered: true,
        });
        if (invocation.report !== undefined) {
          try {
            const recoveredStreamId = (
              await getExecutionStore(completed.executionId).readMeta()
            )?.streamId;
            if (recoveredStreamId !== undefined) {
              invocation.report({
                childStreamId: recoveredStreamId,
                recovered: true,
              });
            }
          } catch (error) {
            // A recovered result is authoritative. Navigation metadata is
            // optional and must not invalidate the completed computation —
            // but a failed read of a persisted record is still reported.
            log.warn('Failed to read the recovered child stream id', {
              data: { executionId: completed.executionId, error },
            });
          }
        }
      }
      const { result } = completed;
      // Live physical attempts always charge the terminal result cost (covers
      // failed/cancelled outcomes and empty-output validation throws that
      // never reach a success-only callback). Recovered durable results must
      // not charge the synthetic resume attempt — the interrupted snapshot may
      // already hold the same cost on a closed prior attempt.
      if (!recovered) {
        invocation.report?.({ costUsd: result.cost });
      }
      if (result.outcome !== 'completed') {
        throw new Error(
          `Workflow subagent ended with ${result.outcome} outcome.`,
        );
      }
      if (result.category === 'workflow' && result.outputs.length === 0) {
        throw new Error(
          'Workflow subagent completed without producing any output files.',
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
