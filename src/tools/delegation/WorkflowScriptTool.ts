// Third-party imports
import { z } from 'zod';

// Local imports
import { getExecutionStore, registerExecution } from '@agent/storage';
import {
  deriveWorkflowScriptCheckpointId,
  parseWorkflowScript,
  readWorkflowScriptCheckpoint,
} from '@agent/workflowScript';
import {
  captureOwnedExecutionLease,
  ExecutionLeaseActiveError,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage/executionLease';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { startChildRunLoop } from '@agent/runtime/childRunLoop';
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';
import {
  AgentCategory,
  EXECUTION_STATUS,
  type StreamTabId,
} from '@shared/schemas';
import { WorkflowScriptFilesSchema } from '@shared/schemas/workflowScriptFiles';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import { configureDelegatedChildApprovals } from '@tools/approval';
import {
  createRehydratedChildStream,
  getChildStreamId,
} from '@tools/childStream';
import {
  assertWritable,
  resolveWorkspaceRelativePath,
} from '@tools/pathResolution';
import { defineTool } from '@tools/core/define';
import { WorkspaceFS } from '@utils/files';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { deriveExecutionId } from '@utils/core/idHash';

// Local file imports
import { createWorkflowScriptAgentRunner } from './workflowScriptAgentRunner';
import {
  createWorkflowScriptStrategy,
  formatWorkflowScriptReference,
} from './workflowScriptStrategy';
import { rejectOversizedBibAttachments } from './inputFields';
import {
  requireVisibleAgent,
  selectAvailableDelegationModel,
} from './proposalFlow';
import { assertWorkflowFilesExist } from './workflowFileValidation';

const WorkflowScriptToolInputSchema = z
  .strictObject({
    agent: z
      .string()
      .min(1)
      .describe('Default workflow agent used when agent() omits agentName.'),
    args: z
      .json()
      .nullish()
      .describe(
        'JSON arguments exposed to the script as the global args value.',
      ),
    files: WorkflowScriptFilesSchema.nullish().describe(
      'Workspace files bound to the workflow run by role and exposed to the script as the immutable global files object.',
    ),
    script: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'Complete newly submitted workflow script source beginning with an export const meta object. Provide exactly one of script or scriptPath.',
      ),
    scriptPath: z
      .string()
      .min(1)
      .nullish()
      .describe(
        'Path to a previously saved editable workflow script file, resolved by the normal tool path policy. Provide exactly one of script or scriptPath.',
      ),
  })
  .superRefine((input, ctx) => {
    if ((input.script == null) === (input.scriptPath == null)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Provide exactly one of script or scriptPath.',
        path: ['script'],
      });
    }
  });

type WorkflowScriptToolInput = z.infer<typeof WorkflowScriptToolInputSchema>;

const STREAM_PREFIX = 'workflow-script';
const WORKFLOW_SCRIPT_DIRECTORY = '.texra/workflow-scripts';

