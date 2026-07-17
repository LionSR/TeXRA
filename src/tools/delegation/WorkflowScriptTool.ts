// Third-party imports
import { z } from 'zod';

// Local imports - agent runtime
import { getExecutionStore } from '@agent/storage';
import {
  deriveWorkflowScriptCheckpointId,
  parseWorkflowScript,
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
import { formatResultCount, truncateSummary } from '@utils/text/stringUtils';

// Local imports - delegation
import { createWorkflowScriptAgentRunner } from './workflowScriptAgentRunner';
import {
  runPersistedWorkflowScriptWithProgress,
  sumCompletedWorkflowJournalCost,
  workflowJournalEntryCostIdentity,
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

const RUN_LOG_MAX_LINES = 80;
const RUN_LOG_MAX_LINE_LENGTH = 500;

interface RunLogCollector {
  readonly add: (line: string) => void;
  readonly format: () => string;
}

/** Retain a small, single-line tail for the invoking model. */
function createRunLogCollector(): RunLogCollector {
  const lines: string[] = [];
  let omitted = 0;
  return {
    add: (line) => {
      lines.push(truncateSummary(line, RUN_LOG_MAX_LINE_LENGTH));
      if (lines.length > RUN_LOG_MAX_LINES) {
        lines.shift();
        omitted += 1;
      }
    },
    format: () => {
      if (lines.length === 0) return '';
      const header =
        omitted > 0
          ? `=== Run log (last ${lines.length} lines; ${omitted} earlier lines omitted) ===`
          : '=== Run log ===';
      return `\n\n${header}\n${lines.join('\n')}`;
    },
  };
}

/** Execute a durable, deterministic workflow script from an opted-in agent. */
export class WorkflowScriptTool extends defineTool({
  name: DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME,
  description: `Run a deterministic JavaScript workflow that coordinates workflow agents. Workflow agents edit or produce FILES: each agent() call resolves to a result envelope { category: 'workflow', outcome, outputs, diffs, compileFailures, cost } listing the files it produced, never prose. Use this when the complete fan-out, pipeline, and join structure is known in advance and should resume safely after interruption.

Script rules: start with export const meta = { name, description }; no imports or require (only the injected primitives exist: agent, phase, log, parallel, pipeline, concat, and the args global). agent(), parallel(), and pipeline() return Promises: ALWAYS await them. agent(prompt, options) options: inputFiles (REQUIRED for file-editing agents; workspace paths, or a previous call's output paths to chain stages), agentName (another visible workflow agent; defaults to this tool's agent field), id (distinguish otherwise-identical calls), label, phase. A failed call inside parallel()/pipeline() resolves to null; filter with .filter(Boolean). The script's return value is this tool's result, followed by the run log (phases, log() lines, per-call outcomes with cost).

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
    // Named checkpoint, not content- or toolCallId-keyed: a retrying model
    // rewrites its script, so any key derived from call identity or source
    // text orphans the journal exactly when resume matters (#8666). meta.name
    // is the durable identity; per-entry prompt/options hashes in the journal
    // keep replays honest when the script evolves.
    const { meta } = parseWorkflowScript(input.script);
    const checkpointId = deriveWorkflowScriptCheckpointId({
      name: meta.name,
      defaultAgent: input.agent,
      parentExecutionId: parent.runScope.executionId,
    });
    if (!callContext.trace) {
      throw new Error(
        'delegate_workflow_script requires the parent progress trace.',
      );
    }

    const store = getExecutionStore(parent.runScope.executionId);
    // The stable child runner's native cost callback fires only for work that
    // executes in this attempt. Exact journal replays and stable-child
    // recoveries do not fire it, even when completion-order changes move a
    // recovered invocation key to another journal index.
    const executedEntries = new Set<string>();
    let costSettled = false;
    const settleCost = (journal: readonly WorkflowJournalEntry[]): void => {
      if (costSettled) return;
      const cost = sumCompletedWorkflowJournalCost(journal, executedEntries);
      costSettled = true;
      callContext.hooks?.recordSubagentCost?.(cost);
    };

    // Live display accumulator only: covers success and failure of this run's
    // live children (cached replays spend nothing). Boundary settlement below
    // stays journal-based so resumed runs still roll up replayed spend.
    let liveCostUsd = 0;
    const runLog = createRunLogCollector();
    let run: WorkflowScriptRunResult;
    try {
      run = await runPersistedWorkflowScriptWithProgress(callContext.trace, {
        store,
        checkpointId,
        script: input.script,
        ...(input.args !== undefined && { args: input.args }),
        signal: callContext.signal,
        runAgent: createWorkflowScriptAgentRunner(
          parent,
          input.agent,
          checkpointId,
          {
            onCost: (invocation, totalCostUsd) => {
              executedEntries.add(workflowJournalEntryCostIdentity(invocation));
              liveCostUsd += totalCostUsd ?? 0;
            },
          },
        ),
        getLiveCostUsd: () => liveCostUsd,
        onActivity: runLog.add,
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
      // The run log is the model's only view into what executed before the
      // failure; without it a timeout reads as total loss instead of
      // resumable progress.
      throw new Error(
        `${toErrorMessage(runError)}${runLog.format()}\n\nCompleted agent() calls are journaled under meta.name '${meta.name}': call this tool again with the same meta.name to resume without repeating them.`,
        { cause: runError },
      );
    }

    settleCost(run.journal);
    return {
      status: 'executed',
      summary: `Completed workflow script '${run.meta.name}' (${formatResultCount(run.agentCalls, 'agent call')})`,
      output: `${formatWorkflowResult(run.result)}${runLog.format()}`,
    };
  }
}
