import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

import { RunIdSchema, AgentConfigSchema } from '@texra-ai/harness/schemas';
import { getRunRecords } from '@agent/storage/runRecords';
import { registerRun } from '@agent/storage/runLifecycle';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const baseConfig = Schema.decodeUnknownSync(AgentConfigSchema)({
  agent: 'chat',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Check the proof.',
});
const runId = Schema.decodeUnknownSync(RunIdSchema)('abc123');
const options = {
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'nativeInteractive',
} as const;

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'run registration and finalization',
  (it) => {
    it.layer(FakeHost.layer({ workspacePath: '/workspace/root' }), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'admits a child whose parent is still queued on the publisher',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            // The parent's `run.start` is published and left uncommitted,
            // which is what a record read sees: without the barrier ahead of
            // it, this child is refused as if its parent did not exist.
            const parentRunId = publishTestRunStart(session);
            yield* registerRun(runId, baseConfig, {
              ...options,
              parentRunId,
            }).pipe(Effect.provide(session));
            expect(
              yield* getRunRecords(runId)
                .exists()
                .pipe(Effect.provide(session)),
            ).toBe(true);
            // A parent nothing ever published must still refuse its child
            // rather than wait on the barrier for a row that is not coming.
            const absentParentId =
              Schema.decodeUnknownSync(RunIdSchema)('def456');
            const refusal = yield* Effect.flip(
              registerRun(
                Schema.decodeUnknownSync(RunIdSchema)('fed789'),
                baseConfig,
                {
                  ...options,
                  parentRunId: absentParentId,
                },
              ).pipe(Effect.provide(session)),
            );
            expect(refusal.message).toBe(
              `Parent run ${absentParentId} is unavailable.`,
            );
          }),
      );
    });
  },
);
