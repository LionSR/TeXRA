import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { it } from '@effect/vitest';
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem';
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import type { FollowUpQueueInput } from '@agent/followUp/ToolUseFollowUpQueueManager';
import { type InvokeRequest } from '@agent/runtime/ModelInvoker';
import {
  appendRow,
  rowAggregate,
  snapshotRow,
  positionRow,
} from '@agent/runtime/loop/rows';
import { runToolUse } from '@agent/runtime/loop/toolUse';
import type { RunControls } from '@agent/runtime/RunHandle';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { TraceEmitter } from '@agent/trace';
import {
  emptyRunEndOutput,
  MESSAGE_TYPES,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import {
  DatabaseWriteFailed,
  type SessionOpenError,
} from '@shared/session/database';
import { RunLedger } from '@shared/session/runLedger';
import { freshRunState, type RunState } from '@shared/session/runStateFold';
import { formatSubagentProgress } from '@shared/subagentFollowup';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  agentRunTestLayer,
  scriptedInvokerLayer,
  startedRun,
  TEST_ORIGIN,
  textTurn,
  type ScriptedRunInit,
  type ScriptedTurn,
} from '@test/support/scriptedRunLayers';
import {
  createProcessSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { releaseRunResources } from '@tools/approval';
import {
  clearGoal,
  goalOf,
  setGoalSessionAutoApproval,
  startGoal,
} from '@tools/goal';
import { generateRunId } from '@utils/core';

import {
  eventsOfType,
  recordSessionEvents,
  seedTerminalRun,
  sessionWithInteractions,
} from '../progressTestUtils';

// ---------------------------------------------------------------------------
// The loop harness: the run's own services over a real session ledger and the
// session's real follow-up queue, with the model faked at the `ModelInvoker`
// seam. The wait, the drain and the consumption are the production ones, so
// what a parked run does with input is exercised end to end.
// ---------------------------------------------------------------------------

interface LoopInit extends ScriptedRunInit {
  readonly script: readonly ScriptedTurn[];
  readonly resume?: boolean;
  /** The ledger the run writes through; the session's own by default. */
  readonly ledger?: RunLedger['Service'];
  /** Host wiring that is live while the loop can accept an interrupt. */
  readonly attachment?: {
    attach(controls: RunControls): void;
    detach(controls: RunControls): void;
  };
}

function loopProgram(
  init: LoopInit,
  requests: InvokeRequest[],
  processFs?: FileSystem.FileSystem,
) {
  return runToolUse({
    resume: init.resume === true,
    ...(init.attachment ? { attachment: init.attachment } : {}),
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        scriptedInvokerLayer(init.script, requests),
        nativeToolTestLayer({
          run: { runId: init.runId, session: init.session, toolPolicy: {} },
        }),
        ...(processFs ? [Layer.succeed(FileSystem.FileSystem, processFs)] : []),
      ).pipe(
        Layer.provideMerge(agentRunTestLayer(init)),
        Layer.provideMerge(
          Layer.succeed(RunLedger)(init.ledger ?? init.session.ledger),
        ),
      ),
    ),
  );
}

/** Run one scripted run to its own exit. */
const runLoop = Effect.fn('test.runLoop')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const result = yield* loopProgram(init, requests);
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  return { result, requests, state };
});

/**
 * Drive the loop until its scripted turns are spent: the scenario's script is
 * the run's whole life, and the loop stops where the script ends rather than
 * being torn down mid-turn.
 */
const runUntilSpent = Effect.fn('test.runUntilSpent')(function* (
  init: LoopInit,
) {
  const requests: InvokeRequest[] = [];
  const exit = yield* Effect.exit(loopProgram(init, requests));
  const state = yield* init.session.ledger.load(init.runId).pipe(Effect.orDie);
  return { exit, requests, state };
});

