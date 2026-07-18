// Third-party imports
import { z } from 'zod';

// Local imports - agent runtime
import {
  ExecutionLeaseActiveError,
  getExecutionStore,
  registerExecution,
  releaseOwnedExecutionLeaseAfterFailure,
} from '@agent/storage';
import {
  deriveWorkflowScriptCheckpointId,
  parseWorkflowScript,
} from '@agent/workflowScript';
import {
  AgentConfigSchema,
  type AgentConfigPayload,
} from '@agent/core/definition/AgentConfig';
import { startChildRunLoop } from '@agent/runtime/childRunLoop';
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';

// Local imports - shared schemas
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';

// Local imports - tools
import { configureDelegatedChildApprovals } from '@tools/approval';
import { createChildStream } from '@tools/childStream';
import { defineTool } from '@tools/core/define';

// Local imports - utilities
import { deriveExecutionId } from '@utils/core/idHash';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - delegation
import { createWorkflowScriptAgentRunner } from './workflowScriptAgentRunner';
import { createWorkflowScriptStrategy } from './workflowScriptStrategy';

const WorkflowScriptToolInputSchema = z.strictObject({
  agent: z
    .string()
    .min(1)
    .describe('Default workflow agent used when agent() omits agentName.'),
  script: z
    .string()
    .min(1)
    .describe(
      'Complete workflow script source, beginning with an export const meta object.',
    ),
  args: z
    .json()
    .nullish()
    .describe('JSON arguments exposed to the script as the global args value.'),
});

type WorkflowScriptToolInput = z.infer<typeof WorkflowScriptToolInputSchema>;

const STREAM_PREFIX = 'workflow-script';

