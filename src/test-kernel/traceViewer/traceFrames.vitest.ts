import { describe, expect, it } from 'vitest';

import { Schema } from 'effect';
import {
  qualifyAggregateId,
  DisplaySessionEventSchema,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunIdentity,
} from '@shared/schemas';
import { makeSessionViewUpdater } from '@shared/session/sessionViewUpdate';
import { traceFrame } from '../../../packages/trace-viewer/src/traceFrames';
import type { TraceDocument } from '@texra-ai/harness/schemas';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.

const RUN_ID = 'abc123' as RunId;
const AGGREGATE = qualifyAggregateId('run', RUN_ID);

/** The view the trace's rows build, with the run's transcript
 *  subscribed. */
function foldTrace(trace: TraceDocument) {
  const frame = traceFrame(trace, 'trace', {
    kind: 'subscribe',
    session: 'trace',
    generation: 1,
    debug: false,
    cursor: 0,
    aggregates: [{ id: AGGREGATE, fromSeq: 0 }],
  });
  const view = makeSessionViewUpdater('trace').apply([
    { _tag: 'subscriptions', set: [{ id: AGGREGATE, fromSeq: 0 }] },
    ...frame.events,
    {
      _tag: 'local',
      local: { self: [], dead: [], unreadable: [], resumeBlocked: [] },
    },
    { _tag: 'replay.complete', existence: frame.existence! },
  ]);
  return view.runs.get(trace.runId);
}

/** The document as `assembleTrace` writes it: the run aggregate's display
 *  rows, seq and commit dense from 1, no owner. */
function traceDocument(
  ...bodies: readonly Record<string, unknown>[]
): TraceDocument {
  return {
    runId: RUN_ID,
    events: bodies.map((body, index) =>
      Schema.decodeUnknownSync(DisplaySessionEventSchema)({
        aggregateId: AGGREGATE,
        seq: index + 1,
        commit: index + 1,
        origin: null,
        at: 1_767_225_600_000 + index,
        ...body,
      }),
    ),
  };
}

function runStart(
  identity: RunIdentity = { kind: 'agent', agent: 'assistant' },
): Record<string, unknown> {
  return {
    type: 'run.start',
    identity,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    worktree: null,
    parent: null,
    provenance: null,
  };
}

describe('traceFrame replays the document through the one fold', () => {
  it('reports no durable outcome when the document carries no run.end', () => {
    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(foldTrace(traceDocument(runStart()))?.durableOutcome).toBeNull();
  });
});
