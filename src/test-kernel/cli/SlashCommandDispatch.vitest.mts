// Slash command execution dispatch.

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as codexAuth from '@auth/codex';
import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import { type SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import {
  listSlashCommands,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import {
  cliState,
  patchStream,
  resetCliState,
} from '@cli/chat/tui/state/cliState';
import * as chatGptLogin from '@cli/runtime/chatgptLogin';
import type { CliContext } from '@cli/runtime/cliContext';
import type { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import {
  STREAM_STATUS,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  resetCliState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function createSession(): TuiSession {
  return {
    streamId: undefined,
    executionId: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
  };
}

function createCliContext(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/workspace',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'ask',
    stdoutIsTty: true,
    termIsDumb: false,
    colorEnabled: false,
    version: '0.0.0-test',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

function createContext(
  session: TuiSession,
  overrides: Partial<SlashCommandContext> = {},
): SlashCommandContext {
  let approvalPolicy: CliApprovalPolicy = 'ask';
  return {
    cliContext: createCliContext(),
    session,
    cwd: '/tmp/workspace',
    processCwd: '/tmp/launcher',
    initialAgent: 'chat',
    initialModel: 'deepseekT',
    interruptActive: vi.fn(),
    requestInputExit: vi.fn(),
    getApprovalPolicy: () => approvalPolicy,
    setApprovalPolicy: (policy) => {
      approvalPolicy = policy;
    },
    canSelectModel: () => true,
    resetSession: vi.fn(),
    resumeExecution: (_id: ExecutionId) => Promise.resolve(),
    ...overrides,
  };
}

describe('handleTuiSlashCommand', () => {
  it('opens alias-addressed structured forms through the canonical command', async () => {
    registerBuiltinSlashCommands();

    const handled = await handleTuiSlashCommand(
      '/models',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    expect(cliState.activeForm.get()?.commandName).toBe('model');
  });

  it('opens the login form for bare /login', async () => {
    registerBuiltinSlashCommands();

    const handled = await handleTuiSlashCommand(
      '/login',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    expect(cliState.activeForm.get()?.commandName).toBe('login');
  });

  it('uses ChatGPT device-code login from a likely remote shell', async () => {
    registerBuiltinSlashCommands();
    vi.stubEnv('SSH_TTY', '/dev/pts/3');
    vi.spyOn(chatGptLogin, 'signInCliChatGpt').mockResolvedValue({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAtMs: Date.now() + 60_000,
      email: 'person@example.com',
    });
    vi.spyOn(codexAuth, 'setPreferCodexSubscription').mockResolvedValue({
      effective: true,
      target: 'global',
    });

    const handled = await handleTuiSlashCommand(
      '/login chatgpt',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    expect(chatGptLogin.signInCliChatGpt).toHaveBeenCalledWith(
      expect.objectContaining({ device: true, noBrowser: false }),
      expect.any(Object),
    );
  });

  it('treats /quit as the canonical exit command without echoing it', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const interruptActive = vi.fn();
    const requestInputExit = vi.fn();

    const handled = await handleTuiSlashCommand(
      '/quit',
      createContext(session, {
        interruptActive,
        requestInputExit,
      }),
    );

    expect(handled).toBe(true);
    expect(session.stopRequested).toBe(true);
    expect(interruptActive).toHaveBeenCalledOnce();
    expect(requestInputExit).toHaveBeenCalledOnce();
    expect(cliState.activeStreamId.get()).toBeUndefined();
  });

  it('uses the provided process cwd when formatting /status resume hints', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const streamId = 'stream-1' as StreamTabId;
    session.streamId = streamId;
    session.executionId = 'exec-1' as ExecutionId;
    cliState.activeStreamId.set(streamId);
    patchStream(streamId, (slice) => ({
      ...slice,
      status: STREAM_STATUS.WAITING,
    }));

    const handled = await handleTuiSlashCommand(
      '/status',
      createContext(session, { processCwd: '/tmp/workspace' }),
    );

    expect(handled).toBe(true);
    const statusText = cliState.streams
      .get()
      .get(streamId)
      ?.entries.at(-1)?.text;
    expect(statusText).toContain('resume later with: texra resume exec-1');
    expect(statusText).not.toContain('--cwd');
  });
});