/**
 * Start a run that parks, for scenarios that drive it while it waits. The
 * loop calls `onIdle` on its own fiber immediately before it blocks for
 * input, after the batch carrying the `waiting` step has committed, so one
 * Deferred per park is the loop's own 'parked for the Nth time' signal:
 * `park(n)` is what those scenarios wait on. The wait resumes
 * inside that callback, before the loop enters `followUps.wait`, so input a
 * scenario enqueues after `park` lands on the queue rather than on a waiting
 * consumer; the wait takes what is queued first, so both orders deliver the
 * same batch.
 */
const forkLoop = Effect.fn('test.forkLoop')(function* (init: LoopInit) {
  const requests: InvokeRequest[] = [];
  const parks = yield* Effect.forEach(init.script, () => Deferred.make<void>());
  let parked = 0;
  const fiber = yield* Effect.forkChild(
    loopProgram(
      {
        ...init,
        onIdle: () => {
          init.onIdle?.();
          const park = parks[parked];
          parked += 1;
          if (park) Deferred.doneUnsafe(park, Effect.void);
        },
      },
      requests,
    ),
  );
  /** Wait for the loop's `n`-th park; the n-th invocation precedes it. */
  const park = (n: number) => {
    const deferred = parks[n];
    if (!deferred) throw new Error(`The script has no park ${n}.`);
    return Deferred.await(deferred);
  };
  return { fiber, requests, park };
});

/**
 * A session over the process roots: a goal is its run's own row, so a goal
 * scenario and the loop must share the session that carries it.
 */
function goalSession(
  overrides: Record<string, unknown> = {},
): Effect.Effect<SessionHandle, SessionOpenError> {
  return Effect.map(createProcessSession(), (session) => {
    Effect.runSync(session.interactions.use({ emit: () => {}, ...overrides }));
    return session;
  });
}

const quietSession = (overrides: Record<string, unknown> = {}) =>
  sessionWithInteractions({ emit: () => {}, ...overrides });

/**
 * A run whose rows stop where a crash between a committed text response and
 * its post-response policy would leave them: the response and its step are
 * in the ledger, nothing after them is.
 */
const seedCommittedResponse = Effect.fn('test.seedCommittedResponse')(
  function* (session: SessionHandle, runId: RunId, text: string) {
    const ledger = session.ledger;
    const aggregate = rowAggregate(runId);
    const fresh: RunState = {
      ...freshRunState(0),
      family: 'toolUse',
      modelId: 'test-model',
      modelCompatibilityKey: 'DeepSeek',
    };
    const opened = yield* ledger.appendBatch(runId, null, [
      appendRow(runId, [
        { role: 'user', content: [{ kind: 'text', text: 'Do the thing.' }] },
      ]),
      ...snapshotRow(runId, fresh, {
        state: {
          stateSlices: null,
        },
      }),
      positionRow(runId, { ...fresh, turn: 1 }, 'turn.begin'),
    ]);
    const invocation = { invocationId: randomUUID(), attempt: 1 };
    return yield* ledger.appendBatch(runId, opened, [
      {
        type: 'model.message',
        aggregateId: aggregate,
        payload: {
          kind: 'attempt',
          request: '0'.repeat(64),
          invocation,
          origin: TEST_ORIGIN,
          delivery: 'stream',
        },
      },
      {
        type: 'model.message',
        aggregateId: aggregate,
        payload: {
          kind: 'response',
          responseId: randomUUID(),
          invocation,
          turn: textTurn(text),
          calls: [],
          usage: null,
        },
      },
      positionRow(runId, opened, 'response.ready'),
    ]);
  },
);

/** Put input on the run's queue before the loop claims it. */
const enqueue = Effect.fn('test.enqueue')(function* (
  session: SessionHandle,
  runId: RunId,
  items: readonly FollowUpQueueInput[],
) {
  yield* session.settlePublications();
  for (const item of items) {
    yield* session.followUps.submit(runId, item, 'recoverable');
  }
});

