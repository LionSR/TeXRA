// Node imports
import { createHash } from 'node:crypto';

// Local imports
import { getExecutionStore, resolveChildRunOutput } from '@agent/storage';
import {
  WorkflowRunAbortError,
  type WorkflowAgentCallOptions,
  type WorkflowAgentInvocation,
  type WorkflowAgentRunner,
} from '@agent/workflowScript';
import type { AgentEntry } from '@agent/index/agentRegistry';
import type { LaunchRunContext } from '@agent/runtime/RunContext';
import type { AgentConfigPayload } from '@agent/core/definition/AgentConfig';
import { formatError } from '@common/errors';
import { AgentCategory } from '@shared/schemas';
import type {
  ExecutionId,
  RunStorageFileLocation,
  StreamTabId,
} from '@shared/schemas';
import { configureDelegatedChildApprovals } from '@tools/approval';
import { AbsoluteFS, WorkspaceFS } from '@utils/files';
import { deriveExecutionId } from '@utils/core/idHash';
import { runStorageLocationFromAnyAbsolutePath } from '@utils/files/taskRunStorage';

// Local file imports
import {
  executeStableSubagentInBand,
  SubagentDurabilityError,
} from './inBandSubagentExecution';
import { rejectOversizedBibAttachments } from './inputFields';
import {
  requireVisibleAgent,
  selectAvailableDelegationModel,
} from './proposalFlow';
import { assertWorkflowFilesExist } from './workflowFileValidation';

