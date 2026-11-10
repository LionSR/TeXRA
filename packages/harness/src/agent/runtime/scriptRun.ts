/**
 * A background script's run: the `script` call a parent sent to the
 * background, made by a child run of its own (`AgentConfig.script`). The run
 * is the native tool-use program whose one response is that call, so it
 * replays from its rows as a foreground script does. This is what it tells
 * its parent at its end (`childEndReport`): the fold of its rows that
 * summarizes it (its calls, the files they wrote, what its children spent),
 * as its result, its failure, or the notice a person's stop leaves.
 */
import { Clock, Effect, Result, Schema } from 'effect';

import { SessionLog, SessionViewAccess } from '@shared/session/runHistory';
import { DELIVERY_FAMILY } from '@shared/deliveryTags';
import {
  qualifyAggregateId,
  RUN_OUTCOME,
  type ChildRunDelivery,
  type RunId,
  type RunOutcome,
  type ToolResultPayload,
  type ScriptDeliverySummary,
  type ScriptTally,
} from '@shared/schemas';

/** What became of one call a script issued, as its rows say. */
type ScriptCallOutcome =
  | 'completed'
  | 'failed'
  | 'skipped'
  /** No settlement yet: running while the run is, cut short after. */
  | 'unsettled';

export interface ScriptCallCard {
  readonly seq: number;
  readonly toolName: string;
  readonly section: string | null;
  readonly attempt: number;
  readonly status: ScriptCallOutcome;
  readonly reusedFrom: string | null;
  /** The call's error, when it failed or was skipped. */
  readonly error: string | null;
  /** What the guest's `await` got in place of `{ output, summary }`. */
  readonly value: unknown;
}

const statusOf = (
  settled: ToolResultPayload | undefined,
): ScriptCallOutcome => {
  if (settled === undefined) return 'unsettled';
  if (settled.result.status === 'executed') return 'completed';
  if (settled.disposition === 'skipped' || settled.result.name === 'Skipped')
    return 'skipped';
  return 'failed';
};

/**
 * The run's script call's settlement and the calls its script issued, in
 * issue order, from the run's script calls and its calls' results (the
 * `script` read). The script's own host functions (`searchTools()`,
 * `describeTool()`) answer from the catalog and open no card, so they are
 * not among the calls.
 */
export const scriptRunCalls = Effect.fn('scriptRun.calls')(function* (
  runId: RunId,
) {
  const { scriptCalls, results } = yield* (yield* SessionLog).runRows(
    qualifyAggregateId('run', runId),
    'script',
  );
  const settled = new Map<string, ToolResultPayload>();
  for (const payload of results) {
    const known = settled.get(payload.callId);
    if (known === undefined || known.attempt <= payload.attempt)
      settled.set(payload.callId, payload);
  }
  const script =
    [...settled.values()].find(({ callId }) => !callId.includes('/')) ?? null;
  const calls = scriptCalls.flatMap((call): ScriptCallCard[] => {
    if (call.toolName.endsWith('()')) return [];
    const { seq, toolName, section, callId } = call;
    const result = settled.get(callId);
    const error =
      result?.result.status === 'error' ? result.result.error : null;
    return [
      {
        seq,
        toolName,
        section,
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
 *  recipe's changes (`AgentBlock.result.changes`, in the order it wrote
 *  them), or an agent's edits. */
const EnvelopeFilesSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
  changes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
        absolutePath: Schema.String,
        base: Schema.NullOr(Schema.String),
        added: Schema.NullOr(Schema.Number),
        removed: Schema.NullOr(Schema.Number),
      }),
    ),
  ),
});