/** The plain text of every user message the run recorded. */
function userTexts(state: RunState | null): string[] {
  return (state?.messages ?? []).flatMap((message) =>
    message.role === 'user'
      ? message.content.flatMap((part) =>
          part.kind === 'text' ? [part.text] : [],
        )
      : [],
  );
}

describe('a parked child run', () => {
  it.effect.each([false, true])(
    'keeps the child live across its input wait (input queued: %s)',
    (queued) =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        if (queued) {
          yield* enqueue(session, runId, [
            { text: 'later', from: { kind: 'user' as const } },
          ]);
        }

        const { fiber, park, requests } = yield* forkLoop({
          runId,
          session,
          parentRunId: generateRunId(),
          script: [textTurn('first cycle'), textTurn('second cycle')],
        });
        yield* park(queued ? 1 : 0);
        expect(fiber.pollUnsafe()).toBeUndefined();
        expect(requests).toHaveLength(queued ? 2 : 1);
        yield* Fiber.interrupt(fiber);
      }),
  );

  it.effect(
    'delivers a follow-up its rows still queue exactly once, with the message it becomes (C3)',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        const parentRunId = generateRunId();
        const asked = 'state where finiteness is used';

        const first = yield* forkLoop({
          runId,
          session,
          parentRunId,
          script: [textTurn('first cycle')],
        });
        yield* first.park(0);
        yield* Fiber.interrupt(first.fiber);
        // A crash between admission and the consuming batch leaves the row
        // and nothing else: no process holds the follow-up in memory.
        const queued = {
          type: 'followup.queued' as const,
          aggregateId: rowAggregate(runId),
          followUpId: 'follow-up-1',
          content: { text: asked, from: { kind: 'user' as const } },
        };
        session.publish([queued]);
        yield* session.settlePublications();

        const resumed = yield* forkLoop({
          runId,
          session,
          parentRunId,
          resume: true,
          script: [textTurn('second cycle'), textTurn('never reached')],
        });
        yield* resumed.park(1);
        const resumedState = yield* session.ledger.load(runId);
        expect(userTexts(resumedState)).toContain(asked);
        expect(session.events.pendingFollowUps(rowAggregate(runId))).toEqual(
          [],
        );
        yield* Fiber.interrupt(resumed.fiber);

        // A producer that replays the delivery after a restart writes the
        // same id again; it names a follow-up already consumed.
        session.publish([queued]);
        yield* session.settlePublications();
        const again = yield* forkLoop({
          runId,
          session,
          parentRunId,
          resume: true,
          script: [textTurn('never reached')],
        });
        yield* again.park(0);
        expect(again.requests).toHaveLength(0);
        expect(
          userTexts(yield* session.ledger.load(runId)).filter(
            (text) => text === asked,
          ),
        ).toEqual([asked]);
        yield* Fiber.interrupt(again.fiber);
      }),
  );

  it.effect('stops after an error when no batch was drained', () =>
    Effect.gen(function* () {
      // A subagent that waited here would wait for a follow-up its
      // orchestrator was never told to send.
      const session = yield* quietSession();
      const { result } = yield* runLoop({
        runId: startedRun(session),
        session,
        parentRunId: generateRunId(),
        script: [{ failWith: { message: 'boom', userRetryable: false } }],
      });

      expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
    }),
  );
});

