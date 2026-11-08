/**
 * What a child's end tells its parent: the envelope its parent's model
 * reads, built once at the child's terminal (`endRun`) from the run's
 * report, kept as the run's `run.report` and queued on the parent's input
 * by the end transaction (`endIn`). A subagent delivers its reply or its
 * failure; a background script its calls' summary, its failure, or, stopped
 * by a person, a notice naming the run to resume; a stopped subagent
 * delivers nothing.
 */
import { Effect } from 'effect';

import { SessionRoots } from '@platform/rootedFs';
import {
  RUN_OUTCOME,
  runEndErrorMessage,
  type RunStopReason,
} from '@shared/schemas';
import type { ToolRegistry } from '@tools/toolTable';
import type { SessionLog, SessionViewAccess } from '@shared/session/runHistory';

import { readRecipeResult } from './recipeResult';
import type { RunLaunch } from './run/AgentRun';
import type { RunReport } from './runReport';
import { scriptEndDelivery, scriptStopNotice } from './scriptRun';
import { formatSubagentDelivery, formatSubagentError } from './subagentResults';

/**
 * The report a child's end delivers, or null when it delivers nothing
 * (a stopped subagent, a script stopped by this process's shutdown).
 * `report` is the run's own, its outcome resolved by its end.
 */
export const childEndReport = Effect.fn('childEndReport')(function* (
  ctx: RunLaunch,
  report: RunReport,
  stop: RunStopReason | null,
  wallTimeMs: number,
): Effect.fn.Return<
  string | null,
  Error,
  SessionRoots | SessionLog | SessionViewAccess | ToolRegistry
> {
  const { runId, config } = ctx;
  const { script } = config;
  if (script?.kind === 'background') {
    if (report.outcome === RUN_OUTCOME.CANCELLED)
      return stop === 'user'
        ? yield* scriptStopNotice(runId, script.title, ctx.startedAt)
        : null;
    return yield* scriptEndDelivery(
      runId,
      script.title,
      report.outcome,
      report.failure === undefined ? null : runEndErrorMessage(report.failure),
      ctx.startedAt,
    );
  }
  const context = {
    runId,
    wallTimeMs,
    workingDirectory: ctx.workingDirectory,
    memoryMisses: report.memoryMisses,
    // A run resumed for a message reports again: said on the envelope, so
    // its parent tells the two reports apart.
    continued: ctx.entry.registration === null,
  };
  switch (report.outcome) {
    case RUN_OUTCOME.CANCELLED:
      return null;
    case RUN_OUTCOME.FAILED:
      return formatSubagentError(
        runId,
        config.agent,
        report.failure === undefined
          ? `The agent run ${runId} ended failed.`
          : runEndErrorMessage(report.failure),
        context,
      );
    case RUN_OUTCOME.COMPLETED: {
      // A completed recipe's value reads as its block says
      // (`AgentBlock.result`).
      const recipe = yield* readRecipeResult(
        config,
        runId,
        yield* SessionRoots,
      );
      return formatSubagentDelivery(
        config.agent,
        { outcome: report.outcome, output: report.output },
        { ...context, recipe },
      );
    }
  }
});
