import { layer } from '@effect/vitest';
import { Effect, Context, Layer } from 'effect';
import { expect } from 'vitest';

import { submitFollowUp } from '@agent/followUp/ToolUseFollowUp';
import { Inbox } from '@agent/followUp/Inbox';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  isolatedTestSession,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';

// The file's process default session, beside the one each case opens.
layer(Layer.provideMerge(TestSession.layer(), SessionGraph.hosted), {
  excludeTestServices: true,
})('sendFollowUp host-path session routing', (it) => {
  it.effect(
    'resolves the follow-up target against the passed session, not the process default',
    () =>
      Effect.gen(function* () {
        const processSession = yield* isolatedTestSession();
        const parentRun = yield* publishTestRunStart(processSession);
        yield* Context.get(processSession, SessionLog).settled;
        yield* Effect.addFinalizer(() =>
          Context.get(processSession, Inbox).closeInput(parentRun),
        );

        // A host-path caller (outside any run ALS, like the desktop IPC handler)
        // that passes its process session sees the live child and queues.
        expect(
          yield* submitFollowUp(
            parentRun,
            { text: 'continue', from: { kind: 'user' as const } },
            {},
          ).pipe(Effect.provide(processSession)),
        ).toEqual({ status: 'queued' });

        // The default session does not own this run; selecting the actual
        // session is required for desktop follow-up delivery. With no live flow
        // and no checkpoint of its own, the classification it falls back to is
        // `finished`.
        expect(
          yield* submitFollowUp(
            parentRun,
            { text: 'continue', from: { kind: 'user' as const } },
            {},
          ).pipe(
            Effect.provide(yield* Effect.flatMap(TestSession, sessionHandleOf)),
          ),
        ).toEqual({
          status: 'failed',
          reason: 'finished',
        });
      }),
  );
});
