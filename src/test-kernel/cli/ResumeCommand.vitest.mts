import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import type { CliContext } from '@cli/runtime/cliContext';
import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  explainNonResumable: vi.fn(),
  initInteractiveCliPlatform: vi.fn(),
  resolveCliResumeSnapshot: vi.fn(),
  runChat: vi.fn(),
  writeTextStderr: vi.fn(),
}));

// `texra resume` always reopens the chat TUI (below), so it must route
// through initInteractiveCliPlatform — not plain initCliPlatform — to leave
// the TUI as the sole SIGINT/SIGTERM owner once it mounts (see
// initPlatform.ts).
vi.mock('@cli/runtime/initPlatform', () => ({
  initInteractiveCliPlatform: mocks.initInteractiveCliPlatform,
}));

vi.mock('@cli/runtime/logSinks', () => ({
  writeTextStderr: mocks.writeTextStderr,
}));

vi.mock('@cli/runtime/sessionResume', () => ({
  explainNonResumable: mocks.explainNonResumable,
  resolveCliResumeSnapshot: mocks.resolveCliResumeSnapshot,
}));

vi.mock('@cli/chat/tui/runChatTui', () => ({
  runChat: mocks.runChat,
}));

const EXECUTION_ID = 'exec-1' as ExecutionId;

function cliContext(overrides: Partial<CliContext> = {}): CliContext {
  return createTestCliContext({
    mode: 'interactive',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    ...overrides,
  });
}

function resumableResolution() {
  return {
    kind: 'toolUse',
    snapshot: {},
    streamId: 'stream-1',
    config: {
      agent: 'review',
      model: 'gpt-5',
    },
  } as const;
}

describe('runResumeExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initInteractiveCliPlatform.mockResolvedValue(undefined);
    mocks.resolveCliResumeSnapshot.mockResolvedValue(resumableResolution());
    mocks.runChat.mockResolvedValue({ exitCode: 0 });
  });

  it('uses the CLI context TTY snapshot before reopening chat', async () => {
    const resolution = resumableResolution();
    mocks.resolveCliResumeSnapshot.mockResolvedValueOnce(resolution);
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');

    await expect(
      runResumeExecution(cliContext({ stdoutIsTty: true }), EXECUTION_ID),
    ).resolves.toBe(0);

    expect(mocks.runChat).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        initialResume: {
          id: EXECUTION_ID,
          resolution,
        },
      }),
    );
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('routes platform init through the TUI-owning signal path, not headless init', async () => {
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');
    const context = cliContext({ stdoutIsTty: true });

    await runResumeExecution(context, EXECUTION_ID);

    // `texra resume` usually reopens the chat TUI, so it must route through
    // initInteractiveCliPlatform — not plain initCliPlatform — so the TUI can
    // later hand itself exclusive SIGINT/SIGTERM ownership once it mounts
    // (see initPlatform.ts).
    expect(mocks.initInteractiveCliPlatform).toHaveBeenCalledWith(
      expect.objectContaining({ ...context, quietLogs: true }),
    );
  });

  it('rejects resume when the context says stdout is not a TTY', async () => {
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');

    await expect(
      runResumeExecution(cliContext({ stdoutIsTty: false }), EXECUTION_ID),
    ).resolves.toBe(2);

    expect(mocks.initInteractiveCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliResumeSnapshot).not.toHaveBeenCalled();
    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra resume ${EXECUTION_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra run`.'),
    );
  });

  it('uses the local launcher in headless resume guidance', async () => {
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');

    await expect(
      runResumeExecution(
        cliContext({ commandName: 'texra-local', stdoutIsTty: false }),
        EXECUTION_ID,
      ),
    ).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra-local resume ${EXECUTION_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra-local run`.'),
    );
  });

  it('rejects resume in dumb terminals before falling through to chat', async () => {
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');

    await expect(
      runResumeExecution(cliContext({ termIsDumb: true }), EXECUTION_ID),
    ).resolves.toBe(2);

    expect(mocks.initInteractiveCliPlatform).not.toHaveBeenCalled();
    expect(mocks.resolveCliResumeSnapshot).not.toHaveBeenCalled();
    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'texra resume needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`. For non-interactive runs, use `texra run`.',
    );
  });

  it('uses the local launcher in dumb-terminal resume guidance', async () => {
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');

    await expect(
      runResumeExecution(
        cliContext({ commandName: 'texra-local', termIsDumb: true }),
        EXECUTION_ID,
      ),
    ).resolves.toBe(2);

    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      'texra-local resume needs a capable terminal: TERM=dumb disables the cursor controls Ink uses. If this is an interactive PTY, prefix the command with `TERM=xterm-256color`. For non-interactive runs, use `texra-local run`.',
    );
  });

  it('reports resume snapshot load failures as operational errors', async () => {
    mocks.resolveCliResumeSnapshot.mockResolvedValue({
      kind: 'load-failed',
      reason: 'KV timeout',
    });
    mocks.explainNonResumable.mockReturnValue(
      `Failed to load resumable session ${EXECUTION_ID}: KV timeout`,
    );
    const { runResumeExecution } = await import('@cli/runtime/resumeExecution');

    await expect(
      runResumeExecution(cliContext({ stdoutIsTty: true }), EXECUTION_ID),
    ).resolves.toBe(1);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      `Failed to load resumable session ${EXECUTION_ID}: KV timeout`,
    );
  });
});
