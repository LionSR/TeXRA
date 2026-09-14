import { describe, expect, it } from 'vitest';

import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  DisplaySessionEventSchema,
  emptyRunEndOutput,
  LOG_LEVELS,
  MESSAGE_TYPES,
  USER_FOLLOW_UP_SUPPORT,
  type RunId,
  type RunIdentity,
  type RunOutcome,
} from '@shared/schemas';
import { fold } from '@shared/session/sessionFold';
import { emptySessionView } from '@shared/session/sessionView';
import type { TraceDocument } from '@transcript';
// Relative import: `packages/trace-viewer` is a separate workspace package
// with no path alias into the root vitest config, but this suite exercises
// the real replay pipeline (`@progressView/frontend`'s dispatcher + slices),
// so a plain relative import is the simplest way to reach it.
import { traceFrame } from '../../../packages/trace-viewer/src/traceFrames';

const RUN_ID = 'abc123' as RunId;
const AGGREGATE = qualifyAggregateId('run', RUN_ID);

/** The view the fold reaches over the trace's rows, with the transcript tier
 *  subscribed for the run's stream. */
function foldTrace(trace: TraceDocument) {
  const frame = traceFrame(trace, 'trace', {
    kind: 'subscribe',
    session: 'trace',
    generation: 1,
    cursor: 0,
    aggregates: [{ id: AGGREGATE, fromSeq: 0 }],
  });
  const view = fold(emptySessionView('trace', 0), [
    { _tag: 'subscriptions', set: [{ id: AGGREGATE, fromSeq: 0 }] },
    ...frame.events,
    { _tag: 'local', local: { self: [], dead: [], unreadable: [] } },
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
      DisplaySessionEventSchema.parse({
        aggregateId: AGGREGATE,
        seq: index + 1,
        commit: index + 1,
        ownerId: null,
        at: 1_767_225_600_000 + index,
        ...body,
      }),
    ),
  };
}

function runStart(
  category: AgentCategory,
  identity: RunIdentity = { kind: 'agent', agent: 'assistant' },
): Record<string, unknown> {
  return {
    type: 'run.start',
    identity,
    userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
    category,
    isRemote: false,
    worktree: null,
    parent: null,
  };
}

function runEnd(outcome: RunOutcome): Record<string, unknown> {
  return {
    type: 'run.end',
    outcome,
    output: emptyRunEndOutput(AgentCategory.Workflow),
  };
}

describe('traceFrame replays the document through the one fold', () => {
  it('replays workflow content without tool-use state', () => {
    const trace = traceDocument(runStart(AgentCategory.Workflow), {
      type: 'log',
      level: LOG_LEVELS.INFO,
      messageType: MESSAGE_TYPES.DEFAULT,
      message: 'Archived derivation',
    });

    const replayed = foldTrace(trace);
    expect(replayed).toMatchObject({
      category: AgentCategory.Workflow,
      files: {},
      missingOutputs: {},
      compileFailures: {},
    });
    expect(replayed).not.toHaveProperty('todos');
    expect(replayed?.transcript.rows).toContainEqual(
      expect.objectContaining({
        kind: 'log',
        text: expect.objectContaining({ full: 'Archived derivation' }),
      }),
    );
  });

  it('replays tool-use content without workflow output state', () => {
    const trace = traceDocument(runStart(AgentCategory.ToolUse), {
      type: 'updateTodos',
      todos: [
        {
          content: 'Replay the plan',
          status: 'pending',
          activeForm: 'Replaying the plan',
        },
      ],
    });

    const replayed = foldTrace(trace);
    expect(replayed).toMatchObject({
      category: AgentCategory.ToolUse,
      todos: [{ content: 'Replay the plan' }],
      plan: null,
    });
    expect(replayed).not.toHaveProperty('files');
  });

  it.each([
    { outcome: 'failed', expected: 'failed' },
    { outcome: 'completed', expected: 'completed' },
  ] as const)(
    'folds the exported run.end "$outcome" to the terminal status "$expected"',
    ({ outcome, expected }) => {
      const replayed = foldTrace(
        traceDocument(runStart(AgentCategory.Workflow), runEnd(outcome)),
      );
      expect(replayed?.status).toBe(expected);
      expect(replayed?.durableOutcome).toBe(expected);
    },
  );

  it('reports no durable outcome when the document carries no run.end', () => {
    // No terminal fact: an exported trace with no producer folds as an
    // interrupted run, never as a finished one.
    expect(
      foldTrace(traceDocument(runStart(AgentCategory.Workflow)))
        ?.durableOutcome,
    ).toBeNull();
  });

  it("folds a process run's exported config into the command", () => {
    const trace = traceDocument(
      runStart(AgentCategory.ToolUse, { kind: 'process', tool: 'bash' }),
      {
        type: 'run.config',
        config: {
          agentCategory: AgentCategory.ToolUse,
          agent: 'bash',
          instruction: 'ls -la',
        },
      },
    );

    expect(foldTrace(trace)?.command).toBe('ls -la');
  });
});
