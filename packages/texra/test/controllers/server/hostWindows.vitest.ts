// Failure mode: cancelling a host request as its frame is delivered leaves
// its answer registered, so a late answer is accepted after its caller ended.

// Third-party imports
import { it } from '@effect/vitest';
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Queue,
  Scheduler,
  Stream,
} from 'effect';
import { assert, expect } from 'vitest';

// Local imports
import type { Session } from '@texra-ai/harness';
import { HostWindows } from '@texra/controllers/server/hostWindows';
import type { HostAttachFrame } from '@texra/controllers/server/hostCalls';
import {
  makeEditorHost,
  type DiagnosticsReadFailed,
} from '@texra/tools/editorHost';
import type { GenericDiagnostic } from '@texra/utils/diagnostics/diagnosticFormatting';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';

it.effect('releases cancelled calls before accepting a late answer', () => {
  const messages: string[] = [];
  const editor = makeEditorHost();
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
      yield* Layer.build(HostWindows.layer(editor)),
      HostWindows,
    );
    // Vary the preceding work so normal scheduler yields can land between
    // registration, sending the frame and waiting for its answer.
    for (let padding = 0; padding < 32; padding++) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const frames = yield* Queue.unbounded<HostAttachFrame>();
          let requester:
            | Fiber.Fiber<readonly GenericDiagnostic[], DiagnosticsReadFailed>
            | undefined;
          yield* Effect.forkScoped(
            Stream.runForEach(
              hosts.attach(session, ['readDiagnostics']),
              (frame) =>
                Effect.gen(function* () {
                  if (frame.kind === 'call') {
                    assert(requester !== undefined);
                    yield* Fiber.interrupt(requester);
                  }
                  yield* Queue.offer(frames, frame);
                }),
            ),
          );
          const attached = yield* Queue.take(frames);
          expect(attached.kind).toBe('attached');
          const read = editor.at(session.roots.storage).readDiagnostics;
          assert(read !== undefined);
          requester = yield* Effect.forkScoped(
            Effect.gen(function* () {
              for (let index = 0; index < padding; index++)
                yield* Effect.sync(() => {});
              return yield* read('/host-call-project/test.tex');
            }).pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, 32)),
          );
          const call = yield* Queue.take(frames);
          assert(call.kind === 'call');
          const interrupted = yield* Fiber.await(requester);
          assert(Exit.isFailure(interrupted));
          expect(Cause.hasInterruptsOnly(interrupted.cause)).toBe(true);
          yield* hosts.answer(call.id, { ok: true, value: [] });
          expect(
            messages.some((message) =>
              message.includes(`host call ${call.id} after its wait ended`),
            ),
          ).toBe(true);
        }),
      );
    }
  }).pipe(
    Effect.provide(
      Logger.layer([
        Logger.make(({ message }) => messages.push(String(message))),
      ]),
    ),
  );
});
