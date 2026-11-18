// Failure mode: cancelling a host call as the window receives it leaves the
// call open on either side, so the window's work runs on for nobody or the
// next call through the attachment waits behind a dead one.

// Third-party imports
import { it } from '@effect/vitest';
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Scheduler,
} from 'effect';
import { assert, expect } from 'vitest';

// Local imports
import type { Session } from '@texra-ai/harness';
import {
  HostWindows,
  makeWindowTable,
} from '@texra/controllers/server/hostWindows';
import { attachWindowHost } from '@texra/controllers/server/windowHost';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';

it.effect('a cancelled call ends at the window and frees the attachment', () => {
  const table = makeWindowTable();
  // This host-call boundary needs only the session's identity and attachment;
  // no run or database is opened by the synthetic session.
  const unused = (): never => {
    throw new Error('This host-call fixture does not support session data.');
  };
  const session: Session = {
    roots: createFakeWorkspaceRoots({
      storagePath: '/host-call-test',
      workspaceRoot: '/host-call-project',
    }),
    get view() {
      return unused();
    },
    records: unused,
    get listRuns() {
      return unused();
    },
    deleteRuns: unused,
    start: unused,
    resume: unused,
    request: unused,
    attach: () => Effect.void,
  };
  return Effect.gen(function* () {
    const hosts = Context.get(
      yield* Layer.build(HostWindows.layer(table)),
      HostWindows,
    );
    // Vary the preceding work so normal scheduler yields can land between
    // the call's send, the window's receipt and the interruption.
    for (let padding = 0; padding < 32; padding++) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const received = yield* Deferred.make<void>();
          const ended = yield* Deferred.make<'interrupted' | 'answered'>();
          let calls = 0;
          yield* attachWindowHost(
            yield* hosts.localLink(session),
            '/host-call-project',
            {
              readDiagnostics: () => {
                calls += 1;
                // The first call waits for its cancellation; a later one
                // answers at once.
                if (calls > 1) return Effect.succeed([]);
                return Deferred.succeed(received, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(ended, 'interrupted'),
                  ),
                );
              },
            },
          );
          const read = table.editors.at(session.roots.storage).readDiagnostics;
          assert(read !== undefined);
          const requester = yield* Effect.forkScoped(
            Effect.gen(function* () {
              for (let index = 0; index < padding; index++)
                yield* Effect.sync(() => {});
              return yield* read('/host-call-project/test.tex');
            }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32)),
          );
          yield* Deferred.await(received);
          yield* Fiber.interrupt(requester);
          const interrupted = yield* Fiber.await(requester);
          assert(Exit.isFailure(interrupted));
          expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
          expect(yield* Deferred.await(ended)).toBe('interrupted');
          expect(yield* read('/host-call-project/test.tex')).toEqual([]);
        }),
      );
    }
  });
});
