/**
 * A background script's run: the `script` call a parent sent to the
 * background, made by a child run of its own (`AgentConfig.script`). The run
 * is the native tool-use program whose one response is that call, so it
 * replays from its rows as a foreground script does. This is what it tells
 * its parent: the strategy that delivers its result once, and the fold of
 * its rows that summarizes it (its calls, the files they wrote, what its
 * children spent).
 */
import { Clock, Effect } from 'effect';
import { z } from 'zod';
import type { AgentRunServices } from '@agent/runtime/runRegistry';

import type { ChildRunStrategy } from '@agent/runtime/childRunLoop';
import { createNativeSubagentStrategy } from '@agent/runtime/nativeSubagentStrategy';
import { formatDelivery } from '@agent/runtime/deliveryEnvelope';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { DELIVERY_TAG } from '@shared/deliveryTags';
import { stripWorkflowRoundDir } from '@shared/constants/workflowOutput';
import {
  qualifyAggregateId,
  OutputFileSummarySchema,
  type OutputFileSummary,
  type RunId,
  type ToolResultPayload,
  type ScriptDeliverySummary,
  type ScriptTally,
} from '@shared/schemas';
import { scriptSummaryElement } from '@shared/subagentFollowup';
import { isPathWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { workspaceRelativePath } from '@utils/files/workspaceFS';

/** What became of one call a script issued, as its rows say. */
type ScriptCallStatus =
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'cancelled'
  /** No settlement yet: running while the run is, cut short after. */
  | 'unsettled';

export interface ScriptCallCard {
  readonly seq: number;
  readonly toolName: string;
  readonly phase: string | null;
  readonly attempt: number;
  readonly status: ScriptCallStatus;
  readonly reusedFrom: string | null;
  /** The call's error, when it failed or was skipped. */
  readonly error: string | null;
  /** What the guest's `await` got in place of `{ output, summary }`. */
  readonly value: unknown;
}

const statusOf = (settled: ToolResultPayload | undefined): ScriptCallStatus => {
  if (settled === undefined) return 'unsettled';
  if (settled.result.status === 'executed') return 'completed';
  if (settled.disposition === 'cancelled') return 'cancelled';
  if (settled.disposition === 'skipped' || settled.result.name === 'Skipped')
    return 'skipped';
  return 'failed';
};

/**
 * The run's script call's settlement and the calls its script issued, in
 * issue order, from the run's `script.call` and `tool.result` rows. The
 * script's own host functions (`searchTools()`, `describeTool()`) answer
 * from the catalog and open no card, so they are not among the calls.
 */
export const scriptRunCalls = Effect.fn('scriptRun.calls')(function* (
  session: SessionHandle,
  runId: RunId,
) {
  const rows = yield* session.log.rows(qualifyAggregateId('run', runId), [
    'script.call',
    'tool.result',
  ]);
  const settled = new Map<string, ToolResultPayload>();
  for (const row of rows) {
    if (row.type !== 'tool.result') continue;
    const known = settled.get(row.payload.callId);
    if (known === undefined || known.attempt <= row.payload.attempt)
      settled.set(row.payload.callId, row.payload);
  }
  const script =
    [...settled.values()].find(({ callId }) => !callId.includes('/')) ?? null;
  const calls = rows.flatMap((row): ScriptCallCard[] => {
    if (row.type !== 'script.call' || row.payload.toolName.endsWith('()'))
      return [];
    const { seq, toolName, phase, callId } = row.payload;
    const result = settled.get(callId);
    const error =
      result?.result.status === 'error' ? result.result.error : null;
    return [
      {
        seq,
        toolName,
        phase,
        attempt: result?.attempt ?? 1,
        status: statusOf(result),
        reusedFrom:
          result?.result.status === 'executed'
            ? (result.result.reusedFrom ?? null)
            : null,
        error,
        value:
          result?.result.status === 'executed' ? result.result.value : null,
      },
    ];
  });
  return { script, calls };
});

/** The files a call's child wrote, when its value is a run's envelope: a
 *  document task's outputs, or an agent's edits. */
const EnvelopeFilesSchema = z.object({
  files: z.array(z.string()),
  documents: z.object({ outputs: z.array(OutputFileSummarySchema) }).optional(),
});

/**
 * A delivered file as the workspace file it replaces, not the run-storage
 * copy that carries it. A diff base in run storage that no earlier call
 * delivered is a child's `original/` snapshot of the input, and then the
 * output's round-relative name is the workspace path.
 */
function deliveredFilePath(
  roots: SessionHandle['roots'],
  output: {
    readonly relativePath: string;
    readonly originalPath: string | null;
  },
): string {
  return output.originalPath === null ||
    isPathWithin(roots.storage, output.originalPath)
    ? stripWorkflowRoundDir(output.relativePath)
    : workspaceRelativePath(roots.workspace, output.originalPath);
}

/** A document's count over the calls that wrote it: a call that reports
 *  none (an agent's edit) leaves the total unknown from then on. */
const summed = (
  prior: number | null | undefined,
  next: number | null,
): number | null => (prior == null || next === null ? next : prior + next);

/**
 * The files the calls wrote, one row per workspace document. A later call
 * whose diff base is an earlier call's output (a merge stage over a fix
 * stage's file) continues that document's row, with its counts summed over
 * the calls; within a call, every revision is diffed against the same
 * pre-run snapshot, so the call's change is its last revision's.
 */
function deliveredFiles(
  roots: SessionHandle['roots'],
  calls: readonly ScriptCallCard[],
): ScriptDeliverySummary['files'] {
  const files = new Map<string, ScriptDeliverySummary['files'][number]>();
  /** Each delivered output by its absolute path, for a later call's base. */
  const delivered = new Map<string, string>();
  const add = (
    path: string,
    added: number | null,
    removed: number | null,
  ): void => {
    const prior = files.get(path);
    files.set(path, {
      path,
      added: summed(prior?.added, added),
      removed: summed(prior?.removed, removed),
    });
  };
  for (const call of calls) {
    const envelope = EnvelopeFilesSchema.safeParse(call.value);
    if (!envelope.success) continue;
    const { documents } = envelope.data;
    if (documents === undefined) {
      for (const path of envelope.data.files) add(path, null, null);
      continue;
    }
    const latest = new Map<string, OutputFileSummary>();
    for (const output of documents.outputs) {
      const path =
        (output.originalPath === null
          ? undefined
          : delivered.get(output.originalPath)) ??
        deliveredFilePath(roots, output);
      delivered.set(output.absolutePath, path);
      if ((latest.get(path)?.round ?? -1) <= output.round)
        latest.set(path, output);
    }
    for (const [path, { added, removed }] of latest) add(path, added, removed);
  }
  return [...files.values()];
}

/**
 * The summary line of a script run, folded from its rows: the tally of its
 * calls, what the runs under it spent, how long it has run, the files its
 * agent calls wrote with their diffstat, and the cause when it failed.
 */
const scriptRunSummary = Effect.fn('scriptRun.summary')(function* (
  session: SessionHandle,
  runId: RunId,
  name: string,
  outcome: ScriptDeliverySummary['outcome'],
  errorCause: string | null,
  /** When this launch or resume of the run started: what the duration
   *  counts from, never an idle gap. */
  startedAt: number,
) {
  const { calls } = yield* scriptRunCalls(session, runId);
  const view = yield* session.view.read([]);
  const now = yield* Clock.currentTimeMillis;
  const tally: ScriptTally = {
    total: calls.length,
    ok: 0,
    failed: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const call of calls) {
    switch (call.status) {
      case 'completed':
        tally.ok += 1;
        break;
      case 'unsettled':
        tally.cancelled += 1;
        break;
      case 'failed':
      case 'skipped':
      case 'cancelled':
        tally[call.status] += 1;
        break;
      default:
        call.status satisfies never;
    }
  }
  return {
    name,
    outcome,
    phaseCount: new Set(calls.flatMap(({ phase }) => phase ?? [])).size,
    tally,
    costUsd: view.runs.get(runId)?.treeUsage.cost ?? 0,
    durationMs: Math.max(0, Math.round(now - startedAt)),
    files: deliveredFiles(session.roots, calls),
    errorCause,
  } satisfies ScriptDeliverySummary;
});

const resumeHint = (runId: RunId): string =>
  `Nothing continues it on its own. Resuming run ${runId} hands its finished calls back from its rows and runs the rest.`;

/**
 * The strategy a background script's run takes: the native tool-use child,
 * whose turn is the script, delivering once under one id, so a resumed run's
 * delivery is a replay of one its earlier owner admitted. A script that
 * failed is a completed run whose delivery says so; a user's stop leaves a
 * notice naming the run to resume.
 */
export function createScriptRunStrategy(
  params: Parameters<typeof createNativeSubagentStrategy>[0] & {
    readonly title: string;
  },
): ChildRunStrategy<RunEndResult, AgentRunServices> {
  const { session, runId, title, startedAt } = params;
  const attributes = [{ name: 'title', value: title }];
  return {
    ...createNativeSubagentStrategy(params),
    stageLabel: `Script '${title}'`,
    deliveryId: `${runId}:script:delivery`,
    formatDelivery: () =>
      Effect.gen(function* () {
        const { script } = yield* scriptRunCalls(session, runId);
        if (script?.result.status === 'executed')
          return formatDelivery({
            tag: DELIVERY_TAG.scriptResult,
            runId,
            attributes,
            response: script.result.output ?? '',
            lines: [
              scriptSummaryElement(
                yield* scriptRunSummary(
                  session,
                  runId,
                  title,
                  'completed',
                  null,
                  startedAt,
                ),
              ),
            ],
          });
        const cause =
          script?.result.status === 'error'
            ? script.result.error
            : 'The script ended without a result.';
        return formatDelivery({
          tag: DELIVERY_TAG.scriptError,
          runId,
          attributes,
          lines: [
            scriptSummaryElement(
              yield* scriptRunSummary(
                session,
                runId,
                title,
                'failed',
                cause,
                startedAt,
              ),
            ),
          ],
          message: cause,
        });
      }),
    formatError: (_turn, err) =>
      formatDelivery({
        tag: DELIVERY_TAG.scriptError,
        runId,
        attributes,
        message: `${toErrorMessage(err)}\n${resumeHint(runId)}`,
      }),
    stopNotice: () =>
      Effect.gen(function* () {
        const summary = yield* scriptRunSummary(
          session,
          runId,
          title,
          'stopped',
          null,
          startedAt,
        );
        return formatDelivery({
          tag: DELIVERY_TAG.scriptError,
          runId,
          attributes,
          lines: [scriptSummaryElement(summary)],
          message: `The script '${title}' was stopped after ${summary.tally.ok} of ${summary.tally.total} calls. ${resumeHint(runId)}`,
        });
      }),
  };
}
