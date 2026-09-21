/**
 * The plain-text workflow progress of `texra run` (PRD
 * one-fold-three-renderers, 10.3): what the session view's workflow runs say,
 * printed as their lines change. It reads `SessionHandle.view` and derives
 * nothing the fold already states; it keeps only what it last printed.
 */
import { SubscriptionRef } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
import { descendantRuns, type RunView } from '@shared/session/sessionView';
import { formatWorkflowPhaseHeading } from '@ui/copy/workflowCall';

import { claimRootRun, followView } from './sessionViewFollow';

/** The plain workflow output also subscribes the workflow transcripts it
 *  prints, since transcript rows fold only for subscribed aggregates. */
export type WorkflowPlainSession = Pick<
  SessionHandle,
  'view' | 'setTranscriptSubscriptions'
>;

interface WorkflowPlainOutputOptions {
  /** The launched run when the request names it, else the first top-level
   *  run created after attach: the output prints the workflow runs
   *  under it. */
  readonly runId?: RunId;
  readonly writeLine: (line: string) => void;
  readonly beforeWrite?: () => void;
}

/** The lines one workflow-script run's view level says: phase headings,
 *  task lines, log lines, and its outcome, keyed by the row they come from. */
function workflowPlainLines(run: RunView): ReadonlyMap<string, string> {
  const lines = new Map<string, string>();
  const model = run.transcript.run;
  for (const phase of model?.phases ?? []) {
    if (phase.opened) {
      lines.set(
        `phase:${phase.key}`,
        `◆ ${formatWorkflowPhaseHeading(phase.heading)}`,
      );
    }
  }
  for (const row of run.transcript.rows) {
    if (row.kind === 'workflowTask') {
      lines.set(row.id, row.line);
    } else if (
      row.kind === 'log' &&
      row.level !== 'debug' &&
      row.verbose !== false &&
      row.text.full.trim().length > 0
    ) {
      lines.set(row.id, row.text.full);
    }
  }
  if (
    isTerminalOutcomePhase(run.status) &&
    run.identity?.kind === 'multiAgentWorkflow'
  ) {
    // `run.status` is a run phase, so the word comes from the fold's own
    // run-status label, never from the workflow-*call* status table the two
    // vocabularies happen to share four key names with.
    lines.set('outcome', `${run.statusLabel}: ${run.identity.workflowName}`);
  }
  return lines;
}

/**
 * The plain-text workflow progress of `texra run` (text output): what
 * `transcript.run` and the run's rows say, printed as they change
 * between consecutive view levels (PRD 10.3), for the workflow runs in
 * the launched run's subtree. A line prints when its entry is new or
 * reads differently than at the previous level; nothing here folds, gates,
 * or relabels.
 */
export function attachWorkflowPlainOutput(
  runtime: ProcessRuntime,
  session: WorkflowPlainSession,
  options: WorkflowPlainOutputOptions,
): () => void {
  const previous = new Map<RunId, ReadonlyMap<string, string>>();
  let subscribed = '';
  let rootRunId: RunId | undefined;
  const attachCursor = SubscriptionRef.getUnsafe(session.view).cursor;
  const write = (line: string): void => {
    options.beforeWrite?.();
    options.writeLine(line);
  };
  const printRun = (run: RunView): void => {
    const before = previous.get(run.id);
    const lines = workflowPlainLines(run);
    previous.set(run.id, lines);
    for (const [id, line] of lines) {
      if (before?.get(id) !== line) write(line);
    }
  };
  const detach = followView(runtime, session, (view) => {
    for (const runId of [...previous.keys()]) {
      if (!view.runs.has(runId)) previous.delete(runId);
    }
    // The view also holds every earlier run hydrated from the transcript
    // summary; only the launched run's own subtree is this run's output.
    rootRunId ??= claimRootRun(view, options.runId, attachCursor);
    const root = rootRunId;
    const rootedIds =
      root === undefined
        ? undefined
        : new Set(descendantRuns(view, root, { includeRoot: true }));
    const workflows =
      rootedIds === undefined
        ? []
        : [...view.runs.values()].filter(
            (run) =>
              run.identity?.kind === 'multiAgentWorkflow' &&
              rootedIds.has(run.id),
          );
    const key = workflows.map((run) => run.id).join('\0');
    if (key !== subscribed) {
      subscribed = key;
      runtime.runFork(
        session.setTranscriptSubscriptions(
          'workflow-plain-output',
          workflows.map((run) => ({ id: run.id, fromSeq: 0 })),
        ),
      );
    }
    for (const run of workflows) printRun(run);
  });
  return () => {
    detach();
    previous.clear();
    runtime.runFork(
      session.setTranscriptSubscriptions('workflow-plain-output', []),
    );
  };
}
