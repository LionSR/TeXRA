// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Slash command execution dispatch.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import * as codexAuth from '@auth/codex';
import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import { type SlashCommandContext } from '@cli/chat/tui/commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import {
  listSlashCommands,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { CLI_LOCAL_STREAM_ID } from '@cli/chat/tui/state/transcript';
import {
  activeForm,
  activeStreamId,
  patchSessionMeta,
  resetCliState,
  patchStream,
  streams,
} from '@cli/chat/tui/state/cliState';
import * as apiStatus from '@cli/runtime/apiStatus';
import * as chatGptLogin from '@cli/runtime/chatgptLogin';
import type { CliContext } from '@cli/runtime/cliContext';
import * as supabaseAuth from '@cli/runtime/supabaseAuth';
import type { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { CliExitCode } from '@cli/runtime/exitCodes';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import {
  STREAM_PHASE,
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
    interruptedStreamId: undefined,
    executionId: undefined,
    runPromise: undefined,
    runExitCode: CliExitCode.Success,
    runCompleted: false,
    stopRequested: false,
  };
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

function lastEntryText(
  streamId: StreamTabId = CLI_LOCAL_STREAM_ID,
): string | undefined {
  return streams.get().get(streamId)?.entries.at(-1)?.text;
}

describe('handleTuiSlashCommand', () => {
  it('opens alias-addressed structured forms through the canonical command', async () => {
    registerBuiltinSlashCommands();

    const handled = await handleTuiSlashCommand(
      '/models',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    expect(activeForm.get()?.commandName).toBe('model');
  });

  it('opens the login form for bare /login', async () => {
    registerBuiltinSlashCommands();

    const handled = await handleTuiSlashCommand(
      '/login',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    expect(activeForm.get()?.commandName).toBe('login');
  });

  it('opens the masked provider-key form through /key and /keys', async () => {
    registerBuiltinSlashCommands();
    const context = createContext(createSession());

    expect(await handleTuiSlashCommand('/key', context)).toBe(true);
    expect(activeForm.get()?.commandName).toBe('key');

    activeForm.set(undefined);
    expect(await handleTuiSlashCommand('/keys', context)).toBe(true);
    expect(activeForm.get()?.commandName).toBe('key');
  });

  it('discards inline key arguments without recording the secret', async () => {
    registerBuiltinSlashCommands();
    const secret = 'sk-private-test-value';

    expect(
      await handleTuiSlashCommand(
        `/keys ${secret}`,
        createContext(createSession()),
      ),
    ).toBe(true);

    expect(activeForm.get()?.commandName).toBe('key');
    expect(JSON.stringify(activeForm.get())).not.toContain(secret);
    expect(lastEntryText()).toContain('does not accept a key as an argument');
    expect(JSON.stringify([...streams.get().values()])).not.toContain(secret);
  });

  it('keeps malformed and mistyped key commands out of the transcript', async () => {
    registerBuiltinSlashCommands();
    const context = createContext(createSession());
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
      expect(await handleTuiSlashCommand(line, context)).toBe(true);
      expect(activeForm.get()?.commandName).toBe('key');
      activeForm.set(undefined);
    }

    expect(await handleTuiSlashCommand(`/ky ${typoSecret}`, context)).toBe(
      true,
    );
    expect(activeForm.get()?.commandName).toBe('key');
    const transcript = JSON.stringify([...streams.get().values()]);
    for (const secret of [...malformedSecrets, typoSecret]) {
      expect(transcript).not.toContain(secret);
    }
  });

  it('leaves path-like equals input for the agent', async () => {
    registerBuiltinSlashCommands();

    expect(
      await handleTuiSlashCommand(
        '/tmp=backup',
        createContext(createSession()),
      ),
    ).toBe(false);
    expect(
      await handleTuiSlashCommand(
        '/keynote.tex',
        createContext(createSession()),
      ),
    ).toBe(false);
  });

  it('does not mistake ordinary key-prefixed commands for credential input', async () => {
    registerBuiltinSlashCommands();

    expect(
      await handleTuiSlashCommand(
        '/keyboard shortcuts',
        createContext(createSession()),
      ),
    ).toBe(true);
    expect(activeForm.get()).toBeUndefined();
    expect(lastEntryText()).toContain('Unknown command: /keyboard');
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

  it('clears TeXRA and ChatGPT credentials on /logout', async () => {
    registerBuiltinSlashCommands();
    const signOutSupabase = vi
      .spyOn(supabaseAuth, 'signOutCliSupabase')
      .mockResolvedValue(undefined);
    const signOutChatGpt = vi
      .spyOn(chatGptLogin, 'signOutCliChatGpt')
      .mockResolvedValue({
        preferenceUpdate: { effective: false, target: 'global' },
      });
    vi.spyOn(apiStatus, 'loadCliApiStatusLines').mockResolvedValue([
      'API mode: personal',
    ]);

    const handled = await handleTuiSlashCommand(
      '/logout',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt).toHaveBeenCalledOnce();
    const entry = lastEntryText();
    expect(entry).toContain('Signed out.');
    expect(entry).toContain('ChatGPT subscription disabled for Codex models.');
  });

  it('reports successful TeXRA sign-out when ChatGPT logout fails', async () => {
    registerBuiltinSlashCommands();
    vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockResolvedValue(undefined);
    vi.spyOn(chatGptLogin, 'signOutCliChatGpt').mockRejectedValue(
      new Error('Codex logout failed'),
    );
    vi.spyOn(apiStatus, 'loadCliApiStatusLines').mockResolvedValue([
      'API mode: personal',
    ]);

    const handled = await handleTuiSlashCommand(
      '/logout',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    const entry = lastEntryText();
    expect(entry).toContain('Signed out.');
    expect(entry).toContain('ChatGPT sign-out failed: Codex logout failed');
  });

  it('reports ChatGPT sign-out success when only preference cleanup fails', async () => {
    registerBuiltinSlashCommands();
    vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockResolvedValue(undefined);
    vi.spyOn(chatGptLogin, 'signOutCliChatGpt').mockResolvedValue({
      preferenceError: 'Config write failed',
    });
    vi.spyOn(apiStatus, 'loadCliApiStatusLines').mockResolvedValue([
      'API mode: personal',
    ]);

    const handled = await handleTuiSlashCommand(
      '/logout',
      createContext(createSession()),
    );

    expect(handled).toBe(true);
    const entry = lastEntryText();
    expect(entry).toContain('Signed out.');
    expect(entry).toContain(
      'ChatGPT subscription preference could not be disabled: Config write failed',
    );
    expect(entry).not.toContain('ChatGPT sign-out failed');
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
    expect(activeStreamId.get()).toBeUndefined();
  });

  it('uses the provided process cwd when formatting /status resume hints', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const streamId = 'stream-1' as StreamTabId;
    session.streamId = streamId;
    session.executionId = 'exec-1' as ExecutionId;
    activeStreamId.set(streamId);
    patchStream(streamId, (slice) => ({
      ...slice,
      status: STREAM_PHASE.WAITING,
    }));

    const handled = await handleTuiSlashCommand(
      '/status',
      createContext(session, { processCwd: '/tmp/workspace' }),
    );

    expect(handled).toBe(true);
    const statusText = lastEntryText(streamId);
    expect(statusText).toContain('resume later with: texra resume exec-1');
    expect(statusText).not.toContain('--cwd');
  });

  it('reports the access route that produced the focused stream usage', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const streamId = 'stream-access' as StreamTabId;
    activeStreamId.set(streamId);
    patchSessionMeta({ apiMode: 'personal', model: 'gpt55' });
    patchStream(streamId, (slice) => ({
      ...slice,
      model: 'gpt55',
      status: STREAM_PHASE.WAITING,
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cost: 0,
        usageRoute: 'relay',
      },
    }));

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(streamId);
    expect(statusText).toContain('model access: Included TeXRA access');
    expect(statusText).not.toContain('model access: ChatGPT subscription');
  });

  it('surfaces status lookup failures without rejecting', async () => {
    registerBuiltinSlashCommands();

    const handled = await handleTuiSlashCommand(
      '/status',
      createContext(createSession(), {
        getApprovalPolicy: () => {
          throw new Error('Credential store unavailable');
        },
      }),
    );

    expect(handled).toBe(true);
    expect(lastEntryText()).toBe('Credential store unavailable');
  });

  it('does not advertise the current ephemeral session as resumable', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const streamId = 'stream-ephemeral' as StreamTabId;
    session.streamId = streamId;
    session.executionId = 'exec-ephemeral' as ExecutionId;
    activeStreamId.set(streamId);
    patchSessionMeta({ transcriptMode: 'ephemeral' });
    patchStream(streamId, (slice) => ({
      ...slice,
      status: STREAM_PHASE.WAITING,
    }));

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(streamId);
    expect(statusText).not.toContain('session: exec-ephemeral');
    expect(statusText).not.toContain('resume later with:');
  });
});