describe('a parked root run', () => {
  it.effect(
    'reports idle at the turn boundary, before it waits for input',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        const onIdle = vi.fn();
        yield* enqueue(session, runId, [
          { text: 'keep going', from: { kind: 'user' as const } },
        ]);

        const { fiber, park } = yield* forkLoop({
          runId,
          session,
          onIdle,
          script: [textTurn('first'), textTurn('second')],
        });
        yield* park(1);
        yield* Fiber.interrupt(fiber);

        // Idle is a notification, not a suspension: the queued input still
        // reached the model in the same invocation.
        expect(onIdle).toHaveBeenCalled();
      }),
  );

  it.effect(
    'stops instead of waiting when the launch asked for one cycle',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const { result, requests } = yield* runLoop({
          runId: startedRun(session),
          session,
          stopAfterCycle: true,
          script: [textTurn('done')],
        });

        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
        expect(requests).toHaveLength(1);
      }),
  );

  it.effect('releases its follow-up owner when the halt write fails', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const writeFailed = new DatabaseWriteFailed({
        path: ':memory:',
        cause: new Error('disk full'),
      });
      const { exit } = yield* runUntilSpent({
        runId,
        session,
        stopAfterCycle: true,
        script: [textTurn('done')],
        ledger: {
          ...session.ledger,
          appendBatch: (id, state, drafts) =>
            drafts.some(
              (draft) =>
                draft.type === 'run.position' && draft.payload.at === 'halted',
            )
              ? Effect.fail(writeFailed)
              : session.ledger.appendBatch(id, state, drafts),
        },
      });

      // The failure stays loud, and the next owner can still claim the run.
      expect(Exit.isFailure(exit)).toBe(true);
      expect(session.followUps.hasLiveOwner(runId)).toBe(false);
    }),
  );

  it.effect('stops a one-cycle child instead of parking it as waiting', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const { result, requests } = yield* runLoop({
        runId: startedRun(session),
        session,
        parentRunId: generateRunId(),
        stopAfterCycle: true,
        script: [textTurn('done')],
      });

      expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      expect(requests).toHaveLength(1);
    }),
  );

  it.effect(
    'replays a recovered text response through the final-turn policy',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        yield* seedCommittedResponse(session, runId, 'the prose answer');

        const { result, requests, state } = yield* runLoop({
          runId,
          session,
          resume: true,
          // One cycle, so the scenario ends at the turn it is about.
          stopAfterCycle: true,
          finalToolName: 'submit_output',
          script: [textTurn('and the structured one')],
        });

        // The crash landed between the response row and the live policy that
        // reads it. Treating the row as an already-finished turn would end
        // the run with no structured output attempted at all.
        expect(requests).toHaveLength(1);
        expect(requests[0]?.toolChoice).toEqual({ name: 'submit_output' });
        expect(userTexts(state)).toContain(
          'Submit the final structured output now.',
        );
        expect(result.outcome).toBe(RUN_OUTCOME.COMPLETED);
      }),
  );

  it.effect('waits while parked and runs again once input arrives', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const recorded = recordSessionEvents(session);

      const { fiber, park } = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first'), textTurn('second')],
      });
      yield* park(0);
      yield* enqueue(session, runId, [
        { text: 'carry on', from: { kind: 'user' as const } },
      ]);
      yield* park(1);
      yield* Fiber.interrupt(fiber);

      // The phase is the loop's own step on the session's plane, the single
      // rail: the park, then the step that leaves it.
      const steps = eventsOfType(
        yield* Effect.promise(() => recorded.read()),
        'run.position',
      ).map((event) => event.payload.at);
      const parked = steps.indexOf('waiting');
      expect(parked).toBeGreaterThanOrEqual(0);
      expect(steps.slice(parked + 1).some((step) => step !== 'waiting')).toBe(
        true,
      );
    }),
  );

  it.effect('restores its park when a resume consumes only stale notices', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const first = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first')],
      });
      yield* first.park(0);
      yield* Fiber.interrupt(first.fiber);

      // Only an ended child's progress notice is queued: consuming it starts
      // no turn, so the resume must still write the park it cleared.
      const child = publishTestRunStart(session, generateRunId(), {
        parent: runId,
      });
      session.publish([
        {
          type: 'run.end',
          aggregateId: rowAggregate(child),
          outcome: RUN_OUTCOME.CANCELLED,
          output: emptyRunEndOutput('toolUse'),
        },
      ]);
      yield* enqueue(session, runId, [
        {
          text: formatSubagentProgress(child, 'coder', { kind: 'started' }),
          from: { kind: 'run' as const, runId: child },
        },
      ]);
      const recorded = recordSessionEvents(session);

      const resumed = yield* forkLoop({
        runId,
        session,
        resume: true,
        script: [textTurn('never reached'), textTurn('never reached')],
      });
      yield* resumed.park(1);
      yield* Fiber.interrupt(resumed.fiber);

      const steps = eventsOfType(
        yield* Effect.promise(() => recorded.read()),
        'run.position',
      ).map((event) => event.payload.at);
      // The interrupt that ends the test writes its own halt last.
      expect(steps.slice(0, -1)).toContain('waiting');
      expect(resumed.requests).toHaveLength(0);
    }),
  );

  it.effect('answers a follow-up consumed just before the loop exited', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const first = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first')],
      });
      yield* first.park(0);
      yield* Fiber.interrupt(first.fiber);

      // The rows `FollowUps.consume` commits, and then nothing: the process
      // ended before the turn that answers them began.
      const parked = yield* session.ledger.load(runId).pipe(Effect.orDie);
      if (parked === null) throw new Error('The run has no ledger.');
      yield* session.ledger.appendBatch(runId, parked, [
        appendRow(runId, [
          { role: 'user', content: [{ kind: 'text', text: 'answer me' }] },
        ]),
        ...snapshotRow(runId, parked, { runtime: { lastError: null } }),
        positionRow(runId, parked, 'turn.ready'),
      ]);

      const resumed = yield* forkLoop({
        runId,
        session,
        resume: true,
        script: [textTurn('answered')],
      });
      yield* resumed.park(0);
      yield* Fiber.interrupt(resumed.fiber);

      expect(resumed.requests).toHaveLength(1);
    }),
  );

  it.effect('parks a run a retry cancelled, rather than leaving it there', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      yield* Effect.promise(() =>
        seedTerminalRun(session, runId, RUN_OUTCOME.CANCELLED),
      );
      const recorded = recordSessionEvents(session);

      const { fiber, park } = yield* forkLoop({
        runId,
        session,
        script: [textTurn('first')],
      });
      yield* park(0);
      yield* Fiber.interrupt(fiber);

      // The loop's steps carry the run out of its cancelled terminal: it runs
      // before it parks.
      const steps = eventsOfType(
        yield* Effect.promise(() => recorded.read()),
        'run.position',
      ).map((event) => event.payload.at);
      const parked = steps.indexOf('waiting');
      expect(parked).toBeGreaterThan(0);
      expect(steps.slice(0, parked).every((step) => step !== 'waiting')).toBe(
        true,
      );
    }),
  );
});

