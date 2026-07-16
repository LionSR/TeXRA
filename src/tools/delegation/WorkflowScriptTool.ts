// Third-party imports
import { z } from 'zod';

// Local imports - agent runtime
import { getExecutionStore } from '@agent/storage';
import {
  readWorkflowScriptCheckpoint,
  type WorkflowJournalEntry,
  type WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { getCurrentToolContexts } from '@agent/followUp/ToolFileInteractionContext';

// Local imports - shared schemas
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import type { ToolResult } from '@shared/schemas/toolResult';

// Local imports - tools
import { defineTool } from '@tools/core/define';

// Local imports - utilities
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';

// Local imports - delegation
import { createWorkflowScriptAgentRunner } from './workflowScriptAgentRunner';
import {
  runPersistedWorkflowScriptWithProgress,
  sumCompletedWorkflowJournalCost,
} from './workflowScriptRun';

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

function formatWorkflowResult(result: unknown): string {
  if (typeof result === 'string') return result;
  return JSON.stringify(result, null, 2) ?? 'undefined';
}

/** Execute a durable, deterministic workflow script from an opted-in agent. */
export class WorkflowScriptTool extends defineTool({
  name: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  description: `Run a deterministic JavaScript workflow that coordinates one or more workflow agents. Use this when the complete fan-out, pipeline, and join structure is known in advance and should resume safely after interruption. The script must start with export const meta = { name, description } and may call agent(prompt, options), phase(title), log(message), parallel(thunks), pipeline(items, ...stages), and concat(parts, options). Its final return value is delivered as this tool's result.

Available agents: loaded from the active roster at runtime.

The agent field is the default for agent() calls; a call may select another visible workflow agent with options.agentName. Model selection follows the active model access mode automatically. Tool inclusion is the opt-in boundary: do not add this tool to a default agent configuration.`,
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
    const checkpointId = callContext.toolCallId;
    if (!checkpointId) {
      throw new Error(
        'delegate_workflow_script requires a tool call id for durable resume.',
      );
    }
    if (!callContext.trace) {
      throw new Error(
        'delegate_workflow_script requires the parent progress trace.',
      );
    }

    const store = getExecutionStore(parent.runScope.executionId);
    let costSettled = false;
    const settleCost = (journal: readonly WorkflowJournalEntry[]): void => {
      if (costSettled) return;
      const cost = sumCompletedWorkflowJournalCost(journal);
      costSettled = true;
      callContext.hooks?.recordSubagentCost?.(cost);
    };

    // Live display accumulator only: covers success and failure of this run's
    // live children (cached replays spend nothing). Boundary settlement below
    // stays journal-based so resumed runs still roll up replayed spend.
    let liveCostUsd = 0;
    let run: WorkflowScriptRunResult;
    try {
      run = await runPersistedWorkflowScriptWithProgress(callContext.trace, {
        store,
        checkpointId,
        script: input.script,
        args: input.args,
        signal: callContext.signal,
        runAgent: createWorkflowScriptAgentRunner(
          parent,
          input.agent,
          checkpointId,
          {
            onCost: (totalCostUsd) => {
              liveCostUsd += totalCostUsd ?? 0;
            },
          },
        ),
        getLiveCostUsd: () => liveCostUsd,
      });
    } catch (runError) {
      try {
        const checkpoint = await readWorkflowScriptCheckpoint(
          store,
          checkpointId,
        );
        settleCost(checkpoint?.journal ?? []);
      } catch (settlementError) {
        throw new AggregateError(
          [runError, settlementError],
          `Workflow script failed: ${toErrorMessage(runError)} Cost settlement also failed: ${toErrorMessage(settlementError)}`,
        );
      }
      throw runError;
    }

    settleCost(run.journal);
    return {
      status: 'executed',
      summary: `Completed workflow script '${run.meta.name}' (${formatResultCount(run.agentCalls, 'agent call')})`,
      output: formatWorkflowResult(run.result),
    };
  }
}