async function resolveInvocationFileList(
  parentExecutionId: LaunchRunContext['runScope']['executionId'],
  label: string,
  files: readonly string[],
): Promise<string[]> {
  const references = files.map((file) => ({
    file,
    runStorage: runStorageLocationFromAnyAbsolutePath(file) !== undefined,
  }));
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
  invocation: WorkflowAgentInvocation,
  parent: LaunchRunContext,
  agentCategory: AgentCategory,
): Promise<string> {
  const requestedModel = invocation.options.model;
  try {
    return await selectAvailableDelegationModel({
      ...(requestedModel !== undefined && { requestedModel }),
      parentModel: parent.model,
      agentCategory,
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
export interface WorkflowRunIdentity {
  readonly executionId: ExecutionId;
  readonly streamId: StreamTabId;
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
    /**
     * Fires when a live attempt for this grandchild begins (`active: true`)
     * and settles (`active: false`), carrying its derived execution id — the
     * identity a host uses to target interactive skip/retry. Retries re-enter
     * the runner with the same id, so each attempt is bracketed by a
     * start/settle pair.
     */
    readonly onChildActive?: (
      grandchildExecutionId: ExecutionId,
      invocation: WorkflowAgentInvocation,
      active: boolean,
    ) => void;
  },
): WorkflowAgentRunner {
  const { runScope } = parent;

  return async (invocation) => {
    if (invocation.dependencyFingerprint !== undefined) {
      let launchFingerprint: string;
      try {
        launchFingerprint = await fingerprintWorkflowAgentDependencies(
          run.executionId,
          invocation.options,
        );
      } catch (error) {
        if (error instanceof WorkflowRunAbortError) throw error;
        throw new WorkflowRunAbortError(
          formatError(
            'Workflow agent() file dependencies could not be fingerprinted while the child was launching',
            error,
          ),
          { cause: error },
        );
      }
      if (launchFingerprint !== invocation.dependencyFingerprint) {
        throw new WorkflowRunAbortError(
          'Workflow agent() file dependencies changed while the child was launching; rerun the saved workflow script.',
        );
      }
    }
    const logicalExecutionId = deriveExecutionId({
      checkpointId,
      key: invocation.key,
      parentExecutionId: run.executionId,
    });
    // The id this attempt actually runs (and registers its child stream)
    // under: the logical id on attempt 0, an attempt-specific id after a
    // durable retry. A host targets the in-flight attempt by THIS id, so
    // report it — not the logical id — through the control bridge.
    let activeExecutionId: ExecutionId | undefined;
    try {
      const completed = await executeStableSubagentInBand({
        executionId: logicalExecutionId,
        parentExecutionId: run.executionId,
        signal: invocation.signal,
        onActiveExecutionId: (executionId) => {
          activeExecutionId = executionId;
          invocation.reportChildExecution?.(executionId);
          hooks?.onChildActive?.(executionId, invocation, true);
        },
        prepare: async () => {
          const sharedConfigFields = {
            instruction: invocation.prompt,
            ...(runScope.workingDirectory !== undefined && {
              workingDirectory: runScope.workingDirectory,
            }),
            ...(runScope.delegationAgentScope && {
              delegationAgentScope: runScope.delegationAgentScope,
            }),
          };
          let configPayload: AgentConfigPayload;
          let agentName: string;

          if (invocation.options.schema !== undefined) {
            const agent = requireVisibleAgent(
              AgentCategory.ToolUse,
              invocation.options.agentName,
              runScope.delegationAgentScope ?? undefined,
            );
            const model = await workflowScriptModelSelection(
              invocation,
              parent,
              AgentCategory.ToolUse,
            );
            agentName = agent.name;
            configPayload = {
              ...sharedConfigFields,
              agent: agent.name,
              agentSource: agent.source,
              model,
              agentCategory: AgentCategory.ToolUse,
              outputSchema: invocation.options.schema,
            };
          } else {
            const agent =
              invocation.options.agentName === undefined
                ? defaultAgent
                : requireVisibleAgent(
                    AgentCategory.Workflow,
                    invocation.options.agentName,
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
            const model = await workflowScriptModelSelection(
              invocation,
              parent,
              AgentCategory.Workflow,
            );
            const [inputFiles, contextFiles, mediaFiles] = await Promise.all([
              resolveInvocationFileList(
                run.executionId,
                'Input file',
                invocation.options.inputFiles ?? [],
              ),
              resolveInvocationFileList(
                run.executionId,
                'Context file',
                invocation.options.contextFiles ?? [],
              ),
              resolveInvocationFileList(
                run.executionId,
                'Media file',
                invocation.options.mediaFiles ?? [],
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

          // Surface the resolved child model so the engine can attach it to
          // this call's `agent:end` progress event.
          invocation.reportModel?.(configPayload.model);
          invocation.reportAgent?.(agentName);
          return {
            configPayload,
            agentName,
            parentExecutionId: run.executionId,
            parentStreamId: run.streamId,
            session: runScope.session,
            signal: invocation.signal,
            approvalPromptsUnavailable: parent.approvalPromptsUnavailable,
            onApprovalPolicyDenial: parent.onApprovalPolicyDenial,
            runtimeUnavailableTools: parent.runtimeUnavailableTools,
            // The engine settles the owning phase onto the call options before
            // handing them here (declared task phase, else the phase active at
            // call time), so this is a single-owner read rather than a
            // reconstruction of the engine's rule.
            workflowPhase: invocation.options.phase,
            // Live per-kind ancestry, matching LLM delegation: each approval
            // follows the parent's corresponding bypass. The run's own stream
            // inherits from the orchestrator, so nested delegation remains
            // transitive.
            onStreamResolved: (resolvedStreamId) => {
              invocation.reportChildStream?.(resolvedStreamId);
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
              invocation.reportCostUsd?.(totalCostUsd);
            },
          };
        },
      });
      const recovered = activeExecutionId === undefined;
      if (recovered) {
        // Durable recovery never fires onActiveExecutionId; re-attach the
        // known child id (and stream when available) so /executions/{id}
        // can navigate to the child that supplied the result.
        invocation.reportChildExecution?.(completed.executionId);
        if (invocation.reportChildStream !== undefined) {
          try {
            const recoveredStreamId = (
              await getExecutionStore(completed.executionId).readMeta()
            )?.streamId;
            if (recoveredStreamId !== undefined) {
              invocation.reportChildStream(recoveredStreamId);
            }
          } catch {
            // A recovered result is authoritative. Navigation metadata is
            // optional and must not invalidate the completed computation.
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
        invocation.reportCostUsd?.(result.cost);
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
    } finally {
      // Only a live attempt registered (recovered attempts never fire the
      // active callback), so settle exactly what was registered.
      if (activeExecutionId !== undefined) {
        hooks?.onChildActive?.(activeExecutionId, invocation, false);
      }
    }
  };
}