describe('the batch a parked run consumes', () => {
  it.effect(
    'enters the conversation as one user turn carrying every queued item',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        const reporter = publishTestRunStart(session, undefined, {
          parent: runId,
        });
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        // A progress notice whose child has since ended is consumed, never
        // delivered: the model and the transcript see only live items.
        const child = publishTestRunStart(session, generateRunId(), {
          parent: runId,
        });
        session.publish([
          {
            type: 'run.end',
            aggregateId: rowAggregate(child),
            outcome: RUN_OUTCOME.CANCELLED,
            output: emptyRunEndOutput('toolUse'),
          },
        ]);
        yield* enqueue(session, runId, [
          {
            text: formatSubagentProgress(child, 'coder', { kind: 'started' }),
            from: { kind: 'run' as const, runId: child },
          },
          {
            text: '<subagent-result>done</subagent-result>',
            from: { kind: 'run' as const, runId: reporter },
          },
          {
            text: 'please revise the theorem',
            from: { kind: 'user' as const },
          },
        ]);

        const { fiber, park } = yield* forkLoop({
          runId,
          session,
          logger,
          script: [textTurn('first'), textTurn('second')],
        });
        yield* park(1);
        yield* Fiber.interrupt(fiber);
        const state = yield* session.ledger.load(runId).pipe(Effect.orDie);

        // One batch is one user message whose parts are the items in order;
        // the transcript still shows each of them as its own row.
        const batchMessage = state?.messages.filter(
          (message) => message.role === 'user',
        );
        expect(
          batchMessage
            ?.at(-1)
            ?.content.flatMap((part) =>
              part.kind === 'text' ? [part.text] : [],
            ),
        ).toEqual([
          '<subagent-result>done</subagent-result>',
          'please revise the theorem',
        ]);
        expect(info).toHaveBeenCalledWith('✓ subagent completed', {
          messageType: MESSAGE_TYPES.USER_MESSAGE,
        });
        expect(info).toHaveBeenCalledWith('please revise the theorem', {
          messageType: MESSAGE_TYPES.USER_MESSAGE,
        });
        expect(info).not.toHaveBeenCalledWith(
          '⟳ coder · started',
          expect.anything(),
        );
        expect(yield* queuedFollowUps(session, runId)).toEqual([]);
      }),
  );

  it.effect('logs a workflow delivery with its typed summary', () =>
    Effect.gen(function* () {
      // The delivery envelope carries the summary typed at the write site;
      // the transcript row producer parses it once and attaches it
      // structured, so renderers never re-extract it from the row text.
      const summary = {
        name: 'proofread-pipeline',
        outcome: 'completed',
        phaseCount: 1,
        tally: {
          total: 2,
          ok: 2,
          running: 0,
          queued: 0,
          planned: 0,
          failed: 0,
          cancelled: 0,
          skipped: 0,
          notRun: 0,
        },
        costUsd: 0.19,
        durationMs: 5_000,
        files: [{ path: 'paper.tex', added: 12, removed: 8 }],
        scriptPath: '.texra/workflow-scripts/proofread-pipeline.mjs',
        errorCause: null,
      };
      const escaped = JSON.stringify(summary).replaceAll('"', '&quot;');
      const session = yield* quietSession();
      const runId = startedRun(session);
      const child = publishTestRunStart(session, undefined, { parent: runId });
      const logger = new TraceEmitter();
      const info = vi.spyOn(logger, 'info');
      yield* enqueue(session, runId, [
        {
          text: [
            '<workflow-script-result id="abc">',
            '<response>raw run log</response>',
            `<workflow-summary>${escaped}</workflow-summary>`,
            '</workflow-script-result>',
          ].join('\n'),
          from: { kind: 'run' as const, runId: child },
        },
      ]);

      const { fiber, park } = yield* forkLoop({
        runId,
        session,
        logger,
        script: [textTurn('first'), textTurn('second')],
      });
      yield* park(1);
      yield* Fiber.interrupt(fiber);

      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('✓ proofread-pipeline completed'),
        expect.objectContaining({ data: { workflowSummary: summary } }),
      );
    }),
  );

  it.effect(
    'warns and drops media the model cannot read, attaching nothing',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        const warn = vi.spyOn(logger, 'warn');
        yield* enqueue(session, runId, [
          {
            text: 'please inspect this figure',
            mediaFiles: ['/tmp/texra-figure.png'],
            from: { kind: 'user' as const },
          },
        ]);

        const { fiber, park } = yield* forkLoop({
          runId,
          session,
          logger,
          bound: { supportsVision: false },
          script: [textTurn('first'), textTurn('second')],
        });
        yield* park(1);
        yield* Fiber.interrupt(fiber);

        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining('has no vision support'),
        );
        expect(info).toHaveBeenCalledWith(
          'please inspect this figure',
          expect.not.objectContaining({
            data: expect.objectContaining({ attachments: expect.anything() }),
          }),
        );
      }),
  );

  it.effect(
    'records what was asked and keeps the batch unconsumed when it cannot be applied',
    () =>
      Effect.gen(function* () {
        // A failed follow-up append (corrupt or oversized media, a provider
        // validation error) must still leave a record of what the user asked
        // for, and must not acknowledge input that never reached the model.
        const session = yield* quietSession();
        const runId = startedRun(session);
        const logger = new TraceEmitter();
        const info = vi.spyOn(logger, 'info');
        yield* enqueue(session, runId, [
          {
            text: 'use this diagram',
            mediaFiles: ['/tmp/texra-unreadable-figure.png'],
            from: { kind: 'user' as const },
          },
        ]);

        const exit = yield* Effect.exit(
          runLoop({
            runId,
            session,
            logger,
            bound: { supportsVision: true },
            script: [textTurn('first')],
          }),
        );

        expect(exit._tag).toBe('Failure');
        expect(info).toHaveBeenCalledWith(
          'use this diagram',
          expect.objectContaining({ messageType: expect.any(String) }),
        );
        expect(
          session.events
            .pendingFollowUps(rowAggregate(runId))
            .map((f) => f.content.text),
        ).toEqual(['use this diagram']);
      }),
  );
});

