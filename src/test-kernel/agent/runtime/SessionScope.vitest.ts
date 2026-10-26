import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect } from 'vitest';
import { registryOf } from '@agent/runtime/runRegistry';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { TraceEmitter } from '@agent/trace';
import { MESSAGE_TYPES } from '@shared/schemas';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { testRunHandle } from '@test/support/runHandleFixtures';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import { readRunTranscript } from '@transcript/runTranscript';
import { generateRunId } from '@utils/core';

describe('session-owned transcripts and follow-up queues', () => {
  it.effect('commits partial streaming text when the run parks', () =>
    Effect.gen(function* () {
      const session = yield* createTestSession();
      yield* Effect.addFinalizer(() => closeSessionOf(session));
      const runId = generateRunId();
      publishTestRunStart(session, runId);
      yield* session.log.settled;
      const trace = new TraceEmitter((event) =>
        session.log.publish(runId, event),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => trace.close()));
      const output = trace.openRun(MESSAGE_TYPES.MODEL_RESPONSE);
      output.append('partial text');
      yield* session.log.settled;
      // The `waiting` step parks the run and the loop commits the closure
      // facts in that batch (`loop/toolUse.ts`), so the partial text becomes
      // the row's final text instead of streaming forever.
      publishTestRows(session, session.trace.closure(runId));
      yield* session.log.settled;
      const { rows } = yield* readRunTranscript(session, runId);
      expect(
        rows.flatMap((row) =>
          row.kind === 'assistant' ? [row.text.full] : [],
        ),
      ).toEqual(['partial text']);
    }),
  );
});

describe('sendFollowUp host-path session routing', () => {
  it.effect(
    'resolves the follow-up target against the passed session, not the process default',
    () =>
      Effect.gen(function* () {
        const processSession = yield* createTestSession();
        const parentRun = publishTestRunStart(processSession);
        yield* processSession.log.settled;
        yield* Effect.addFinalizer(() =>
          processSession.followUps
            .closeInput(parentRun)
            .pipe(Effect.andThen(closeSessionOf(processSession))),
        );

        // A child run is tracked in the explicit process session, as desktop
        // composition does instead of using the module default.
        registryOf(processSession.runs).track(
          testRunHandle({
            runId: generateRunId(),
            parent: parentRun,
            agent: 'orchestrator',
          }),
        );

        // A host-path caller (outside any run ALS, like the desktop IPC handler)
        // that passes its process session sees the live child and queues.
        expect(
          yield* submitFollowUp(
            parentRun,
            { text: 'continue', from: { kind: 'user' as const } },
            {
              session: processSession,
            },
          ),
        ).toEqual({ status: 'queued' });

        // The default session does not own this run; selecting the actual
        // session is required for desktop follow-up delivery. With no live flow
        // and no checkpoint of its own, the classification it falls back to is
        // `finished`.
        expect(
          yield* submitFollowUp(
            parentRun,
            { text: 'continue', from: { kind: 'user' as const } },
            {
              session: testDefaultSession(),
            },
          ),
        ).toEqual({
          status: 'failed',
          reason: 'finished',
        });
      }),
  );
});
