// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it } from 'vitest';
import { it as effectIt } from '@effect/vitest';
import { Deferred, Effect, Layer, ManagedRuntime } from 'effect';

import { createRunContext, withRunContext } from '@agent/runtime/RunContext';
import { effectRuntime, initProcessRuntime } from '@platform/processRuntime';
import { RunIdSchema, type ExternalInquiryPermission } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { ExternalInquiryTool } from '@tools/inquiry/ExternalInquiryTool';

const RUN_ID = RunIdSchema.parse('a5c000000001');

describe('ExternalInquiryTool host interaction dispatch', () => {
  // Tool writes a new inquiry record to storage; keep state isolated.
  setupPlatform();

  it('surfaces a rejected openExternalInquiry() as a tool error instead of an unhandled rejection', async () => {
    const session = createTestSession();
    const parentLease = session.followUps.claimLive(RUN_ID, 'flow')!;
    session.interactions.use({
      cancel: () => {},
      openExternalInquiry: () =>
        Promise.reject(new Error('external inquiry panel unavailable')),
    });

    try {
      const result = await withRunContext(
        createRunContext({ runId: RUN_ID, session }),
        () =>
          new ExternalInquiryTool().call({
            command: 'ask',
            question:
              'Does a synchronous panel failure surface as a tool error?',
          }),
      );

      // Before the fix, `void interaction` dropped the rejection: the promise
      // was never awaited or attached to a .catch(), so the tool call proceeded
      // to `status: 'executed'` and the rejection surfaced later as a process
      // level unhandled rejection instead of a tool error result.
      expect(result.status).toBe('error');
      expect(result.error).toContain('external inquiry panel unavailable');
    } finally {
      session.followUps.release(parentLease, 'terminal');
      session.dispose();
    }
  });

  effectIt.live(
    'dispatches concurrent inquiries to their originating sessions',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const owners = [
            { name: 'first', id: RunIdSchema.parse('a5c000000011') },
            { name: 'second', id: RunIdSchema.parse('a5c000000012') },
          ].map(({ name, id }) => {
            const session = createTestSession();
            const runId = publishTestRunStart(session, id);
            const lease = session.followUps.claimLive(runId, 'flow')!;
            const received: ExternalInquiryPermission[] = [];
            session.interactions.use({
              cancel: () => {},
              openExternalInquiry: async (permission) => {
                received.push(permission);
              },
            });
            return { name, session, runId, lease, received };
          });
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              for (const owner of owners) {
                owner.session.followUps.release(owner.lease, 'terminal');
                owner.session.dispose();
              }
            }),
          );
          const previous = effectRuntime();
          const services = yield* Effect.promise(() => previous.context());
          // A cold runtime can finish admission after both callers have left
          // their run contexts, as with asynchronous process identity lookup.
          const admitted = yield* Deferred.make<void>();
          const runtime = ManagedRuntime.make(
            Layer.effectContext(
              Deferred.await(admitted).pipe(Effect.as(services)),
            ),
          );
          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              initProcessRuntime(previous);
              yield* runtime.disposeEffect;
            }),
          );
          initProcessRuntime(runtime);
          class DispatchInquiry extends ExternalInquiryTool {
            dispatch(question: string) {
              return this.execute({ command: 'ask', question });
            }
          }
          const pending = owners.map((owner) =>
            withRunContext(
              createRunContext({
                session: owner.session,
                runId: owner.runId,
              }),
              () => new DispatchInquiry().dispatch(owner.name),
            ),
          );
          yield* Deferred.succeed(admitted, undefined);
          const results = yield* Effect.forEach(
            pending,
            (result) => Effect.promise(() => result),
            { concurrency: 'unbounded' },
          );
          yield* Effect.forEach(owners, (owner) =>
            Effect.promise(() => owner.session.flushArtifacts()),
          );
          expect(results.map((result) => result.status)).toEqual([
            'executed',
            'executed',
          ]);
          for (const owner of owners) {
            expect(
              owner.received.map(({ question, runId }) => ({
                question,
                runId,
              })),
            ).toEqual([{ question: owner.name, runId: owner.runId }]);
          }
        }),
      ),
  );
});