describe('an active goal at the wait', () => {
  it.effect('continues the run with a synthetic turn instead of blocking', () =>
    Effect.gen(function* () {
      const session = yield* goalSession();
      const runId = startedRun(session);
      const logger = new TraceEmitter();
      const info = vi.spyOn(logger, 'info');
      yield* startGoal(session, runId, 'Finish the autonomous proof audit.');

      try {
        const { requests, state } = yield* runUntilSpent({
          runId,
          session,
          logger,
          script: [textTurn('first'), textTurn('second')],
        });

        expect(
          userTexts(state).some((text) =>
            text.includes('Finish the autonomous proof audit.'),
          ),
        ).toBe(true);
        // The run ran again instead of blocking for input, and a synthetic
        // turn is not the user's: it is not logged as input.
        expect(requests.length).toBeGreaterThan(1);
        expect(info).not.toHaveBeenCalledWith(
          expect.stringContaining('<goal_context>'),
          expect.anything(),
        );
      } finally {
        yield* clearGoal(session, runId);
      }
    }),
  );

  it.effect('lets queued user input win over the continuation', () =>
    Effect.gen(function* () {
      const session = yield* goalSession();
      const runId = startedRun(session);
      yield* startGoal(session, runId, 'Keep going autonomously.');
      yield* enqueue(session, runId, [
        { text: 'user correction', from: { kind: 'user' as const } },
      ]);

      try {
        const { state } = yield* runUntilSpent({
          runId,
          session,
          script: [textTurn('first'), textTurn('second')],
        });

        // The first thing the parked run consumed is the user's, not the
        // goal's; the continuation only speaks for a queue with nothing in it.
        expect(userTexts(state).at(1)).toBe('user correction');
      } finally {
        yield* clearGoal(session, runId);
      }
    }),
  );

  it.effect(
    'is paused, with its approval bypasses cleared, after a failure',
    () =>
      Effect.gen(function* () {
        const session = yield* goalSession();
        const runId = startedRun(session);
        yield* startGoal(session, runId, 'finish the refactor');
        // The grant an approved plan makes; pausing ends it.
        setGoalSessionAutoApproval(session, runId, 'commands');
        const recorded = recordSessionEvents(session);

        try {
          const { result } = yield* runLoop({
            runId,
            session,
            stopAfterCycle: true,
            script: [
              { failWith: { message: 'cycle failed', userRetryable: false } },
            ],
          });

          expect(result.outcome).toBe(RUN_OUTCOME.FAILED);
          expect(goalOf(session, runId)?.status).toBe('paused');
          // The cleared bypasses travel as the run's policy snapshot, the
          // one channel this state has.
          const policies = eventsOfType(
            yield* Effect.promise(() => recorded.read()),
            'approval.policy',
          );
          expect(policies.at(-1)?.snapshot.bypasses).toEqual({
            bash: false,
            toolEdit: false,
            superYolo: false,
          });
        } finally {
          yield* clearGoal(session, runId);
          releaseRunResources(runId, session);
        }
      }),
  );

  it.effect(
    'is recovered, not paused, by a batch queued for its resumed turn',
    () =>
      Effect.gen(function* () {
        // Regression #9443: input queued for the child's resumed turn reaches
        // the model, so the error clears without pausing the goal or dropping
        // its unattended approvals first.
        const session = yield* goalSession();
        const runId = startedRun(session);
        const parentRunId = generateRunId();
        yield* startGoal(session, runId, 'finish the autonomous proof');

        try {
          yield* runLoop({
            runId,
            session,
            parentRunId,
            script: [
              {
                failWith: {
                  message: 'stale failure from the previous cycle',
                  userRetryable: false,
                },
              },
            ],
          });
          const recorded = recordSessionEvents(session);
          yield* enqueue(session, runId, [
            { text: 'try the other lemma', from: { kind: 'user' as const } },
          ]);

          const recovered = yield* forkLoop({
            runId,
            session,
            parentRunId,
            resume: true,
            script: [textTurn('recovered'), textTurn('never reached')],
          });
          yield* recovered.park(1);
          expect(userTexts(yield* session.ledger.load(runId))).toContain(
            'try the other lemma',
          );
          yield* Fiber.interrupt(recovered.fiber);
          expect(goalOf(session, runId)?.status).toBe('active');
          expect(
            eventsOfType(
              yield* Effect.promise(() => recorded.read()),
              'approval.policy',
            ),
          ).toEqual([]);
        } finally {
          yield* clearGoal(session, runId);
          releaseRunResources(runId, session);
        }
      }),
  );
});

