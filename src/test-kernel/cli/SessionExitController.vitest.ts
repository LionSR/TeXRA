import { layer } from '@effect/vitest';
import { beforeEach, expect, vi } from 'vitest';

import { Effect, Layer, Scope } from 'effect';
import { createSessionExitController } from '@cli/chat/tui/sessionExitController';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { SessionGraph } from '@test/support/testKernel';
import { boundTestSessionView } from './fixtures/sessionViewFixture';
import type { RunId } from '@texra-ai/harness/schemas';

const mocks = vi.hoisted(() => ({
  leaveProcess: vi.fn(),
  writeTextStderrAndWait: vi.fn(),
  writeTextStdout: vi.fn(),
}));

vi.mock('@cli/runtime/platform/cliContext', () => ({
  readCliCwd: () => '/tmp/project',
}));

vi.mock('@cli/runtime/platform/initPlatform', () => ({
  leaveAtOnce: {},
  runCliExit: (exit: Effect.Effect<void, unknown>) => Effect.runPromise(exit),
}));

vi.mock('@cli/runtime/platform/logSinks', () => ({
  writeTextStderrAndWait: mocks.writeTextStderrAndWait,
  writeTextStdout: mocks.writeTextStdout,
}));

vi.mock('@cli/tui/terminalCleanup', () => ({
  supportsTerminalJobControl: () => false,
}));

/** The controller over the block's runtime, as the chat entry builds it. */
const createController = (session: TuiSession) =>
  Effect.map(SessionGraph.runtime, (runtime) => {
    const terminal = { suspend: vi.fn(), resume: vi.fn(), release: vi.fn() };
    const controller = createSessionExitController({
      ink: {
        clear: vi.fn(),
        repaint: vi.fn(),
        rerender: vi.fn(),
        unmount: vi.fn(),
        waitUntilExit: vi.fn(),
        waitUntilRenderFlush: vi.fn(),
        cleanup: vi.fn(),
      },
      session,
      commandName: 'texra',
      cwd: '/tmp/project',
      chatScope: Scope.makeUnsafe(),
      terminal,
      runtime,
      leaveProcess: mocks.leaveProcess,
      submitted: Effect.void,
      getApprovalPolicy: () => 'ask',
      flushArtifacts: Effect.fail(new Error('disk full')),
      repaintAfterTerminalResume: vi.fn(),
      interruptActive: vi.fn(),
    });
    return { controller, terminal };
  });

// Live clock: the teardown's flush and exit sequence run in real time.
layer(Layer.provideMerge(boundTestSessionView, SessionGraph.hosted), {
  excludeTestServices: true,
})('chat TUI session exit controller', (it) => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.leaveProcess.mockReturnValue(Effect.void);
    mocks.writeTextStderrAndWait.mockReturnValue(Effect.void);
  });

  it.effect(
    'restores the terminal and prints the hint when the graceful flush fails',
    () =>
      Effect.gen(function* () {
        const session = new TuiSession();
        // cast: the exit hint prints the id as held; nothing here decodes it.
        session.runId = 'exec-graceful-flush' as RunId;
        const { controller, terminal } = yield* createController(session);

        yield* Effect.promise(() => controller.exit());

        expect(mocks.writeTextStderrAndWait).toHaveBeenCalledWith(
          expect.stringContaining('Transcript flush failed during exit'),
        );
        expect(terminal.release).toHaveBeenCalledOnce();
        expect(mocks.writeTextStdout).toHaveBeenCalledWith(
          expect.stringContaining('texra resume exec-graceful-flush'),
        );
      }),
  );
});
