// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, Context } from 'effect';
import { expect } from 'vitest';

// Local imports
import { requestToolEditApproval } from '@texra-ai/harness/plugins';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { SessionLog } from '@shared/session/runHistory';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import {
  FakeHost,
  isolatedTestSession,
  SessionGraph,
} from '@test/support/testKernel';

type PendingToolEdit = Parameters<typeof requestToolEditApproval>[0];

/** The process, over a fresh host for the test. */
const perTest = Layer.provideMerge(
  SessionGraph.layer,
  FakeHost.layer({ workspaceRoot: '/workspace', config: {}, files: {} }),
);

// Live clock: the sessions' publishers and readers run on real turns.
layer(perTest, { buildPerTest: true, excludeTestServices: true })(
  'Concurrent session tool edit approval handlers',
  (it) => {
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

          function attachWindow(
            session: Context.Context<SessionServices>,
            appliedContent: string,
          ) {
            return Effect.gen(function* () {
              const seen: string[] = [];
              yield* Effect.forkScoped(
                Stream.runForEach(
                  Context.get(session, SessionLog).tail(
                    Context.get(session, SessionLog).now(),
                  ),
                  (event) =>
                    Effect.gen(function* () {
                      if (event.type !== 'request.opened') return;
                      if (event.payload.kind !== 'toolEdit') return;
                      seen.push(event.payload.data.relativePath);
                      yield* publishTestRows(session, [
                        {
                          type: 'request.decided',
                          aggregateId: event.aggregateId,
                          requestId: event.requestId,
                          decision: {
                            action: 'approve',
                            content: appliedContent,
                          },
                        },
                      ]);
                    }),
                ),
              );
              return seen;
            });
          }

          const sessionA = yield* isolatedTestSession();
          const sessionB = yield* isolatedTestSession();
          const windowA = yield* attachWindow(sessionA, 'from-a');
          const windowB = yield* attachWindow(sessionB, 'from-b');

          const runA = yield* publishTestRunStart(sessionA);
          const runB = yield* publishTestRunStart(sessionB);
          yield* Effect.all(
            [
              Context.get(sessionA, SessionLog).settled,
              Context.get(sessionB, SessionLog).settled,
            ],
            {
              concurrency: 'unbounded',
            },
          );

          const call = (
            session: Context.Context<SessionServices>,
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
  },
);