describe('the host wiring a run attaches', () => {
  it.live(
    'interrupts opening preparation and releases the follow-up lease',
    () =>
      Effect.gen(function* () {
        const session = yield* quietSession();
        const runId = startedRun(session);
        const processFs = yield* FileSystem.FileSystem;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupted = yield* Deferred.make<void>();
        const detach = vi.fn();
        const blockedFs = {
          ...processFs,
          exists: (target: string) =>
            path.basename(target) === 'AGENTS.md'
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(interrupted, undefined),
                  ),
                  Effect.andThen(processFs.exists(target)),
                )
              : processFs.exists(target),
        };
        const fiber = yield* Effect.forkChild(
          loopProgram(
            {
              runId,
              session,
              script: [textTurn('never reached')],
              attachment: { attach: () => {}, detach },
            },
            [],
            blockedFs,
          ),
        );

        const opening = yield* Deferred.await(entered).pipe(
          Effect.timeoutOption('2 seconds'),
        );
        if (opening._tag === 'None') {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.interrupt(fiber);
        }
        expect(opening._tag).toBe('Some');
        const stopping = yield* Effect.forkChild(Fiber.interrupt(fiber));
        const cancelled = yield* Deferred.await(interrupted).pipe(
          Effect.timeoutOption('2 seconds'),
        );
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        expect(cancelled._tag).toBe('Some');
        expect(detach).toHaveBeenCalledTimes(1);
        const state = yield* session.ledger.load(runId).pipe(Effect.orDie);
        expect(state?.phase ?? null).toBeNull();
        const lease = session.followUps.claimLive(runId, 'loop');
        expect(lease).not.toBeNull();
        if (lease) session.followUps.release(lease, 'recoverable');
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  // The loop registers the flow context on the run handle and may interrupt
  // it in the same call. A throw anywhere after that first statement used to
  // strand the live context on the handle, because the pairing lived in the
  // value the callback never got to return.
  it.effect('detaches a host whose attach threw after wiring itself up', () =>
    Effect.gen(function* () {
      const session = yield* quietSession();
      const runId = startedRun(session);
      const attachFailure = new Error('host wiring failed');
      const detached: RunControls[] = [];

      const exit = yield* Effect.exit(
        loopProgram(
          {
            runId,
            session,
            script: [textTurn('never reached')],
            attachment: {
              attach: () => {
                throw attachFailure;
              },
              detach: (controls) => {
                detached.push(controls);
              },
            },
          },
          [],
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(detached).toHaveLength(1);
    }),
  );
});
