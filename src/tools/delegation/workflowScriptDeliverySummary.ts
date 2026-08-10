// Local imports - agent runtime
import type {
  WorkflowJournalEntry,
  WorkflowScriptEvent,
  WorkflowScriptRunResult,
} from '@agent/workflowScript';
import { AgentFinalResultSchema } from '@agent/runtime/AgentFinalResult';

// Local imports - shared delivery schema
import type { WorkflowScriptDeliverySummary } from '@shared/schemas';
import { escapeText } from '@shared/utils/xmlEscape';

type WorkflowTaskOutcome = Extract<
  WorkflowScriptEvent,
  { type: 'agent:end' }
>['outcome'];

interface WorkflowDeliverySummaryCollector {
  readonly start: () => void;
  readonly onEvent: (event: WorkflowScriptEvent) => void;
  readonly settle: (
    run: Pick<WorkflowScriptRunResult, 'meta' | 'journal'> | undefined,
    costUsd: number,
  ) => void;
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
 */
export function createWorkflowDeliverySummaryCollector(
  name: string,
  scriptPath: string,
): WorkflowDeliverySummaryCollector {
  const phases = new Set<string>();
  const tasks = new Map<string, WorkflowTaskOutcome | 'planned' | 'running'>();
  const files = new Map<
    string,
    WorkflowScriptDeliverySummary['files'][number]
  >();
  let startedAt = Date.now();
  let declaredPhaseCount = 0;
  let declaredTaskCount = 0;
  let settledCostUsd = 0;

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
    onEvent: (event) => {
      switch (event.type) {
        case 'plan':
          declaredTaskCount = event.tasks.length;
          for (const task of event.tasks) tasks.set(task.id, 'planned');
          break;
        case 'phase':
          phases.add(event.title);
          break;
        case 'agent:start':
          tasks.set(event.progressId, 'running');
          break;
        case 'agent:end':
          tasks.set(event.progressId, event.outcome);
          break;
        case 'agent:stream':
        case 'log':
          break;
      }
    },
    settle: (run, costUsd) => {
      settledCostUsd = costUsd;
      if (!run) return;
      declaredPhaseCount = run.meta.phases?.length ?? phases.size;
      declaredTaskCount = run.meta.tasks?.length ?? tasks.size;
      collectJournalFiles(run.journal);
    },
    formatLine: (outcome, errorCause) => {
      const summary: WorkflowScriptDeliverySummary = {
        name,
        outcome,
        phaseCount: Math.max(declaredPhaseCount, phases.size),
        taskDone: [...tasks.values()].filter(
          (status) => status === 'completed' || status === 'cached',
        ).length,
        taskTotal: Math.max(declaredTaskCount, tasks.size),
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
