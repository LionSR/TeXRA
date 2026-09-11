/** Assemble a static trace from the run's record, transcript entries and the root's folded run view. */
import { Effect } from 'effect';
import { readPersistedRunRecord } from '@agent/storage/runLifecycle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { redactDisplayValue } from '@logger/redaction';

import { AgentCategory, type RunId } from '@shared/schemas';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';

import type { TraceDocument } from './traceDocumentSchema';

export type AssembleTraceResult =
  | { readonly status: 'ok'; readonly trace: TraceDocument }
  | { readonly status: 'config_missing' | 'streamLogs_missing' };

/**
 * `streamLogs_missing` means no replayable run timeline is available: the
 * run is not in the session's fold or has no authoritative transcript.
 */
export const assembleTrace = Effect.fn('assembleTrace')(function* (
  runId: RunId,
  session: SessionHandle,
): Effect.fn.Return<AssembleTraceResult, Error> {
  const [view, config] = yield* Effect.all(
    [session.readView([runId]), readPersistedRunRecord(runId, session)],
    { concurrency: 2 },
  );
  if (!config) return { status: 'config_missing' };
  const run = view.runs.get(runId);
  if (!run) return { status: 'streamLogs_missing' };
  if (!(yield* session.transcripts.hasAuthoritativeRun(runId)))
    return { status: 'streamLogs_missing' };
  const entries = yield* session.transcripts.readEntries(runId);
  const shared = {
    identity: run.identity,
    launchedAt: run.launchedAt,
    description: run.description,
    outcome: isTerminalOutcomePhase(run.status) ? run.status : null,
    conversationProgress: run.conversationProgress,
    usage: run.usage,
    missingOutputs: run.missingOutputs,
    compileFailures: run.compileFailures,
  };
  const meta: TraceDocument['meta'] =
    run.category === AgentCategory.Workflow
      ? { ...shared, todos: [], plan: null, outputs: run.files }
      : { ...shared, todos: run.todos, plan: run.plan, outputs: run.outputs };
  return {
    status: 'ok',
    trace: redactDisplayValue({ runId, config, meta, entries }),
  };
});
