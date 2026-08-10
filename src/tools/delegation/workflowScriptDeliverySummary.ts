// Local imports - agent runtime
import type {
  WorkflowJournalEntry,
  WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';

// Local imports - shared delivery schema
import type { WorkflowScriptDeliverySummary } from '@shared/schemas';
import { escapeText } from '@shared/utils/xmlEscape';

// Local file imports
import {
  EMPTY_WORKFLOW_SCRIPT_RUN_FACTS,
  type WorkflowScriptRunFacts,
} from './workflowScriptRun';

export interface WorkflowDeliverySummaryCollector {
  readonly start: () => void;
  readonly settle: (
    run: Pick<WorkflowScriptRunResult, 'meta' | 'journal'> | undefined,
    costUsd: number,
    facts: WorkflowScriptRunFacts,
  ) => void;
  readonly formatLine: (
    outcome: 'completed' | 'failed',
    errorCause?: string,
  ) => string;
}

/**
 * Collect presentation facts without changing the model-facing run report.
 * Per-call outcomes are not re-folded here: they derive from the run fold in
 * `workflowScriptRun`, the single state machine over the run's event stream.
 *
 * `taskDone` counts the tasks that produced a result (completed or cached),
 * which is deliberately narrower than the phase header's `done/total`
 * (workflowPhaseCallProgress), where every settled call counts, failures and
 * skips included. The two answer different questions, so the delivery line
 * labels its count "succeeded".
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
  let declaredPhaseCount = 0;
  let declaredTaskCount = 0;
  let settledCostUsd = 0;
  let facts: WorkflowScriptRunFacts = EMPTY_WORKFLOW_SCRIPT_RUN_FACTS;

  const collectJournalFiles = (journal: readonly WorkflowJournalEntry[]) => {
    for (const entry of journal) {
      const parsed = AgentFinalResultSchema.safeParse(entry.result);
      if (!parsed.success) continue;
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
    settle: (run, costUsd, runFacts) => {
      settledCostUsd = costUsd;
      facts = runFacts;
      if (!run) return;
      declaredPhaseCount = run.meta.phases?.length ?? facts.announcedPhaseCount;
      declaredTaskCount = run.meta.tasks?.length ?? facts.declaredTaskCount;
      collectJournalFiles(run.journal);
    },
    formatLine: (outcome, errorCause) => {
      const summary: WorkflowScriptDeliverySummary = {
        name,
        outcome,
        phaseCount: Math.max(declaredPhaseCount, facts.announcedPhaseCount),
        taskDone: [...facts.callOutcomes.values()].filter(
          (status) => status === 'completed' || status === 'cached',
        ).length,
        taskTotal: Math.max(declaredTaskCount, facts.callOutcomes.size),
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
