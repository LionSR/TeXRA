import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test for the combined `texra setup` flow (agent-native
// onboarding PRD): State 0 picker first when credential-less, then the
// setup-agent chat — with the picker skipped entirely for already-
// credentialed users. The picker and platform init are mocked; the decision
// flow in `runSetup` is real, and its chat arm is the session it names for
// `defineCliCommand` to mount.

const mocks = vi.hoisted(() => ({
  hasUsableSetupCredential: vi.fn(),
  runCliOnboarding: vi.fn(),
  initCliPlatform: vi.fn(),
}));

vi.mock('@model/setupCredentialAccess', () => ({
  hasUsableSetupCredential: mocks.hasUsableSetupCredential,
}));

vi.mock('@cli/onboarding/runOnboarding', () => ({
  runCliOnboarding: mocks.runCliOnboarding,
}));

// `texra setup` always ends in the chat TUI (below), so it must never pass
// `installSignalHandlers: false` — that leaves the TUI as the sole
// SIGINT/SIGTERM owner once it mounts (see initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

import { runSetup } from '@cli/commands/setup';
import { CliUsageError } from '@cli/runtime/cliContext';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createFakePlatform } from '@test/support/FakePlatform';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const INTERACTIVE_CONTEXT = createTestCliContext({
  mode: 'interactive',
  stdoutIsTty: true,
});

/** The command's program, run the way `defineCliCommand` runs it. */
const setup = (context: typeof INTERACTIVE_CONTEXT) =>
  testRuntime().runPromise(runSetup(context));

describe('texra setup combined flow', () => {
  beforeEach(() => {
    mocks.hasUsableSetupCredential
      .mockReset()
      .mockReturnValue(Effect.succeed(false));
    mocks.runCliOnboarding
      .mockReset()
      .mockReturnValue(Effect.succeed({ configured: false, declined: true }));
    // The init now hands its caller the services it already holds, as a
    // program the command's own run yields.
    mocks.initCliPlatform
      .mockReset()
      .mockReturnValue(
        Effect.succeed({ ...createFakePlatform(), runtime: testRuntime() }),
      );
  });

  it('rejects non-interactive terminals before doing anything', () => {
    expect(() =>
      runSetup({
        ...INTERACTIVE_CONTEXT,
        mode: 'headless',
      }),
    ).toThrow(CliUsageError);
    expect(mocks.initCliPlatform).not.toHaveBeenCalled();
    expect(mocks.runCliOnboarding).not.toHaveBeenCalled();
  });

  it('leaves the platform signal handler installed for the TUI to take over', async () => {
    mocks.runCliOnboarding.mockReturnValue(
      Effect.succeed({
        configured: true,
        declined: false,
      }),
    );

    await setup(INTERACTIVE_CONTEXT);

    expect(mocks.initCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ ...INTERACTIVE_CONTEXT, quietLogs: true }),
    );
    expect(mocks.initCliPlatform.mock.calls[0]?.[0]).not.toHaveProperty(
      'installSignalHandlers',
    );
  });

  it('runs the picker, then enters the setup-agent chat once configured', async () => {
    mocks.runCliOnboarding.mockReturnValue(
      Effect.succeed({
        configured: true,
        declined: false,
      }),
    );

    const outcome = await setup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ chat: { agentOverride: SETUP_AGENT_NAME } });
  });

  it('exits cleanly when the picker is skipped — no chat session', async () => {
    const outcome = await setup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).toHaveBeenCalledTimes(1);
    expect(outcome).toBe(CliExitCode.Success);
  });

  it('skips the picker for already-credentialed users — straight to the agent', async () => {
    mocks.hasUsableSetupCredential.mockReturnValue(Effect.succeed(true));

    const outcome = await setup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).not.toHaveBeenCalled();
    expect(outcome).toEqual({ chat: { agentOverride: SETUP_AGENT_NAME } });
  });
});
