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
  RUN_OUTCOME,
  type ChildRunDelivery,
  type RunId,
  type RunOutcome,
  type RunStopReason,
  type ToolResultPayload,
  type ScriptDeliverySummary,
} from '@shared/schemas';
import { tallyTotal } from '@shared/transcript/scriptCall';

/** What became of one call a script issued, as its rows say. */
type ScriptCallOutcome =
  | 'completed'
  | 'failed'
  | 'skipped'
  /** No result yet: running while the run is, cut short after. */
  | 'unfinished';

export interface ScriptCallCard {
  readonly seq: number;
  readonly toolName: string;
  readonly section: string | null;
  /** What `result` says became of the call. */
  readonly status: ScriptCallOutcome;
  /** The call's latest result; none while it has not finished. Its value
   *  is what the guest's `await` got in place of `{ output, summary }`. */
  readonly result: ToolResultPayload | undefined;
}

const statusOf = (result: ToolResultPayload | undefined): ScriptCallOutcome => {
  if (result === undefined) return 'unfinished';
  if (result.result.status === 'executed') return 'completed';
  if (result.disposition === 'skipped' || result.result.name === 'Skipped')
    return 'skipped';
  return 'failed';
};

/**
 * The run's script call's result and the calls its script issued, in
 * issue order, from the run's script calls and its calls' results (the
 * `script` read). The script's own host functions (`searchTools()`,
 * `describeTool()`) answer from the catalog and open no card, so they are
 * not among the calls.
 */
export const scriptRunCalls = Effect.fn('scriptRun.calls')(function* (
  runId: RunId,
) {
  const { scriptCalls, results } = yield* (yield* SessionLog).runRows(
    runId,
    'script',
  );
  const latest = new Map<string, ToolResultPayload>();
  for (const payload of results) {
    const known = latest.get(payload.callId);
    if (known === undefined || known.attempt <= payload.attempt)
      latest.set(payload.callId, payload);
  }
  const script =
    [...latest.values()].find(({ callId }) => !callId.includes('/')) ?? null;
  const calls = scriptCalls.flatMap((call): ScriptCallCard[] => {
    if (call.toolName.endsWith('()')) return [];
    const { seq, toolName, section, callId } = call;
    const result = latest.get(callId);
    return [{ seq, toolName, section, status: statusOf(result), result }];
  });
  return { script, calls };
});

/** The files a call's child wrote, when its value is a run's envelope. */
const EnvelopeFilesSchema = Schema.Struct({
  files: Schema.Array(Schema.String),
});

/** The files the calls' children wrote, each once, in the order first
 *  written. */
function deliveredFiles(
  calls: readonly ScriptCallCard[],
): ScriptDeliverySummary['files'] {
  const paths = new Set<string>();
  for (const call of calls) {
    const result = call.result?.result;
    if (result?.status !== 'executed') continue;
    const envelope = Schema.decodeUnknownResult(EnvelopeFilesSchema)(
      result.value,
    );
    if (Result.isSuccess(envelope))
      for (const path of envelope.success.files) paths.add(path);
  }
  return [...paths];
}

/**
 * The summary line of a script run, applied from its rows: the tally of its
 * calls, what the runs under it spent, how long it has run, the files its
 * agent calls wrote, and the cause when it failed.
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
      case 'unfinished':
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
  return {
    name,
    outcome,
    sectionCount: new Set(calls.flatMap(({ section }) => section ?? [])).size,
    tally: counts,
    costUsd: view.runs.get(runId)?.treeUsage.cost ?? 0,
    durationMs: Math.max(0, Math.round(now - startedAt)),
    files: deliveredFiles(calls),
    errorCause,
  } satisfies ScriptDeliverySummary;
});

const resumeHint = (runId: RunId): string =>
  `Nothing continues it on its own. Resuming run ${runId} hands its finished calls back from its rows and runs the rest.`;

/**
 * What a background script's run delivers at its end: its calls' result
 * and summary when the script ran to its result; its failure otherwise
 * (the script call's error, the run's own, or a run that ended with no
 * result); and, stopped, the notice a person's stop leaves (what it had
 * done, and the run to resume), or nothing when the call awaiting it
 * released it.
 */
export const scriptEndDelivery = Effect.fn('scriptRun.endDelivery')(function* (
  runId: RunId,
  title: string,
  outcome: RunOutcome,
  /** The run's own failure, when it ended failed. */
  failure: string | null,
  /** Why a stopped run stopped. */
  stopReason: RunStopReason | undefined,
  /** When this launch or resume of the run started. */
  startedAt: number,
): Effect.fn.Return<
  ChildRunDelivery | null,
  Error,
  SessionLog | SessionViewAccess
> {
  const delivery = {
    family: DELIVERY_FAMILY.script,
    runId,
    attributes: [{ name: 'title', value: title }],
  };
  if (outcome === RUN_OUTCOME.CANCELLED) {
    if (stopReason !== 'user') return null;
    const summary = yield* scriptRunSummary(
      runId,
      title,
      'stopped',
      null,
      startedAt,
    );
    return {
      ...delivery,
      summary,
      message: `The script '${title}' was stopped after ${summary.tally.ok} of ${tallyTotal(summary.tally)} calls. ${resumeHint(runId)}`,
    };
  }
  const { script } = yield* scriptRunCalls(runId);
  if (outcome === RUN_OUTCOME.COMPLETED && script?.result.status === 'executed')
    return {
      ...delivery,
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
    ...delivery,
    summary: yield* scriptRunSummary(runId, title, 'failed', cause, startedAt),
    message: failure === null ? cause : `${cause}\n${resumeHint(runId)}`,
  };
});