function workflowScriptDraftStem(id: string): string {
  const slug = id
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replaceAll(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
  return `draft-${slug || 'workflow'}`;
}

async function persistWorkflowScript(
  script: string,
  submissionId: string,
  workingDirectory: string | undefined,
): Promise<string> {
  const directory = resolveWorkspaceRelativePath(
    WORKFLOW_SCRIPT_DIRECTORY,
    workingDirectory,
  );
  assertWritable(directory, WORKFLOW_SCRIPT_DIRECTORY);
  await WorkspaceFS.ensureDir(directory.fsPath);
  const stem = workflowScriptDraftStem(submissionId);
  for (let suffix = 0; ; suffix += 1) {
    const filename = suffix === 0 ? `${stem}.mjs` : `${stem}-${suffix + 1}.mjs`;
    const resolved = resolveWorkspaceRelativePath(
      `${WORKFLOW_SCRIPT_DIRECTORY}/${filename}`,
      workingDirectory,
    );
    assertWritable(resolved, resolved.relative);
    if (await WorkspaceFS.exists(resolved.fsPath)) {
      if ((await WorkspaceFS.read(resolved.fsPath)) === script) {
        return resolved.relative;
      }
      continue;
    }
    await WorkspaceFS.write(resolved.fsPath, script);
    return resolved.relative;
  }
}

function workflowScriptToolError(
  error: unknown,
  scriptPath: string,
): ToolError {
  return new ToolError(
    `${toErrorMessage(error)}\n\n${formatWorkflowScriptReference(scriptPath)}`,
    { cause: error },
  );
}

function withScriptReference(
  result: ToolResult,
  scriptPath: string,
): ToolResult {
  const reference = formatWorkflowScriptReference(scriptPath);
  if (result.status === 'error') {
    return {
      ...result,
      error: `${result.error}\n\n${reference}`,
    };
  }
  return {
    ...result,
    output: [result.output, reference].filter(Boolean).join('\n\n'),
  };
}

/**
 * Execute a durable, deterministic workflow script from an agent whose tool
 * list names it. Gated by the "Workflow Script" dashboard switch (id
 * `workflow-script` in {@link @tools/externalToolDefs}), which
 * `resolveAgentTools()` enforces regardless of any agent's configured tools —
 * new installs start with the switch off.
 */
export class WorkflowScriptTool extends defineTool({
  name: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  slow: true,
  description: `Run a deterministic JavaScript workflow that coordinates workflow agents. Workflow agents edit or produce FILES: each agent() call resolves to a result envelope { category: 'workflow', outcome, outputs, diffs, compileFailures, cost } listing the files it produced, never prose. Use this when the complete fan-out and join structure is known in advance and should resume safely after interruption.

Script input: every source submission is saved immediately as a unique, non-overwriting draft under .texra/workflow-scripts/. Every result returns that editable path; on an error, edit the file and retry with scriptPath instead of rewriting the source.

Script rules:
- Meta: start with an export const meta object containing name and description. No imports or require — only the injected primitives exist: agent, phase, log, parallel, args, and files. Metadata and agent() options reject unknown fields, so typos fail at the saved script instead of being ignored. meta.phases accepts title strings such as ['Draft', 'Merge'] or objects such as [{ title: 'Draft' }].
- Tasks: when the calls are known in advance, declare meta.tasks as { id, label, phase? } records so progress shows the pending plan before execution. A task phase must name a title in meta.phases. Every agent() call must then reference one declared task with { id }; omit label and phase from the call because meta.tasks owns them (exact matching duplicates are accepted, but conflicts fail). Omit meta.tasks when the call set is data-dependent.
- Files: the tool's files field binds workspace files to the whole run as files.inputFiles (editable), files.contextFiles (read-only documents), and files.mediaFiles (read-only visual or audio inputs). A workflow agent() call may use inputFiles, contextFiles, and mediaFiles; inputFiles is required unless the agent declares default outputs. Paths may name workspace files, launch files, or a previous call's outputs.
- Calls: every call may use agentName (another visible workflow agent; defaults to this tool's agent field) and model (an available model short name for this call); omit model to follow ordinary delegation policy. A call without meta.tasks may also use id, label, and phase.
- Awaiting: agent() and parallel() return Promises — await them. Use ordinary JavaScript loops and awaited calls for sequential stages.
- Failures: a failed agent call, including a workflow agent that produces no output files, resolves to null. An interactive skip resolves to the truthy '__WORKFLOW_SKIPPED__' sentinel; exclude both non-results before synthesis. JavaScript errors in parallel() thunks fail the workflow and preserve the editable script path rather than being silently converted to null.

Structured output: agent(prompt, { agentName, model, schema }) runs a tool-use agent that finishes by calling submit_output with a value matching the JSON Schema. Structured calls do not accept file options and must name the tool-use agent explicitly; model remains optional. The call resolves to an envelope whose .structured is the validated object rather than edited files.

Async: this tool returns immediately with an execution ID and runs the workflow as its own detached execution. The script's return value plus the run log (phases, log() lines, per-call outcomes with cost) are delivered back as a follow-up message when the run completes. Check intermediate progress with the executions tool (path=/executions/<id>, action=wait).

Example:
export const meta = {
  name: 'fix-drafts',
  description: 'Fix typos in two drafts',
  phases: ['Fix', 'Merge'],
  tasks: [
    { id: 'first', label: 'Fix first draft', phase: 'Fix' },
    { id: 'second', label: 'Fix second draft', phase: 'Fix' },
    { id: 'merge', label: 'Merge corrected drafts', phase: 'Merge' },
  ],
}
phase('Fix')
const results = await parallel(files.inputFiles.slice(0, 2).map((file, index) => () =>
  agent('Fix spelling errors only.', {
    id: index === 0 ? 'first' : 'second',
    inputFiles: [file],
  })
))
const correctedFiles = results
  .filter((result) => result != null && result !== '__WORKFLOW_SKIPPED__')
  .flatMap((result) => result.outputs.map((output) => output.absolutePath))
phase('Merge')
return await agent('Merge the corrected drafts.', {
  id: 'merge',
  inputFiles: correctedFiles,
})

Durability: the journal is keyed by meta.name within this session. If the run times out or is interrupted, call this tool again with the SAME meta.name: completed agent() calls replay for free (the script may be revised; only changed or unfinished calls execute). Use a new meta.name to start over. The default whole-run wall clock is 10 minutes; set meta.timeoutMs (1s to 60min) for longer runs.`,
  schema: WorkflowScriptToolInputSchema,
}) {
  protected async execute(input: WorkflowScriptToolInput): Promise<ToolResult> {
    const contexts = getCurrentToolContexts();
    if (contexts?.runContext?.kind !== 'launch') {
      throw new Error(
        'delegate_workflow_script requires an active launched agent session.',
      );
    }
    const { runContext: parent, callContext } = contexts;
    const { runScope } = parent;

    // Named checkpoint, not content- or toolCallId-keyed: a retrying model
    // rewrites its script, so any key derived from call identity or source
    // text orphans the journal exactly when resume matters (#8666). meta.name
    // is the durable identity; per-entry prompt/options hashes in the journal
    // keep replays honest when the script evolves.
    let scriptPath: string;
    let script: string;
    if (input.scriptPath != null) {
      const resolved = resolveWorkspaceRelativePath(
        input.scriptPath,
        runScope.workingDirectory,
      );
      scriptPath = resolved.relative;
      try {
        script = await WorkspaceFS.read(resolved.fsPath);
      } catch (error) {
        throw new ToolError(
          `Unable to read workflow script '${input.scriptPath}': ${toErrorMessage(error)}`,
          { cause: error },
        );
      }
    } else {
      // The schema's exactly-one refinement guarantees source here.
      script = input.script as string;
      const submissionId =
        callContext.toolCallId ??
        deriveExecutionId({
          parentExecutionId: runScope.executionId,
          script,
        });
      scriptPath = await persistWorkflowScript(
        script,
        submissionId,
        runScope.workingDirectory,
      );
    }

    // Every setup phase below fails with the same annotation: prefix the
    // underlying error with the saved script reference so the model edits the
    // file and retries with scriptPath instead of rewriting the source.
    const runPhase = async <T>(phase: () => T | Promise<T>): Promise<T> => {
      try {
        return await phase();
      } catch (error) {
        throw workflowScriptToolError(error, scriptPath);
      }
    };

    const { meta, defaultAgent } = await runPhase(() => {
      const { meta } = parseWorkflowScript(script);
      const defaultAgent = requireVisibleAgent(
        AgentCategory.Workflow,
        input.agent,
        runScope.delegationAgentScope ?? undefined,
      );
      return { meta, defaultAgent };
    });
    const checkpointId = deriveWorkflowScriptCheckpointId({
      name: meta.name,
      defaultAgent: defaultAgent.name,
      parentExecutionId: runScope.executionId,
    });
    const store = getExecutionStore(runScope.executionId);
    const files = await runPhase(async () => {
      const priorCheckpoint =
        input.files == null
          ? await readWorkflowScriptCheckpoint(store, checkpointId)
          : null;
      const parsedFiles = WorkflowScriptFilesSchema.parse(
        input.files ?? priorCheckpoint?.files ?? {},
      );
      await assertWorkflowFilesExist([
        { label: 'Workflow input file', files: parsedFiles.inputFiles },
        { label: 'Workflow context file', files: parsedFiles.contextFiles },
        { label: 'Workflow media file', files: parsedFiles.mediaFiles },
      ]);
      return parsedFiles;
    });
    const oversizedBibRejection = await runPhase(() =>
      rejectOversizedBibAttachments(files.contextFiles),
    );
    if (oversizedBibRejection) {
      return withScriptReference(oversizedBibRejection, scriptPath);
    }

    // The run executionId is deterministic from the checkpoint identity, NOT a
    // fresh random id: a relaunch with the same meta.name regenerates the same
    // run id, so registration, stream, and grandchildren re-root at one stable
    // anchor and resume still replays completed calls (#8712). The journal
    // itself stays on the orchestrator store, where the checkpoint lives.
    const runExecutionId = deriveExecutionId({ checkpointId });

    // Captured now, while the launching tool call's ALS frame is live, so the
    // detached run can still roll its cost into the parent after this call
    // returns. Undefined totals are skipped (a malformed-journal failure never
    // records a spurious cost).
    const recordSubagentCost = callContext?.hooks?.recordSubagentCost;
    const recordCost = (totalCostUsd: number | undefined): void => {
      if (totalCostUsd !== undefined) recordSubagentCost?.(totalCostUsd);
    };

    // Same availability gate as delegate_agent/delegate_workflow: a run model
    // the active API mode cannot serve fails here, with the available list,
    // instead of mid-run on the first provider call.
    const runModel = await runPhase(() =>
      selectAvailableDelegationModel({
        parentModel: parent.model,
        agentCategory: AgentCategory.Workflow,
      }),
    );

    const runConfigPayload: AgentConfigPayload = {
      agent: defaultAgent.name,
      agentSource: defaultAgent.source,
      agentCategory: AgentCategory.Workflow,
      model: runModel,
      instruction: `Workflow script '${meta.name}'`,
      inputFiles: [...files.inputFiles],
      contextFiles: [...files.contextFiles],
      mediaFiles: [...files.mediaFiles],
      ...(runScope.workingDirectory !== undefined && {
        workingDirectory: runScope.workingDirectory,
      }),
    };
    const runConfig = await runPhase(() =>
      AgentConfigSchema.parse(runConfigPayload),
    );

    try {
      await registerExecution(runExecutionId, runConfig, meta.name, {
        streamId: getChildStreamId(runExecutionId, STREAM_PREFIX),
        parentExecutionId: runScope.executionId,
      });
    } catch (error) {
      // A relaunch whose prior run is still in flight shares this deterministic
      // id: the fresh-lease acquisition fails closed rather than starting a
      // second competing run over the same journal. Point the model at the
      // live run instead of erroring.
      if (error instanceof ExecutionLeaseActiveError) {
        return withScriptReference(
          {
            status: 'executed',
            summary: `Workflow script '${meta.name}' is already running`,
            output: [
              `A workflow script run for meta.name '${meta.name}' is already in progress (or finishing); its result arrives as a follow-up. Do not launch a competing run — wait for it, then resume with the same meta.name if it did not complete.`,
              `Execution ID: ${runExecutionId}`,
              `To check progress or collect the result: executions tool with path=/executions/${runExecutionId} and action=wait (returns immediately if it already finished).`,
            ].join('\n'),
          },
          scriptPath,
        );
      }
      throw workflowScriptToolError(
        new ToolError(
          `Failed to launch workflow script '${meta.name}': ${toErrorMessage(error)}`,
        ),
        scriptPath,
      );
    }
    const runWithOwnership = captureOwnedExecutionLease(runExecutionId);

    const runResult = runWithOwnership(async () => {
      // Attempt-scoped setup is inside the lease-protected try: it runs after
      // the deterministic run lease is held, so a throw here must release the
      // lease — otherwise it survives to its heartbeat timeout and a prompt
      // relaunch is refused.
      const runStore = getExecutionStore(runExecutionId);
      let runChildStreamId: StreamTabId;
      let runCompletion: Promise<void>;
      try {
        // A deterministic execution id may retain the prior attempt's report.
        // Clear it before starting this attempt so an interruption before
        // delivery cannot be mistaken for a newly persisted result.
        await runStore.delete('report');

        // meta.name deliberately reuses one deterministic stream across
        // launches. Reserve its writer while rehydrating so transcript
        // eviction cannot race a resumed run.
        const childStream = await createRehydratedChildStream(
          runExecutionId,
          runScope.streamId,
          {
            streamPrefix: STREAM_PREFIX,
            streamCategory: AgentCategory.Workflow,
            runKind: 'workflowScript',
            agentName: meta.name,
            description: meta.description,
            config: runConfig,
            toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
          },
        );
        runChildStreamId = childStream.childStreamId;

        // The run's own stream inherits the orchestrator's bypass so grandchild
        // agent() calls, which link to this stream, still resolve it transitively.
        configureDelegatedChildApprovals(
          runChildStreamId,
          runScope.streamId,
          'inherit',
          runScope.session,
        );

        runCompletion = startChildRunLoop({
          childStream,
          childStreamId: runChildStreamId,
          parentStreamId: runScope.streamId,
          executionId: runExecutionId,
          agentName: meta.name,
          strategy: createWorkflowScriptStrategy({
            executionId: runExecutionId,
            logger: childStream.logger,
            store,
            checkpointId,
            script,
            scriptPath,
            args: input.args,
            files,
            name: meta.name,
            workflowControls: runScope.session.workflowControls,
            ...(parent.stopAfterCycle && {
              deliveryMode: 'persistOnly' as const,
            }),
            createRunAgent: (hooks) =>
              createWorkflowScriptAgentRunner(
                parent,
                defaultAgent,
                checkpointId,
                { executionId: runExecutionId, streamId: runChildStreamId },
                hooks,
              ),
          }),
          recordCost,
        }).completion;
        if (!parent.stopAfterCycle) {
          // Detached callers do not await completion. Own late finalization
          // failures here as trace diagnostics; the child loop already owns
          // its one user-facing result/error delivery.
          void runCompletion.catch((error: unknown) => {
            childStream.logger.error(
              `Workflow script '${meta.name}' run loop failed after launch`,
              { data: error },
            );
          });
        }
      } catch (error) {
        throw await releaseOwnedExecutionLeaseAfterFailure(
          runExecutionId,
          error,
        );
      }

      if (parent.stopAfterCycle) {
        await runCompletion;
        const [report, runMeta] = await Promise.all([
          runStore.readReport(),
          runStore.readMeta(),
        ]);
        if (!report) {
          throw new Error(
            `Workflow script '${meta.name}' completed without a persisted report.`,
          );
        }
        if (runMeta?.terminalStatus !== EXECUTION_STATUS.COMPLETED) {
          return {
            status: 'error',
            summary: `Workflow script '${meta.name}' failed`,
            error: report,
          } satisfies ToolResult;
        }
        return {
          status: 'executed',
          summary: `Completed workflow script '${meta.name}'`,
          output: report,
        } satisfies ToolResult;
      }

      return withScriptReference(
        {
          status: 'executed',
          summary: `Launched workflow script '${meta.name}' (async)`,
          output: [
            `Workflow script '${meta.name}' launched. Its result and run log will be delivered automatically as a follow-up message when the run completes.`,
            `Execution ID: ${runExecutionId}`,
            `Stream tab: ${runChildStreamId}`,
            `The result arrives automatically — continue other work meanwhile. To check progress: executions tool with path=/executions/${runExecutionId}; use action=wait only when you cannot proceed without it.`,
            `To resume after a timeout or interruption: call this tool again with the same meta.name.`,
          ].join('\n'),
        },
        scriptPath,
      );
    });
    return Promise.resolve(runResult).catch((error: unknown) => {
      throw workflowScriptToolError(error, scriptPath);
    });
  }
}
