/**
 * What a child's end tells its parent: its delivery, built once at the
 * child's terminal (`endRun`) from the run's report, kept rendered as the
 * run's `run.report` and queued typed on the parent's input by the end
 * transaction (`endIn`). A subagent delivers its reply or its failure; a
 * background script its calls' summary, its failure, or, stopped by a
 * person, a notice naming the run to resume; a stopped subagent delivers
 * nothing.
 */
import { Effect } from 'effect';

import { SessionRoots } from '@platform/rootedFs';
import { DELIVERY_FAMILY } from '@shared/deliveryTags';
import {
  RUN_OUTCOME,
  runEndErrorMessage,
  type AttachedMemoryMiss,
  type ChildRunDelivery,
} from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import type { ToolRegistry } from '@tools/toolTable';
import type { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import type { RunRows } from '@shared/session/runRowsShape';

import { readRecipeResult } from './recipeResult';
import type { RunLaunch } from './run/AgentRun';
import type { RunReport } from './runReport';
import { scriptEndDelivery, scriptStopNotice } from './scriptRun';

/** A subagent's context lines, after its wall time: its working directory,
 *  then the memories its launch named and could not attach. */
function contextLines(
  workingDirectory: string | undefined,
  misses: readonly AttachedMemoryMiss[],
): string[] {
  const lines: string[] = [];
  if (workingDirectory) {
    lines.push(
      `<working-directory>${escapeText(workingDirectory)}</working-directory>`,
    );
  }
  if (misses.length > 0) {
    lines.push(
      '<memory-misses>',
      ...misses.map(
        (miss) =>
          `<memory-miss path="${escapeAttr(miss.path)}" reason="${escapeAttr(miss.reason)}" />`,
      ),
      '</memory-misses>',
    );
  }
  return lines;
}

/**
 * The delivery a child's end makes, or null when it delivers nothing
 * (a stopped subagent, a script stopped by this process's shutdown).
 * `report` is the run's own, its outcome resolved by its end; `record` is
 * what its rows say before the end (its stop, an earlier report).
 */
export const childEndReport = Effect.fn('childEndReport')(function* (
  ctx: RunLaunch,
  report: RunReport,
  record: RunRows | null,
  wallTimeMs: number,
): Effect.fn.Return<
  ChildRunDelivery | null,
  Error,
  SessionRoots | SessionLog | SessionViewAccess | ToolRegistry
> {
  const { runId, config } = ctx;
  const { script } = config;
  if (script?.kind === 'background') {
    if (report.outcome === RUN_OUTCOME.CANCELLED)
      return record?.stop?.reason === 'user'
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
  const delivery = {
    family: DELIVERY_FAMILY.subagent,
    runId,
    wallTime: `${(wallTimeMs / 1000).toFixed(1)}s`,
    lines: contextLines(ctx.workingDirectory, report.memoryMisses ?? []),
  };
  const agent = { name: 'agent', value: config.agent };
  switch (report.outcome) {
    case RUN_OUTCOME.CANCELLED:
      return null;
    case RUN_OUTCOME.FAILED:
      return {
        ...delivery,
        attributes: [agent],
        message:
          report.failure === undefined
            ? `The agent run ${runId} ended failed.`
            : runEndErrorMessage(report.failure),
      };
    case RUN_OUTCOME.COMPLETED: {
      // A completed recipe's value reads as its block says
      // (`AgentBlock.result`); any other run's is its reply and the files
      // its tool calls touched.
      const recipe = yield* readRecipeResult(
        config,
        runId,
        yield* SessionRoots,
      );
      const { output } = report;
      return {
        ...delivery,
        attributes: [
          agent,
          ...(recipe === undefined
            ? []
            : [{ name: 'kind', value: recipe.key }]),
          { name: 'status', value: report.outcome },
          // A run that reported before (resumed for a message after its
          // end) reports again: said on the envelope, so its parent tells
          // the two reports apart.
          ...(record?.report == null
            ? []
            : [{ name: 'continued', value: true }]),
        ],
        ...(recipe !== undefined && recipe.delivery.length > 0
          ? { lines: [...delivery.lines, ...recipe.delivery] }
          : { output: { response: output.response, files: output.files } }),
      };
    }
  }
});