/** A document's count over the calls that wrote it: the counted calls
 *  add up, and a call that reports none (an agent's edit) leaves the
 *  total unknown until a later call reports one, which starts it over. */
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
    const envelope = Schema.decodeUnknownResult(EnvelopeFilesSchema)(
      call.value,
    );
    if (!Result.isSuccess(envelope)) continue;
    const { changes } = envelope.success;
    if (changes === undefined) {
      for (const path of envelope.success.files) add(path, null, null);
      continue;
    }
    // A later entry for the same document is its later revision.
    const latest = new Map<string, (typeof changes)[number]>();
    for (const change of changes) {
      const path =
        (change.base === null ? undefined : delivered.get(change.base)) ??
        change.path;
      delivered.set(change.absolutePath, path);
      latest.set(path, change);
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
  runId: RunId,
  name: string,
  outcome: ScriptDeliverySummary['outcome'],
  errorCause: string | null,
  /** When this launch or resume of the run started: what the duration
   *  counts from, never an idle gap. */
  startedAt: number,
) {
  const { calls } = yield* scriptRunCalls(runId);
  const view = yield* (yield* SessionViewAccess).read([]);
  const now = yield* Clock.currentTimeMillis;
  const counts = { ok: 0, failed: 0, cancelled: 0, skipped: 0 };
  for (const call of calls) {
    switch (call.status) {
      case 'completed':
        counts.ok += 1;
        break;
      case 'unsettled':
        counts.cancelled += 1;
        break;
      case 'failed':
      case 'skipped':
        counts[call.status] += 1;
        break;
      default:
        call.status satisfies never;
    }
  }
  const tally: ScriptTally = { total: calls.length, ...counts };
  return {
    name,
    outcome,
    sectionCount: new Set(calls.flatMap(({ section }) => section ?? [])).size,
    tally,
    costUsd: view.runs.get(runId)?.treeUsage.cost ?? 0,
    durationMs: Math.max(0, Math.round(now - startedAt)),
    files: deliveredFiles(calls),
    errorCause,
  } satisfies ScriptDeliverySummary;
});

const resumeHint = (runId: RunId): string =>
  `Nothing continues it on its own. Resuming run ${runId} hands its finished calls back from its rows and runs the rest.`;

/** What every delivery of a script run opens with: its family, its run
 *  and the title its parent's `script` call gave it. */
const scriptDelivery = (runId: RunId, title: string) => ({
  family: DELIVERY_FAMILY.script,
  runId,
  attributes: [{ name: 'title', value: title }],
});

/**
 * What a background script's run delivers at its end: its calls' result
 * and summary when the script ran to its result, else its failure (the
 * script call's error, the run's own, or a run that ended with no result).
 */
export const scriptEndDelivery = Effect.fn('scriptRun.endDelivery')(function* (
  runId: RunId,
  title: string,
  outcome: RunOutcome,
  /** The run's own failure, when it ended failed. */
  failure: string | null,
  /** When this launch or resume of the run started. */
  startedAt: number,
): Effect.fn.Return<ChildRunDelivery, Error, SessionLog | SessionViewAccess> {
  const { script } = yield* scriptRunCalls(runId);
  if (outcome === RUN_OUTCOME.COMPLETED && script?.result.status === 'executed')
    return {
      ...scriptDelivery(runId, title),
      response: script.result.output ?? '',
      summary: yield* scriptRunSummary(
        runId,
        title,
        'completed',
        null,
        startedAt,
      ),
    };
  const cause =
    script?.result.status === 'error'
      ? script.result.error
      : (failure ?? 'The script ended without a result.');
  return {
    ...scriptDelivery(runId, title),
    summary: yield* scriptRunSummary(runId, title, 'failed', cause, startedAt),
    message: failure === null ? cause : `${cause}\n${resumeHint(runId)}`,
  };
});

/** The notice a background script stopped by a person leaves its parent:
 *  what it had done, and the run to resume. */
export const scriptStopNotice = Effect.fn('scriptRun.stopNotice')(function* (
  runId: RunId,
  title: string,
  startedAt: number,
): Effect.fn.Return<ChildRunDelivery, Error, SessionLog | SessionViewAccess> {
  const summary = yield* scriptRunSummary(
    runId,
    title,
    'stopped',
    null,
    startedAt,
  );
  return {
    ...scriptDelivery(runId, title),
    summary,
    message: `The script '${title}' was stopped after ${summary.tally.ok} of ${summary.tally.total} calls. ${resumeHint(runId)}`,
  };
});
