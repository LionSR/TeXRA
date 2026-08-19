import { beforeEach, describe, expect, it, vi } from 'vitest';

// Integration test for the combined `texra setup` flow (agent-native
// onboarding PRD): State 0 picker first when credential-less, then the
// setup-agent chat — with the picker skipped entirely for already-
// credentialed users. The picker, platform init, and chat TUI are mocked;
// the decision flow in `runSetup` is real.

const mocks = vi.hoisted(() => ({
  hasCliRunCredential: vi.fn(),
  runCliOnboarding: vi.fn(),
  runChat: vi.fn(),
  initInteractiveCliPlatform: vi.fn(),
}));

vi.mock('@cli/runtime/credentialStatus', () => ({
  hasCliRunCredential: mocks.hasCliRunCredential,
}));

vi.mock('@cli/onboarding/runOnboarding', () => ({
  runCliOnboarding: mocks.runCliOnboarding,
}));

vi.mock('@cli/chat/tui/runChatTui', () => ({
  runChat: mocks.runChat,
}));

// `texra setup` always ends in the chat TUI (below), so it must route through
// initInteractiveCliPlatform — not plain initCliPlatform — to leave the TUI
// as the sole SIGINT/SIGTERM owner once it mounts (see initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initInteractiveCliPlatform: mocks.initInteractiveCliPlatform,
}));

import { runSetup } from '@cli/commands/setup';
import { CliExitCode } from '@cli/runtime/exitCodes';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';

const INTERACTIVE_CONTEXT = createTestCliContext({
  mode: 'interactive',
  stdoutIsTty: true,
});

describe('texra setup combined flow', () => {
  beforeEach(() => {
    mocks.hasCliRunCredential.mockReset().mockResolvedValue(false);
    mocks.runCliOnboarding
      .mockReset()
      .mockResolvedValue({ configured: false, declined: true });
    mocks.runChat
      .mockReset()
      .mockResolvedValue({ exitCode: CliExitCode.Success });
    mocks.initInteractiveCliPlatform.mockReset().mockResolvedValue(undefined);
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
      expect(mocks.initInteractiveCliPlatform).not.toHaveBeenCalled();
      expect(mocks.runCliOnboarding).not.toHaveBeenCalled();
      expect(mocks.runChat).not.toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('routes platform init through the TUI-owning signal path, not headless init', async () => {
    mocks.runCliOnboarding.mockResolvedValue({
      configured: true,
      declined: false,
    });

    await runSetup(INTERACTIVE_CONTEXT);

    expect(mocks.initInteractiveCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ ...INTERACTIVE_CONTEXT, quietLogs: true }),
    );
  });

  it('runs the picker, then enters the setup-agent chat once configured', async () => {
    mocks.runCliOnboarding.mockResolvedValue({
      configured: true,
      declined: false,
    });

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
    mocks.hasCliRunCredential.mockResolvedValue(true);

    const exit = await runSetup(INTERACTIVE_CONTEXT);

    expect(mocks.runCliOnboarding).not.toHaveBeenCalled();
    expect(mocks.runChat).toHaveBeenCalledWith(INTERACTIVE_CONTEXT, {
      agentOverride: SETUP_AGENT_NAME,
    });
    expect(exit).toBe(CliExitCode.Success);
  });

  it('propagates the chat session exit code', async () => {
    mocks.hasCliRunCredential.mockResolvedValue(true);
    mocks.runChat.mockResolvedValue({ exitCode: CliExitCode.AgentError });

    await expect(runSetup(INTERACTIVE_CONTEXT)).resolves.toBe(
      CliExitCode.AgentError,
    );
  });
});
