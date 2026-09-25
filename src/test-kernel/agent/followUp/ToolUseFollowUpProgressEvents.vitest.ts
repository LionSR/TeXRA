import { it } from '@effect/vitest';
import { Effect } from 'effect';

import { afterEach, describe, expect, vi } from 'vitest';

import { SessionHandle } from '@agent/runtime/SessionHandle';
import { RunInput } from '@agent/followUp/RunInput';
import {
  notifyFollowUpSent,
  submitFollowUp,
} from '@agent/followUp/ToolUseFollowUp';
import { AgentResume } from '@platform/interfaces';
import {
  aggregateId as qualifyAggregateId,
  RUN_OUTCOME,
  type RunId,
} from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { testRunHandle } from '@test/support/runHandleFixtures';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { fakeHostAgentResume } from '@test/support/setupPlatform';
import {
  createTestSession,
  publishTestRunStart,
  queuedFollowUps,
} from '@test/support/sessionTestUtils';
import { listenForFollowUp } from '@tools/executions/waitCoordination';

import {
  createRecordingHost,
  recordFollowUpsSent,
  seedActiveRun,
  seedTerminalRun,
} from '../progressTestUtils';

const runId = 'fa0001' as RunId;

let paperCount = 0;

/** The roots of one paper: a session's plane is keyed by its storage root,
 *  so sessions that must not hear each other get their own. */
function paperRoots() {
  paperCount += 1;
  return createFakeWorkspaceRoots({
    storagePath: `/workspace/paper-${paperCount}/.texra/storage`,
  });
}

describe('tool-use follow-up progress events', () => {
  const unsubscribeFollowUpObservers: Array<() => void> = [];
  const trackedRuns: Array<{
    readonly session: SessionHandle;
    readonly runId: RunId;
  }> = [];
  const sessions = new Set<SessionHandle>();

  afterEach(async () => {
    for (const unsubscribe of unsubscribeFollowUpObservers.splice(0)) {
      unsubscribe();
    }
    for (const { session, runId } of trackedRuns.splice(0)) {
      session.runs.untrack(runId);
    }
    for (const session of sessions) {
      await Effect.runPromise(session.dispose());
    }
    sessions.clear();
  });

  function trackSession(): SessionHandle {
    const session = createTestSession({ roots: paperRoots() });
    sessions.add(session);
    return session;
  }

  function trackToolUseFlow({
    session,
  }: {
    readonly session?: SessionHandle;
  } = {}): void {
    const handle = testRunHandle({ runId, agent: 'search' });
    const owner = session ?? testDefaultSession();
    handle.attachToolUseFlow({
      ownerSession: owner,
      requestImmediateCompaction: () => {},
      modelSwitchDisabledReason: () => Effect.succeed(undefined),
      switchModel: () => Effect.void,
      interrupt: () => {},
    });
    owner.runs.track(handle);
    trackedRuns.push({ session: owner, runId });
  }

  it.effect(
    'publishes sent follow-up events through the owning session fact hub',
    () =>
      Effect.gen(function* () {
        const run = createRecordingHost();
        const session = trackSession();
        publishTestRunStart(session, runId);
        yield* session.settlePublications();
        const sent = recordFollowUpsSent(session);
        const lease = session.followUps.claimLive(runId, 'flow')!;

        trackToolUseFlow({ session });

        const result = yield* submitFollowUp(runId, 'please continue', {
          session,
        }).pipe(Effect.provideService(AgentResume, fakeHostAgentResume));

        expect(result).toEqual({ status: 'sent' });
        const input = session.followUps.attachInput(
          runId,
          yield* RunInput.make,
          lease,
        )!;
        input.seed([]);
        expect(yield* input.take).toMatchObject({
          followUps: [{ content: { text: 'please continue', origin: 'user' } }],
        });
        expect(sent.sent).toEqual([runId]);
        expect(run.events).toEqual([]);
      }),
  );

  it('breaks a blocking wait when the owning session emits followUpSent', () => {
    const session = trackSession();
    const onFollowUp = vi.fn();
    const otherRun = 'fa0003' as RunId;

    const cleanup = listenForFollowUp(session, runId, onFollowUp);
    unsubscribeFollowUpObservers.push(cleanup);

    notifyFollowUpSent(otherRun, session);
    expect(onFollowUp).not.toHaveBeenCalled();

    notifyFollowUpSent(runId, session);
    expect(onFollowUp).toHaveBeenCalledOnce();
  });

  it.effect(
    'does not append through stale active contexts after final status',
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          seedTerminalRun(testDefaultSession(), runId, RUN_OUTCOME.COMPLETED),
        );
        // A finished run's driver gave its claim back with its last drain; these
        // rows stand in for that driver, so the claim goes back here too.
        yield* testDefaultSession().releaseClaims(
          qualifyAggregateId('run', runId),
        );
        trackToolUseFlow();

        const result = yield* submitFollowUp(runId, 'late follow-up', {
          session: testDefaultSession(),
        }).pipe(Effect.provideService(AgentResume, fakeHostAgentResume));

        // The run's own terminal row is the refusal: it finished.
        expect(result).toEqual({ status: 'failed', reason: 'finished' });
        expect(yield* queuedFollowUps(testDefaultSession(), runId)).toEqual([]);
      }),
  );

  it.effect(
    'queues follow-ups for resuming runs through registry admission',
    () =>
      Effect.gen(function* () {
        const resumingRunId = 'fa0002' as RunId;

        // A second activation is the resume the registry admits a follow-up for.
        yield* Effect.promise(() =>
          seedActiveRun(testDefaultSession(), resumingRunId, {
            resuming: true,
          }),
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            testDefaultSession().followUps.terminalize(resumingRunId),
          ),
        );

        const result = yield* submitFollowUp(
          resumingRunId,
          'queued while resuming',
          {
            session: testDefaultSession(),
          },
        ).pipe(Effect.provideService(AgentResume, fakeHostAgentResume));

        // The fake platform's resume port refuses, so the input stays queued
        // behind a failed wake.
        expect(result).toEqual({ status: 'queued', wake: 'failed' });
        expect(
          yield* queuedFollowUps(testDefaultSession(), resumingRunId),
        ).toMatchObject([{ text: 'queued while resuming' }]);
      }),
  );
});
