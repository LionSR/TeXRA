// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Stream } from 'effect';
import { beforeEach, describe, expect } from 'vitest';

// Local imports
import { defaultSession, SessionHandle } from '@agent/runtime/SessionHandle';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { setupPlatform } from '@test/support/setupPlatform';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import {
  requestToolEditApproval,
  type ToolEditApprovalRequest,
} from '@tools/approval/toolEditApproval';

type PendingToolEdit = Omit<ToolEditApprovalRequest, 'permission'>;

describe('Concurrent session tool edit approval handlers', () => {
  setupPlatform({ workspacePath: '/workspace', config: {}, files: {} });

  beforeEach(() => {
    defaultSession().approvals.clearAll();
  });

  it.effect('routes each in-flight request through its owning session', () =>
    Effect.scoped(
      Effect.gen(function* () {
        function makeRequest(tag: string): PendingToolEdit {
          return {
            path: `/workspace/${tag}.tex`,
            originalContent: `old-${tag}`,
            proposedContent: `new-${tag}`,
            sourceTool: 'write_file',
          };
        }

        function attachWindow(session: SessionHandle, appliedContent: string) {
          return Effect.gen(function* () {
            const seen: string[] = [];
            session.interactions.use({
              presentToolEdit: (staged) =>
                seen.push(staged.permission.relativePath),
            });
            yield* Effect.forkScoped(
              Stream.runForEach(session.events.all(session.now()), (event) =>
                Effect.sync(() => {
                  if (event.type !== 'request.opened') return;
                  if (event.payload.kind !== 'toolEdit') return;
                  session.publish([
                    {
                      type: 'request.decided',
                      aggregateId: event.aggregateId,
                      requestId: event.requestId,
                      decision: { action: 'approve', content: appliedContent },
                    },
                  ]);
                }),
              ),
            );
            return seen;
          });
        }

        const sessionA = createTestSession();
        const sessionB = createTestSession();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessionA.dispose();
            sessionB.dispose();
          }),
        );
        const windowA = yield* attachWindow(sessionA, 'from-a');
        const windowB = yield* attachWindow(sessionB, 'from-b');

        const runA = publishTestRunStart(sessionA);
        const runB = publishTestRunStart(sessionB);
        yield* Effect.all(
          [sessionA.settlePublications(), sessionB.settlePublications()].map(
            (settled) => Effect.tryPromise(() => settled),
          ),
        );

        const call = (
          session: SessionHandle,
          runId: typeof runA,
          request: PendingToolEdit,
        ) =>
          requestToolEditApproval(request).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { runId, session, toolPolicy: {} },
              }),
            ),
          );

        const requestA = yield* Effect.forkScoped(
          call(sessionA, runA, makeRequest('a')),
        );
        const requestB = yield* Effect.forkScoped(
          call(sessionB, runB, makeRequest('b')),
        );
        const [resultA, resultB] = yield* Effect.all([
          Fiber.join(requestA),
          Fiber.join(requestB),
        ]);

        expect(windowA).toEqual(['a.tex']);
        expect(windowB).toEqual(['b.tex']);
        expect(resultA).toMatchObject({
          action: 'apply',
          appliedContent: 'from-a',
        });
        expect(resultB).toMatchObject({
          action: 'apply',
          appliedContent: 'from-b',
        });
      }),
    ),
  );
});
