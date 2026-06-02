import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliContext } from '@cli/runtime/cliContext';
import type { ExecutionId } from '@shared/schemas';

const mocks = vi.hoisted(() => ({
  explainNonResumable: vi.fn(),
  initCliPlatform: vi.fn(),
  resolveCliResumeSnapshot: vi.fn(),
  runChat: vi.fn(),
  writeTextStderr: vi.fn(),
}));

vi.mock('@cli/runtime/initPlatform', () => ({
  initCliPlatform: mocks.initCliPlatform,
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
  return {
    cwd: '/tmp/project',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    stderrIsTty: true,
    stdoutColorEnabled: true,
    stderrColorEnabled: true,
    colorEnabled: true,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
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
  };
}

describe('runResumeExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.initCliPlatform.mockResolvedValue(undefined);
    mocks.resolveCliResumeSnapshot.mockResolvedValue(resumableResolution());
    mocks.runChat.mockResolvedValue({ exitCode: 0 });
  });

  it('uses the CLI context TTY snapshot before reopening chat', async () => {
    const { runResumeExecution } = await import('@cli/commands/resume');

    await expect(
      runResumeExecution(cliContext({ stdoutIsTty: true }), EXECUTION_ID),
    ).resolves.toBe(0);

    expect(mocks.runChat).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        resumeExecutionId: EXECUTION_ID,
        agentOverride: 'review',
        modelOverride: 'gpt-5',
      }),
    );
    expect(mocks.writeTextStderr).not.toHaveBeenCalled();
  });

  it('rejects resume when the context says stdout is not a TTY', async () => {
    const { runResumeExecution } = await import('@cli/commands/resume');

    await expect(
      runResumeExecution(cliContext({ stdoutIsTty: false }), EXECUTION_ID),
    ).resolves.toBe(2);

    expect(mocks.runChat).not.toHaveBeenCalled();
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining(`texra --resume ${EXECUTION_ID}`),
    );
    expect(mocks.writeTextStderr).toHaveBeenCalledWith(
      expect.stringContaining('For scripting, use `texra run`.'),
    );
  });
});
