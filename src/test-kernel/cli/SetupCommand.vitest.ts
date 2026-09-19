import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test for the combined `texra setup` flow (agent-native
// onboarding PRD): State 0 picker first when credential-less, then the
// setup-agent chat — with the picker skipped entirely for already-
// credentialed users. The picker, platform init, and chat TUI are mocked;
// the decision flow in `runSetup` is real.

const mocks = vi.hoisted(() => ({
  hasUsableSetupCredential: vi.fn(),
  runCliOnboarding: vi.fn(),
  runChat: vi.fn(),
  initCliPlatform: vi.fn(),
  installCliProcessRuntime: vi.fn(),
}));

vi.mock('@model/setupCredentialAccess', () => ({
  hasUsableSetupCredential: mocks.hasUsableSetupCredential,
}));

vi.mock('@cli/onboarding/runOnboarding', () => ({
  runCliOnboarding: mocks.runCliOnboarding,
}));

vi.mock('@cli/chat/tui/runChatTui', () => ({
  runChat: mocks.runChat,
}));

// `texra setup` always ends in the chat TUI (below), so it must never pass
// `installSignalHandlers: false` — that leaves the TUI as the sole
// SIGINT/SIGTERM owner once it mounts (see initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
}));

vi.mock('@cli/runtime/cliProcessRuntime', async () => {
  const { Effect } = await import('effect');
  return {
    installCliProcessRuntime: mocks.installCliProcessRuntime,
    disposeCliProcessRuntime: Effect.void,
  };
});

import { runSetup } from '@cli/commands/setup';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createFakePlatform } from '@test/support/FakePlatform';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const INTERACTIVE_CONTEXT = createTestCliContext({
  mode: 'interactive',
  stdoutIsTty: true,
});

describe('texra setup combined flow', () => {
  beforeEach(() => {
    mocks.hasUsableSetupCredential
      .mockReset()
      .mockReturnValue(Effect.succeed(false));
    mocks.runCliOnboarding
      .mockReset()
      .mockReturnValue(Effect.succeed({ configured: false, declined: true }));
    mocks.runChat
      .mockReset()
      .mockResolvedValue({ exitCode: CliExitCode.Success });
    // The init now hands its caller the services it already holds, as a
    // program the command's own run yields.
    mocks.initCliPlatform
      .mockReset()
      .mockReturnValue(
        Effect.succeed({ ...createFakePlatform(), runtime: testRuntime() }),
      );
    mocks.installCliProcessRuntime
      .mockReset()
      .mockImplementation(async () => testRuntime());
  });

  it('rejects non-interactive terminals before doing anything', async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    try {
      const exit = await runSetup({
        ...INTERACTIVE_CONTEXT,
        mode: 'headless',
      });
      expect(exit).toBe(CliExitCode.Usage);
      expect(mocks.initCliPlatform).not.toHaveBeenCalled();
      expect(mocks.runCliOnboarding).not.toHaveBeenCalled();
      expect(mocks.runChat).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('leaves the platform signal handler installed for the TUI to take over', async () => {
    mocks.runCliOnboarding.mockReturnValue(
      Effect.succeed({
        configured: true,
        declined: false,
      }),
    );

    await runSetup(INTERACTIVE_CONTEXT);

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

    const exit = await runSetup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).toHaveBeenCalledTimes(1);
    expect(mocks.runChat).toHaveBeenCalledWith(INTERACTIVE_CONTEXT, {
      agentOverride: SETUP_AGENT_NAME,
    });
    expect(exit).toBe(CliExitCode.Success);
  });

  it('exits cleanly when the picker is skipped — no chat session', async () => {
    const exit = await runSetup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).toHaveBeenCalledTimes(1);
    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(exit).toBe(CliExitCode.Success);
  });

  it('skips the picker for already-credentialed users — straight to the agent', async () => {
    mocks.hasUsableSetupCredential.mockReturnValue(Effect.succeed(true));

    const exit = await runSetup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).not.toHaveBeenCalled();
    expect(mocks.runChat).toHaveBeenCalledWith(INTERACTIVE_CONTEXT, {
      agentOverride: SETUP_AGENT_NAME,
    });
    expect(exit).toBe(CliExitCode.Success);
  });
});
