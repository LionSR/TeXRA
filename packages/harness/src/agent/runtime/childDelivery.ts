/**
 * What a run's end tells the runs it worked for (a child's parent, and any
 * run whose message it took): its delivery, built once at the run's
 * terminal (`endRun`) from the run's report, kept rendered as the run's
 * `run.report` and queued typed on each recipient's input by the end
 * transaction (`endIn`). A subagent, or a root another run asked, delivers
 * its reply or its failure; a background script its calls' summary, its
 * failure, or, stopped by a person, a notice naming the run to resume; a
 * subagent stopped at its own spend cap says so, and one stopped any other
 * way delivers nothing.
 */
import { Effect } from 'effect';

import { logFailure } from '@logger/effectLog';
import { SessionRoots } from '@platform/rootedFs';
import { DELIVERY_FAMILY } from '@shared/deliveryTags';
import {
  backgroundScriptOf,
  RUN_OUTCOME,
  runEndErrorMessage,
  type AttachedMemoryMiss,
  type ChildRunDelivery,
} from '@shared/schemas';
import { escapeAttr, escapeText } from '@shared/utils/xmlEscape';
import type { ToolRegistry } from '@tools/toolTable';
import { SessionViewAccess, type SessionLog } from '@shared/session/runHistory';
import type { RunRows } from '@shared/session/runRowsShape';

import { readProgramResult } from './programRun';
import { capReached } from './spendCap';
import type { RunLaunch } from './run/AgentRun';
import type { RunReport } from './runReport';
import { scriptEndDelivery, scriptStopNotice } from './scriptRun';

/** The run lifecycle's log channel (`AgentRunLifecycle.ts`, which imports
 *  this module, names the same). */
const CHANNEL = 'agentRunLifecycle';

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
 * The delivery a run's end makes, or null when it delivers nothing
 * (a stopped agent run, a script its awaiting call released).
 * `report` is the run's own, its outcome resolved by its end; `record` is
 * what its rows say before the end (its stop, an earlier report). A
 * report that cannot be built is delivered as that failure, in the run's
 * family, rather than lost.
 */
export const childEndReport = Effect.fn('childEndReport')(
  function* (
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
    const script = backgroundScriptOf(config);
    if (script !== null) {
      if (report.outcome === RUN_OUTCOME.CANCELLED)
        return record?.stop?.reason === 'user'
          ? yield* scriptStopNotice(runId, script.title, ctx.startedAt)
          : null;
      return yield* scriptEndDelivery(
        runId,
        script.title,
        report.outcome,
        report.failure === undefined
          ? null
          : runEndErrorMessage(report.failure),
        ctx.startedAt,
      );
    }
    const delivery = {
      family: DELIVERY_FAMILY.subagent,
      runId,
      wallTimeMs,
      lines: contextLines(ctx.workingDirectory, report.memoryMisses ?? []),
    };
    const agent = { name: 'agent', value: config.agent };
    switch (report.outcome) {
      case RUN_OUTCOME.CANCELLED: {
        // Stopped at its own cap: its parent, which may not be waiting for
        // it, reads why. Any other stop is its stopper's to report.
        const capped = capReached(
          yield* (yield* SessionViewAccess).read([]),
          runId,
          record?.stop?.reason,
        );
        return capped === null
          ? null
          : {
              ...delivery,
              attributes: [agent],
              message: `The agent run ${runId} ${capped}`,
            };
      }
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
        // A completed program's value reads as its registration says
        // (`Program.result`); any other run's is its reply and the files
        // its tool calls touched.
        const program = yield* readProgramResult(
          config,
          runId,
          yield* SessionRoots,
        );
        const { output } = report;
        return {
          ...delivery,
          attributes: [
            agent,
            ...(program === undefined
              ? []
              : [{ name: 'kind', value: program.name }]),
            { name: 'status', value: report.outcome },
            // A run that reported before (resumed for a message after its
            // end) reports again: said on the envelope, so its parent tells
            // the two reports apart.
            ...(record?.report == null
              ? []
              : [{ name: 'continued', value: 'true' }]),
          ],
          ...(program !== undefined && program.delivery.length > 0
            ? { lines: [...delivery.lines, ...program.delivery] }
            : { output: { response: output.response, files: output.files } }),
        };
      }
    }
  },
  (built, { runId, config }, report) =>
    Effect.catch(built, (unbuilt) =>
      Effect.as(
        logFailure(
          CHANNEL,
          `Run ${runId}: its report could not be built`,
        )({
          runId,
          error: unbuilt,
        }),
        {
          family:
            backgroundScriptOf(config) === null
              ? DELIVERY_FAMILY.subagent
              : DELIVERY_FAMILY.script,
          runId,
          message: `The run ${runId} ended ${report.outcome}, but its report could not be built: ${unbuilt.message}`,
        } satisfies ChildRunDelivery,
      ),
    ),
);