/** Execute a durable, deterministic workflow script from an opted-in agent. */
export class WorkflowScriptTool extends defineTool({
  name: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  description: `Run a deterministic JavaScript workflow that coordinates workflow agents. Workflow agents edit or produce FILES: each agent() call resolves to a result envelope { category: 'workflow', outcome, outputs, diffs, compileFailures, cost } listing the files it produced, never prose. Use this when the complete fan-out, pipeline, and join structure is known in advance and should resume safely after interruption.

Script rules: start with export const meta = { name, description }; no imports or require (only the injected primitives exist: agent, phase, log, parallel, pipeline, concat, and the args global). agent(), parallel(), and pipeline() return Promises: ALWAYS await them. agent(prompt, options) options: inputFiles (REQUIRED for file-editing agents; workspace paths, or a previous call's output paths to chain stages), agentName (another visible workflow agent; defaults to this tool's agent field), id (distinguish otherwise-identical calls), label, phase. A failed call inside parallel()/pipeline() resolves to null; filter with .filter(Boolean).

Async: this tool returns immediately with an execution ID and runs the workflow as its own detached execution. The script's return value plus the run log (phases, log() lines, per-call outcomes with cost) are delivered back as a follow-up message when the run completes. Check intermediate progress with the executions tool (path=/executions/<id>, action=wait).

Example:
export const meta = { name: 'fix-drafts', description: 'Fix typos in two drafts', timeoutMs: 1800000 }
phase('Fix')
const results = await parallel([
  () => agent('Fix spelling errors only.', { inputFiles: ['draft1.tex'] }),
  () => agent('Fix spelling errors only.', { inputFiles: ['draft2.tex'] }),
])
const correctedFiles = results
  .filter(Boolean)
  .flatMap((result) => result.outputs.map((output) => output.absolutePath))
return await agent('Merge the corrected drafts.', { inputFiles: correctedFiles })

Durability: the journal is keyed by meta.name within this session. If the run times out or is interrupted, call this tool again with the SAME meta.name: completed agent() calls replay for free (the script may be revised; only changed or unfinished calls execute). Use a new meta.name to start over. The default whole-run wall clock is 10 minutes; set meta.timeoutMs (1s to 60min) for longer runs.

Tool inclusion is the opt-in boundary: do not add this tool to a default agent configuration.`,
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
    const { meta } = parseWorkflowScript(input.script);
    const checkpointId = deriveWorkflowScriptCheckpointId({
      name: meta.name,
      defaultAgent: input.agent,
      parentExecutionId: runScope.executionId,
    });

    // The run executionId is deterministic from the checkpoint identity, NOT a
    // fresh random id: a relaunch with the same meta.name regenerates the same
    // run id, so registration, stream, and grandchildren re-root at one stable
    // anchor and resume still replays completed calls (#8712). The journal
    // itself stays on the orchestrator store, where the checkpoint lives.
    const runExecutionId = deriveExecutionId({ checkpointId });
    const store = getExecutionStore(runScope.executionId);

    // Captured now, while the launching tool call's ALS frame is live, so the
    // detached run can still roll its cost into the parent after this call
    // returns. Undefined totals are skipped (a malformed-journal failure never
    // records a spurious cost).
    const recordSubagentCost = callContext?.hooks?.recordSubagentCost;
    const recordCost = (totalCostUsd: number | undefined): void => {
      if (totalCostUsd !== undefined) recordSubagentCost?.(totalCostUsd);
    };

    const runConfigPayload: AgentConfigPayload = {
      agent: input.agent,
      agentCategory: AgentCategory.Workflow,
      model: parent.model ?? DEFAULT_AGENT_MODEL,
      instruction: `Workflow script '${meta.name}'`,
      ...(runScope.workingDirectory !== undefined && {
        workingDirectory: runScope.workingDirectory,
      }),
    };
    const runConfig = AgentConfigSchema.parse(runConfigPayload);

    try {
      await registerExecution(
        runExecutionId,
        runConfig,
        meta.name,
        runScope.executionId,
      );
    } catch (error) {
      // A relaunch whose prior run is still in flight shares this deterministic
      // id: the fresh-lease acquisition fails closed rather than starting a
      // second competing run over the same journal. Point the model at the
      // live run instead of erroring.
      if (error instanceof ExecutionLeaseActiveError) {
        return {
          status: 'executed',
          summary: `Workflow script '${meta.name}' is already running`,
          output: [
            `A workflow script run for meta.name '${meta.name}' is already in progress (or finishing); its result arrives as a follow-up. Do not launch a competing run — wait for it, then resume with the same meta.name if it did not complete.`,
            `Execution ID: ${runExecutionId}`,
            `To check progress or collect the result: executions tool with path=/executions/${runExecutionId} and action=wait (returns immediately if it already finished).`,
          ].join('\n'),
        };
      }
      throw new ToolError(
        `Failed to launch workflow script '${meta.name}': ${toErrorMessage(error)}`,
      );
    }

    // createChildStream is inside the lease-protected try: it runs after the
    // deterministic run lease is held, so a throw here (missing subscribers,
    // duplicate stream tab) must release the lease — otherwise the lease
    // survives to its heartbeat timeout and a prompt relaunch is refused.
    let runChildStreamId: StreamTabId;
    try {
      const childStream = createChildStream(runExecutionId, runScope.streamId, {
        streamPrefix: STREAM_PREFIX,
        streamCategory: AgentCategory.Workflow,
        agentName: meta.name,
        description: meta.description,
        config: runConfig,
        toolName: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
        runtimeHost: runScope.runtimeHost,
      });
      runChildStreamId = childStream.childStreamId;

      // The run's own stream inherits the orchestrator's bypass so grandchild
      // agent() calls, which link to this stream, still resolve it transitively.
      configureDelegatedChildApprovals(
        runChildStreamId,
        runScope.streamId,
        'inherit',
        runScope.session,
      );

      startChildRunLoop({
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
          script: input.script,
          args: input.args,
          name: meta.name,
          session: runScope.session,
          createRunAgent: (hooks) =>
            createWorkflowScriptAgentRunner(
              parent,
              input.agent,
              checkpointId,
              { executionId: runExecutionId, streamId: runChildStreamId },
              hooks,
            ),
        }),
        recordCost,
      });
    } catch (error) {
      throw await releaseOwnedExecutionLeaseAfterFailure(runExecutionId, error);
    }

    return {
      status: 'executed',
      summary: `Launched workflow script '${meta.name}' (async)`,
      output: [
        `Workflow script '${meta.name}' launched. Its result and run log will be delivered automatically as a follow-up message when the run completes.`,
        `Execution ID: ${runExecutionId}`,
        `Stream tab: ${runChildStreamId}`,
        `To check intermediate progress: executions tool with path=/executions/${runExecutionId} and action=wait (waits for next status change).`,
        `To resume after a timeout or interruption: call this tool again with the same meta.name.`,
      ].join('\n'),
    };
  }
}
