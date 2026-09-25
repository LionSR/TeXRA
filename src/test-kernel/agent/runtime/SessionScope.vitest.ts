import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { TraceEmitter } from '@agent/trace';
import { AgentResume } from '@platform/interfaces';
import { MESSAGE_TYPES } from '@shared/schemas';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { readRunTranscript } from '@transcript/runTranscript';
import type { TranscriptRow } from '@ui/transcript';
import { generateRunId } from '@utils/core';

describe('session-owned transcripts and follow-up queues', () => {
  it.effect(
    "writes run trace entries to the launching session's transcript store only",
    () =>
      Effect.gen(function* () {
        const launching = createTestSession();
        const sibling = createTestSession();
        yield* Effect.addFinalizer(() =>
          launching.dispose().pipe(Effect.andThen(sibling.dispose())),
        );
        const runId = generateRunId();

        publishTestRunStart(launching, runId);
        yield* launching.settlePublications();
        const trace = new TraceEmitter();
        const detach = launching.attachRunTrace(trace, runId);
        yield* Effect.addFinalizer(() => Effect.sync(detach));
        const output = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
        output.append('owned by launching session');
        output.finalize();
        yield* launching.settlePublications();

        const rowText = (row: TranscriptRow) =>
          row.kind === 'assistant' ? row.text.full : row.kind;
        expect(
          (yield* readRunTranscript(launching, runId)).rows.map(rowText),
        ).toEqual(['owned by launching session']);
        expect((yield* readRunTranscript(sibling, runId)).rows).toEqual([]);
        expect(
          (yield* readRunTranscript(testDefaultSession(), runId)).rows,
        ).toEqual([]);
      }),
  );

  it.effect('commits partial streaming text when the run parks', () =>
    Effect.gen(function* () {
      const session = createTestSession();
      yield* Effect.addFinalizer(() => session.dispose());
      const runId = generateRunId();
      publishTestRunStart(session, runId);
      yield* session.settlePublications();
      const trace = new TraceEmitter();
      const detach = session.attachRunTrace(trace, runId);
      yield* Effect.addFinalizer(() => Effect.sync(detach));
      const output = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
      output.append('partial text');
      yield* session.settlePublications();
      // The `waiting` step parks the run and the loop commits the closure
      // facts in that batch (`loop/toolUse.ts`), so the partial text becomes
      // the row's final text instead of streaming forever.
      session.publish(session.streamClosureFacts(runId));
      yield* session.settlePublications();
      const { rows } = yield* readRunTranscript(session, runId);
      expect(
        rows.flatMap((row) =>
          row.kind === 'assistant' ? [row.text.full] : [],
        ),
      ).toEqual(['partial text']);
    }),
  );

  it.effect('keeps same-stream follow-up queues isolated by session', () =>
    Effect.gen(function* () {
      const a = createTestSession();
      const b = createTestSession();
      yield* Effect.addFinalizer(() =>
        a.dispose().pipe(Effect.andThen(b.dispose())),
      );
      const runId = generateRunId();

      expect(a.followUps.claimLive(runId, 'flow')).toBeDefined();
      expect(b.followUps.claimLive(runId, 'flow')).toBeDefined();

      a.followUps.terminalize(runId);

      expect(a.followUps.hasLiveOwner(runId)).toBe(false);
      expect(
        yield* a.followUps.submit(runId, { text: 'late' }, 'live_owner'),
      ).toEqual({ kind: 'refused' });
      expect(b.followUps.hasLiveOwner(runId)).toBe(true);
    }),
  );
});

describe('sendFollowUp host-path session routing', () => {
  it.effect(
    'resolves the follow-up target against the passed session, not the process default',
    () =>
      Effect.gen(function* () {
        const processSession = createTestSession();
        const parentRun = publishTestRunStart(processSession);
        yield* processSession.settlePublications();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() =>
            processSession.followUps.terminalize(parentRun),
          ).pipe(Effect.andThen(processSession.dispose())),
        );

        // A child run is tracked in the explicit process session, as desktop
        // composition does instead of using the module default.
        processSession.runs.track(
          testRunHandle({
            runId: generateRunId(),
            parent: parentRun,
            agent: 'orchestrator',
          }),
        );

        // A host-path caller (outside any run ALS, like the desktop IPC handler)
        // that passes its process session sees the live child and queues.
        expect(
          yield* submitFollowUp(parentRun, 'continue', {
            session: processSession,
          }).pipe(
            Effect.provideService(AgentResume, {
              tryResumeRun: () => Effect.succeed(false),
            }),
          ),
        ).toEqual({ status: 'queued', wake: 'failed' });

        // The default session does not own this run; selecting the actual
        // session is required for desktop follow-up delivery. With no live flow
        // and no checkpoint of its own, the classification it falls back to is
        // `finished`.
        expect(
          yield* submitFollowUp(parentRun, 'continue', {
            session: testDefaultSession(),
          }).pipe(
            Effect.provideService(AgentResume, {
              tryResumeRun: () => Effect.succeed(false),
            }),
          ),
        ).toEqual({
          status: 'failed',
          reason: 'finished',
        });
      }),
  );
});
