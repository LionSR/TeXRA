// Local imports - agent runtime
import type {
  WorkflowJournalEntry,
  WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';
import * as logger from '@logger/logUtils';

// Local imports - shared delivery schema
import {
  deriveWorkflowCounts,
  type WorkflowScriptDeliverySummary,
} from '@shared/schemas';
import { escapeText } from '@shared/utils/xmlEscape';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'WorkflowDeliverySummary';

/**
 * What the delivery line needs from a settled run: the canonical execution
 * snapshot the engine terminalizes (phase and task tallies) and the durable
 * journal (delivered files). A run that died before the engine published any
 * snapshot has none, and reports zero work.
 */
type SettledWorkflowRun = Pick<WorkflowScriptRunResult, 'journal'> & {
  readonly snapshot: WorkflowScriptRunResult['snapshot'] | undefined;
};

interface WorkflowDeliverySummaryCollector {
  readonly start: () => void;
  readonly settle: (run: SettledWorkflowRun, costUsd: number) => void;
  readonly formatLine: (
    outcome: 'completed' | 'failed',
    errorCause?: string,
  ) => string;
}

/**
 * Collect presentation facts without changing the model-facing run report.
 *
 * `taskDone` counts the tasks that produced a result (completed or cached),
 * which is deliberately narrower than the phase header's `done/total`
 * (workflowPhaseCallProgress), where every settled call counts, failures and
 * skips included. The two answer different questions, so the delivery line
 * labels its count "succeeded".
 *
 * Every task and phase number is read off the engine's own terminal snapshot —
 * the canonical record of what ran — so this line can never disagree with
 * `/executions/{id}` about the same run.
 */
export function createWorkflowDeliverySummaryCollector(
  name: string,
  scriptPath: string,
): WorkflowDeliverySummaryCollector {
  const files = new Map<
    string,
    WorkflowScriptDeliverySummary['files'][number]
  >();
  let startedAt = Date.now();
  let phaseCount = 0;
  let taskDone = 0;
  let taskTotal = 0;
  let settledCostUsd = 0;

  const collectJournalFiles = (journal: readonly WorkflowJournalEntry[]) => {
    for (const entry of journal) {
      const parsed = AgentFinalResultSchema.safeParse(entry.result);
      if (!parsed.success) {
        // Presentation tolerates what accounting does not: the cost path
        // (`workflowJournalEntryCost`) throws on this same corruption because
        // a mis-billed run is a correctness fault, while a delivery line that
        // omits one entry's files is merely incomplete. Loud either way — a
        // silently short file list is how corruption goes unreported.
        logger.warn(
          CHANNEL,
          `Workflow '${name}' journal entry ${entry.index} is not an agent final result; its delivered files are omitted from the summary: ${toErrorMessage(parsed.error)}`,
          { data: parsed.error },
        );
        continue;
      }
      if (parsed.data.category === 'workflow') {
        for (const output of parsed.data.outputs) {
          files.set(output.relativePath, {
            path: output.relativePath,
            added: output.added,
            removed: output.removed,
          });
        }
      } else {
        for (const path of parsed.data.files) {
          files.set(path, { path, added: null, removed: null });
        }
      }
    }
  };

  return {
    start: () => {
      startedAt = Date.now();
    },
    settle: (run, costUsd) => {
      settledCostUsd = costUsd;
      const counts = deriveWorkflowCounts(run.snapshot?.calls ?? []);
      phaseCount = run.snapshot?.stages.length ?? 0;
      taskDone = counts.completed + counts.cached;
      taskTotal = counts.total;
      collectJournalFiles(run.journal);
    },
    formatLine: (outcome, errorCause) => {
      const summary: WorkflowScriptDeliverySummary = {
        name,
        outcome,
        phaseCount,
        taskDone,
        taskTotal,
        costUsd: settledCostUsd,
        durationMs: Date.now() - startedAt,
        files: [...files.values()],
        scriptPath,
        errorCause: errorCause ?? null,
      };
      return `<workflow-summary>${escapeText(JSON.stringify(summary))}</workflow-summary>`;
    },
  };
}
