import { layer } from '@effect/vitest';
import { assert, expect } from 'vitest';

import { Effect, Exit, Layer, Scope } from 'effect';
import { createSessionExitController } from '@cli/chat/tui/sessionExitController';
import { rootRunId } from '@cli/chat/tui/state/cliState';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import type { TuiTerminal } from '@cli/tui/terminalCleanup';
import { SessionGraph } from '@test/support/testKernel';
import { spyOnStreamWrite } from './fixtures/streamWriteSpy';
import { boundTestSessionView } from './fixtures/sessionViewFixture';
import type { RunId } from '@texra-ai/harness/schemas';

/** What the process wrote to its standard streams during the test, which
 *  the exit's hint and warnings reach; the spies go with the test. */
const capturedOutput = Effect.acquireRelease(
  Effect.sync(() => {
    const written = { stdout: '', stderr: '' };
    const spies = [
      spyOnStreamWrite(process.stdout, (chunk) => (written.stdout += chunk)),
      spyOnStreamWrite(process.stderr, (chunk) => (written.stderr += chunk)),
    ];
    return { written, spies };
  }),
  ({ spies }) =>
    Effect.sync(() => {
      for (const spy of spies) spy.mockRestore();
    }),
).pipe(Effect.map(({ written }) => written));

/** The mounted TUI as the exit drives it: an Ink instance that has already
 *  unmounted, and a terminal that records whether it was released. */
const mountedTui = () => {
  const terminal = { released: false };
  const tuiTerminal: TuiTerminal = {
    suspend: () => {},
    resume: () => {},
    release: () => {
      terminal.released = true;
    },
  };
  // cast: the exit unmounts Ink and waits for its exit; nothing else of
  // the instance is read.
  const ink = {
    unmount: () => {},
    waitUntilExit: async () => {},
  } as unknown as Parameters<typeof createSessionExitController>[0]['ink'];
  return { terminal, tuiTerminal, ink };
};

/** The controller over the block's runtime, as the chat entry builds it. */
const createController = (
  session: TuiSession,
  submitted: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const runtime = yield* SessionGraph.runtime;
    const chatScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const { terminal, tuiTerminal, ink } = mountedTui();
    const controller = createSessionExitController({
      ink,
      session,
      commandName: 'texra',
      cwd: '/tmp/project',
      chatScope,
      // The test's scope stands in for the process's shutdown: the signal
      // holds the exit takes are released with it.
      shutdownScope: yield* Scope.Scope,
      terminal: tuiTerminal,
      runtime,
      // Only an exit that leaves a waiting root leaves the process here.
      leaveProcess: () =>
        Effect.die(new Error('the exit left the process unexpectedly')),
      submitted,
      rootRunEnded: Effect.void,
      getApprovalPolicy: () => 'ask',
      flushArtifacts: Effect.fail(new Error('disk full')),
      repaintAfterTerminalResume: () => {},
      interruptActive: () => {},
    });
    return { controller, terminal };
  });

// Live clock: the teardown's flush and exit sequence run in real time.
layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('chat TUI session exit controller', (it) => {
  it.effect(
    'restores the terminal and prints the hint when the graceful flush fails',
    () =>
      Effect.gen(function* () {
        const session = new TuiSession();
        // cast: the exit hint prints the id as held; nothing here decodes it.
        rootRunId.set('exec-graceful-flush' as RunId);
        const { controller, terminal } = yield* createController(session);
        const output = yield* capturedOutput;

        yield* Effect.promise(() => controller.exit());

        expect(output.stderr).toContain('Transcript flush failed during exit');
        expect(terminal.released).toBe(true);
        expect(output.stdout).toContain('texra resume exec-graceful-flush');
      }),
  );

  it.effect('names the run a launch the exit drained reached', () =>
    Effect.gen(function* () {
      const session = new TuiSession();
      const launched = session.claimLaunch();
      assert(launched !== undefined, 'no root is in flight');
      // The exit's drain is what lets the launch reach its run.
      const { controller } = yield* createController(
        session,
        Effect.sync(() =>
          // cast: the exit hint prints the id as held; nothing decodes it.
          session.endLaunch(launched, { runId: 'exec-launched' as RunId }),
        ),
      );
      const output = yield* capturedOutput;

      yield* Effect.promise(() => controller.exit());

      expect(output.stdout).toContain('texra resume exec-launched');
    }),
  );
});
