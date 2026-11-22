import { layer } from '@effect/vitest';
import { Effect, Fiber, Schema } from 'effect';
import { expect } from 'vitest';

import {
  AgentConfigSchema,
  generateRunId,
  RunIdSchema,
} from '@texra-ai/worldline/schemas';
import { getRunRecords } from '@agent/storage/runOwnership';
import { registerRun } from '@agent/storage/runLifecycle';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

const baseConfig = Schema.decodeUnknownSync(AgentConfigSchema)({
  label: 'chat',
  model: 'deepseek/deepseek-v4-flash',
  instruction: 'Check the proof.',
});
const runId = Schema.decodeUnknownSync(RunIdSchema)('abc123');
const options = {
  identity: { kind: 'agent', agent: 'chat' },
  takesFollowUps: true,
} as const;

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'run registration and finalization',
  (it) => {
    it.layer(FakeHost.layer({ workspaceRoot: '/workspace/root' }), {
      buildPerTest: true,
    })((it) => {
      it.effect(
        'admits a child whose parent is still queued on the publisher',
        () =>
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            // The parent's `run.start` is published and left uncommitted,
            // which is what a record read sees: without the barrier ahead of
            // it, this child is refused as if its parent did not exist. The
            // publication runs to its enqueue, then the child registers, and
            // the join fails the case if the row was refused.
            const parentId = generateRunId();
            const published = yield* Effect.forkChild(
              publishTestRunStart(session, parentId),
              { startImmediately: true },
            );
            yield* registerRun(runId, baseConfig, {
              ...options,
              parent: { id: parentId, call: null },
            }).pipe(Effect.provide(session));
            yield* Fiber.join(published);
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
                  parent: { id: absentParentId, call: null },
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
