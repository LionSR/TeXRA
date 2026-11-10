// Third-party imports
import { layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, Schema, Stream, Context } from 'effect';
import { expect } from 'vitest';
import { type BashRequest, generateRunId } from '@texra-ai/harness/schemas';
import { defineTool } from '@texra-ai/harness/plugins';
import { humanGrant } from '@agent/runtime/runApprovalQueue';

// Local imports
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { guardedToolCall } from '@agent/runtime/loop/toolGuard';
import { SessionLog, Approvals } from '@shared/session/runHistory';
import {
  setTestApprovalPolicy,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';
import { commandTool } from '@test/agent/progressTestUtils';

/** Watch bash requests in a scoped fiber, as a real host surface does. */
function watchBashRequests(session: Context.Context<SessionServices>) {
  return Effect.gen(function* () {
    const opened: BashRequest[] = [];
    const firstOpened = yield* Deferred.make<void>();

    yield* Effect.forkScoped(
      Stream.runForEach(
        Context.get(session, SessionLog).tail(
          Context.get(session, SessionLog).now(),
        ),
        (event) =>
          Effect.gen(function* () {
            if (event.type !== 'request.opened') return;
            if (event.payload.kind !== 'bash') return;
            opened.push(event.payload.data);
            yield* Deferred.succeed(firstOpened, undefined);
          }),
      ),
    );

    return {
      opened,
      firstOpened: Deferred.await(firstOpened),
    };
  });
}

// Live clock: the session's publisher and readers run on real turns.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'command approval queueing',
  (it) => {
    // The project's policy is the fake host's setting, shared by the file,
    // so each test sets the one it runs under.
    it.effect(
      'lets never override a run bypass and a hook allow at the shared boundary',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* isolatedTestSession();
            const runId = generateRunId();
            yield* setTestApprovalPolicy('never');
            yield* publishTestRunStart(session, runId);
            yield* Context.get(session, Approvals).change(
              runId,
              humanGrant(['bash'], true),
            );
            const requests = yield* watchBashRequests(session);

            expect(
              Context.get(session, Approvals).permission(
                runId,
                'bash',
                'allow',
              ),
            ).toEqual({
              action: 'deny',
              reason: 'Denied by the approval policy.',
            });
            expect(requests.opened).toEqual([]);
          }),
        ),
    );

    it.effect(
      'a command grant turned on answers the open request it covers',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setTestApprovalPolicy('ask');
            const session = yield* isolatedTestSession();
            const runId = generateRunId();
            yield* publishTestRunStart(session, runId);
            yield* Context.get(session, SessionLog).settled;
            const requests = yield* watchBashRequests(session);

            const request = (command: string) =>
              guardedToolCall(commandTool, { command }).pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    run: { runId, session, toolPolicy: {} },
                  }),
                ),
              );

            const first = yield* Effect.forkScoped(request('echo first'));
            yield* requests.firstOpened;
            expect(requests.opened.map(({ command }) => command)).toEqual([
              'echo first',
            ]);

            // The grant's transaction decides the open request; the next
            // command runs under the grant without asking.
            yield* Context.get(session, Approvals).change(
              runId,
              humanGrant(['bash'], true),
            );
            expect(yield* Fiber.join(first)).toMatchObject({
              status: 'executed',
            });
            expect(yield* request('echo second')).toMatchObject({
              status: 'executed',
            });
            expect(requests.opened).toHaveLength(1);
          }),
        ),
    );

    // The grant that approves a request as it opens answers it while it
    // waits: a call of a tool with no command grant is the delegated-work
    // grant's, at open and when that grant is turned on later.
    it.effect(
      'the delegated-work grant turned on answers a waiting call of a tool with no command grant',
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* setTestApprovalPolicy('ask');
            const session = yield* isolatedTestSession();
            const runId = generateRunId();
            yield* publishTestRunStart(session, runId);
            yield* Context.get(session, SessionLog).settled;
            const requests = yield* watchBashRequests(session);

            const call = yield* Effect.forkScoped(
              guardedToolCall(callTool, { command: 'echo other' }).pipe(
                Effect.provide(
                  nativeToolTestLayer({
                    run: { runId, session, toolPolicy: {} },
                  }),
                ),
              ),
            );
            yield* requests.firstOpened;
            yield* Context.get(session, Approvals).change(
              runId,
              humanGrant(['superYolo'], true),
            );
            expect(yield* Fiber.join(call)).toMatchObject({
              status: 'executed',
            });
          }),
        ),
    );
  },
);

/** A tool whose calls are asked about as commands but declares no command
 *  grant: only the delegated-work grant answers them. */
const callTool = defineTool({
  name: 'other_command',
  description: 'Run a command of another tool.',
  schema: Schema.Struct({ command: Schema.String }),
  guard: { command: { text: ({ command }) => command } },
  execute: ({ command }) => Effect.succeed(`ran ${command}`),
});
