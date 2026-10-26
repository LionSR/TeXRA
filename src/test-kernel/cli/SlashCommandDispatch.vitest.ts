// Test composition imports

import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';

// Slash command run dispatch.

import { afterEach, beforeAll, beforeEach, describe, expect, vi } from 'vitest';

import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import { loginFromChat } from '@cli/chat/tui/commands/handlers/loginCommands';
import {
  type SlashCommandContext,
  type SlashCommandOutput,
} from '@cli/chat/tui/commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import { installSlashCommands } from '@cli/chat/tui/commands/slashRegistry';
import { notices } from '@cli/chat/tui/state/transcript';
import { resetCliState, transientNotice } from '@cli/chat/tui/state/cliState';
import { activeForm } from '@cli/chat/tui/state/formSlot';
import * as subscriptionLogin from '@cli/runtime/subscriptionLogin';
import type { CliContext } from '@cli/runtime/cliContext';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { withProcessServices } from '@platform/processRuntime';
import type { ApprovalPolicy } from '@shared/approvalPolicy';
import { type RunId } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { testRuntime, testSessionOf } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets } from '@test/support/FakePlatform';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import {
  bindTestSessionView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

// The runs a case names live in the fold's view: /status reads child
// counts, parent edges, and each stream's phase from there.
const seeded = new Map<RunId, RunView>();
function syncSeededView(): void {
  seedView(viewWith([...seeded.values()]));
}
beforeAll(bindTestSessionView);
// `/plan` reads the focused run off the session's own fold, `/status` off the
// TUI's projection of it; one seeded map answers both.
beforeEach(() => {
  vi.spyOn(testDefaultSession().view, 'run').mockImplementation((id) =>
    seeded.get(id),
  );
});
afterEach(() => {
  installSlashCommands([]);
  seeded.clear();
  syncSeededView();
  resetCliState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
/**
 * The process stores the built-in commands and the slash context read, the
 * pair the chat entry point threads in from its own platform services.
 */
const services = {
  secrets: new FakeSecrets(),
  stores: makeFakeSettingsStores('cli').stores,
  runtime: testRuntime(),
  runtimeSession: testSessionOf(testDefaultSession()),
  // Read when a case asks: each case's fake host opens its own session.
  get runSession() {
    return testSessionOf(testDefaultSession());
  },
};

function createSession(): TuiSession {
  return new TuiSession();
}

function createCliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    cwd: '/tmp/workspace',
    mode: 'interactive',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    version: '0.0.0-test',
    ...overrides,
  });
}

function createContext(
  session: TuiSession = createSession(),
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  let approvalPolicy: ApprovalPolicy = 'ask';
  return {
    cliContext: createCliContext(),
    session,
    runtimeSession: services.runtimeSession,
    runSession: services.runSession,
    secrets: services.secrets,
    stores: services.stores,
    runtime: testRuntime(),
    processCwd: '/tmp/launcher',
    requestInputExit: vi.fn(),
    getApprovalPolicy: () => approvalPolicy,
    setApprovalPolicy: (policy) =>
      Effect.sync(() => {
        approvalPolicy = policy;
      }),
    resetSession: vi.fn(),
    resumeRun: (_id: RunId) => Effect.void,
    ...overrides,
  };
}

function transcriptJson(): string {
  return JSON.stringify(notices.get());
}

function expectFormOpens(
  line: string,
  commandName: string,
  context: SlashCommandContext = createContext(),
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    expect(yield* dispatchSlash(line, context)).toBe(true);
    expect(activeForm.get()?.commandName).toBe(commandName);
  });
}

/** The dispatcher as the composer runs it: one program on the process
 *  services the composer threads in. */
function dispatchSlash(
  line: string,
  context: SlashCommandContext = createContext(),
): Effect.Effect<boolean, unknown> {
  return withProcessServices(
    services.runtime,
    handleTuiSlashCommand(line, context),
  );
}

function silentOutput(): SlashCommandOutput {
  return { appendOutcome: vi.fn(), setNotice: vi.fn(), writeProgress: vi.fn() };
}

/** A sign-in mock whose promise rejects when its abort signal fires. */
/**
 * A sign-in program that never completes on its own and records whether the
 * slash handler's cancellation reached it as fiber interruption.
 */
function interruptibleProgram(): {
  program: Effect.Effect<never>;
  interrupted: () => boolean;
} {
  let interrupted = false;
  return {
    interrupted: () => interrupted,
    program: Effect.never.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          interrupted = true;
        }),
      ),
    ),
  };
}

/** Let a forked sign-in reach its never-ending program before the interrupt
 *  lands: a few turns of the event loop cover the scheduler. */
const started = Effect.promise(
  () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
);

describe('handleTuiSlashCommand', () => {
  it.effect('discards inline key arguments without recording the secret', () =>
    Effect.gen(function* () {
      registerBuiltinSlashCommands({ ...services });
      const secret = 'sk-private-test-value';

      yield* expectFormOpens(`/keys ${secret}`, 'key');

      expect(JSON.stringify(activeForm.get())).not.toContain(secret);
      expect(transientNotice.get()?.text).toContain(
        'does not accept a key as an argument',
      );
      expect(transcriptJson()).not.toContain(secret);
    }),
  );

  it.effect(
    'keeps malformed and mistyped key commands out of the transcript',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const context = createContext();
        const malformedSecrets = [
          'sk-equals-private-value',
          'sk-colon-private-value',
          'sk-slash-private-value',
          'sk-concatenated-private-value',
          'sk-transposed-private-value',
        ];
        const typoSecret = 'sk-typo-private-value';

        for (const line of [
          `/key=${malformedSecrets[0]}`,
          `/key:${malformedSecrets[1]}`,
          `/key/${malformedSecrets[2]}`,
          `/key${malformedSecrets[3]}`,
          `/kye:${malformedSecrets[4]}`,
        ]) {
          yield* expectFormOpens(line, 'key', context);
          activeForm.set(undefined);
        }

        yield* expectFormOpens(`/ky ${typoSecret}`, 'key', context);
        const transcript = transcriptJson();
        for (const secret of [...malformedSecrets, typoSecret]) {
          expect(transcript).not.toContain(secret);
        }
      }),
  );

  it.effect(
    'redacts arbitrary concatenated key input without forcing the key form',
    () =>
      Effect.gen(function* () {
        registerBuiltinSlashCommands({ ...services });
        const secret = 'keyArbitraryCredentialValue';

        expect(yield* dispatchSlash(`/${secret}`, createContext())).toBe(true);
        expect(activeForm.get()).toBeUndefined();
        expect(transcriptJson()).not.toContain(secret);
      }),
  );

  it.effect(
    'cancels an interactive sign-in when its fiber is interrupted',
    () =>
      Effect.gen(function* () {
        const signIn = interruptibleProgram();
        vi.spyOn(subscriptionLogin, 'signInCliSubscription').mockReturnValue(
          signIn.program,
        );

        const fiber = yield* Effect.forkChild(
          withProcessServices(
            services.runtime,
            loginFromChat(
              'chatgpt --no-browser',
              services.stores,
              createCliContext(),
              silentOutput(),
            ),
          ),
        );
        yield* started;
        yield* Fiber.interrupt(fiber);

        expect(signIn.interrupted()).toBe(true);
      }),
  );
});
