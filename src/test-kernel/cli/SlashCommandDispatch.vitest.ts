// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Slash command execution dispatch.

import { afterEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import { applyCliModelAccessSelection } from '@cli/chat/tui/commands/handlers/apiModeCommands';
import {
  showCliMemoryList,
  showCliMemoryPreview,
} from '@cli/chat/tui/commands/handlers/memoryCommands';
import { loginFromChat } from '@cli/chat/tui/commands/handlers/loginCommands';
import {
  type SlashCommandContext,
  type SlashCommandOutput,
} from '@cli/chat/tui/commands/handlers/slashContext';
import { registerBuiltinSlashCommands } from '@cli/chat/tui/commands/registerBuiltins';
import {
  listSlashCommands,
  registerSlashCommand,
  unregisterSlashCommand,
} from '@cli/chat/tui/commands/slashRegistry';
import { CLI_LOCAL_STREAM_ID } from '@cli/chat/tui/state/transcript';
import {
  activeForm,
  activeStreamId,
  closeForegroundReader,
  closeInfoPane,
  codexPreferenceVersion,
  foregroundReader,
  infoPane,
  patchSessionMeta,
  resetCliState,
  patchStream,
  streams,
  transientNotice,
  type ConversationEntry,
  setStreamStatusInCliState,
} from '@cli/chat/tui/state/cliState';
import {
  bindChildStreamState,
  invalidateChildStreams,
  unbindChildStreamState,
} from '@cli/chat/tui/state/childExecutions';
import * as apiStatus from '@cli/runtime/apiStatus';
import * as chatGptLogin from '@cli/runtime/chatgptLogin';
import type { CliContext } from '@cli/runtime/cliContext';
import * as modelAccessSelection from '@cli/runtime/modelAccessSelection';
import * as supabaseAuth from '@cli/runtime/supabaseAuth';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import { SessionState } from '@controllers/session/SessionState';
import type { StreamArtifactReader } from '@controllers/session/StreamArtifactProjection';
import * as codexPreference from '@model/codex/codexPreference';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  AgentCategory,
  STREAM_PHASE,
  type ActiveChildInfo,
  type ExecutionId,
  type Plan,
  type StreamPhase,
  type StreamTabId,
  type TodoItem,
} from '@shared/schemas';
import { RESEARCHER_ACCESS } from '@shared/copy/onboarding';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import * as memoryFileSystem from '@tools/memory/memoryFileSystem';

// Child rosters and parent edges live on the adapter-bound `SessionState`;
// /status resolves both its child counts and the root transcript target from
// there, so each roster row lands together with its metadata parent edge.
let childState: SessionState | undefined;

afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  if (childState) {
    unbindChildStreamState(childState);
    childState = undefined;
  }
  resetCliState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function seedChildRoster(
  parentStreamId: StreamTabId,
  rows: readonly ActiveChildInfo[],
): void {
  if (!childState) {
    childState = new SessionState(defaultSession());
    bindChildStreamState(childState);
  }
  const state = childState;
  state.streamLogs.ensureStream(parentStreamId);
  state.getOrCreateStreamState(parentStreamId, AgentCategory.ToolUse);
  state.updateStreamState(parentStreamId, (prev) => ({
    ...prev,
    subagents: [...rows],
  }));
  for (const row of rows) {
    state.streamLogs.ensureStream(row.childStreamId);
    state.setStreamParent(row.childStreamId, parentStreamId);
  }
  invalidateChildStreams();
}

function createSession(): TuiSession {
  return new TuiSession();
}

function mockModelAccessOverview(): void {
  vi.spyOn(apiStatus, 'loadCliModelAccessOverview').mockResolvedValue({
    access: {
      apiFallback: 'personal',
      preferences: {
        chatGpt: 'off',
        grok: 'off',
      },
      codingPlans: {
        kimiCode: { preferred: false, keySet: false },
        glmCodingPlan: { preferred: false, keySet: false },
      },
      chatGptSignedIn: false,
      grokSignedIn: false,
    },
    lines: ['model access: Your own API keys'],
  });
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
  let approvalPolicy: TexraApprovalPolicy = 'ask';
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

function localEntries(): readonly ConversationEntry[] {
  return streams.get().get(CLI_LOCAL_STREAM_ID)?.entries ?? [];
}

function localEntryPairs(): Array<{ role: string; text: string }> {
  return localEntries().map(({ role, text }) => ({ role, text }));
}

function transcriptJson(): string {
  return JSON.stringify([...streams.get().values()]);
}

async function expectFormOpens(
  line: string,
  commandName: string,
  context: SlashCommandContext = createContext(),
): Promise<void> {
  expect(await handleTuiSlashCommand(line, context)).toBe(true);
  expect(activeForm.get()?.commandName).toBe(commandName);
}

function silentOutput(): SlashCommandOutput {
  return { appendOutcome: vi.fn(), setNotice: vi.fn(), writeProgress: vi.fn() };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function workPlanSnapshots(
  read: (streamId: StreamTabId) => {
    readonly plan: Plan | null;
    readonly todos: readonly TodoItem[];
  },
  preload: StreamArtifactReader['preload'] = async () => undefined,
): StreamArtifactReader {
  return {
    preload: vi.fn(preload),
    getOutputFiles: () => ({}),
    getMissingOutputs: () => ({}),
    getCompileFailures: () => ({}),
    getRunUsage: () => new Map(),
    getWorkPlan: (streamId) => {
      const { plan, todos } = read(streamId);
      return { plan, todos: [...todos], planSummary: null };
    },
  };
}

/** A sign-in mock whose promise rejects when its abort signal fires. */
function abortRejection(): {
  mock: (options: { signal?: AbortSignal }) => Promise<never>;
  receivedSignal: () => AbortSignal | undefined;
} {
  let receivedSignal: AbortSignal | undefined;
  return {
    receivedSignal: () => receivedSignal,
    mock: (options) => {
      receivedSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(options.signal?.reason),
          { once: true },
        );
      });
    },
  };
}

function mockSignOuts(): {
  signOutSupabase: MockInstance<typeof supabaseAuth.signOutCliSupabase>;
  signOutChatGpt: MockInstance<typeof chatGptLogin.signOutCliChatGpt>;
} {
  const signOutSupabase = vi
    .spyOn(supabaseAuth, 'signOutCliSupabase')
    .mockResolvedValue(undefined);
  const signOutChatGpt = vi
    .spyOn(chatGptLogin, 'signOutCliChatGpt')
    .mockResolvedValue({
      preferenceUpdate: { effective: false, target: 'global' },
    });
  mockModelAccessOverview();
  return { signOutSupabase, signOutChatGpt };
}

function expectAccessStatusText(text: string | undefined): void {
  expect(text).toContain('ChatGPT: preferred');
  expect(text).toContain('Kimi Code: not preferred');
  expect(text).toContain('Otherwise: Included access');
  expect(text).toContain('Researcher');
  expect(text).toContain('included usage this month: 25% used, 75% remaining');
}

describe('handleTuiSlashCommand', () => {
  it('opens reference commands without leaving transcript rows', async () => {
    registerBuiltinSlashCommands();
    const context = createContext();

    await handleTuiSlashCommand('/tools', context);
    expect(localEntries()).toEqual([]);

    await handleTuiSlashCommand('/help', context);
    expect(infoPane.get()).toMatchObject({ title: '/help' });
    expect(infoPane.get()?.lines.join('\n')).toContain('**Keyboard**');
    expect(localEntries()).toEqual([]);

    closeInfoPane();
    await handleTuiSlashCommand('/goal', context);
    expect(infoPane.get()).toMatchObject({ title: '/goal' });
    expect(infoPane.get()?.lines.join('\n')).toContain(
      'Goal mode starts from an approved plan',
    );
    expect(localEntries()).toEqual([]);
  });

  it('opens a live work-plan reader for the focused stream', async () => {
    let canonical = { plan: null, todos: [] } as {
      plan: Plan | null;
      todos: readonly TodoItem[];
    };
    const snapshots = workPlanSnapshots(() => canonical);
    registerBuiltinSlashCommands({ workPlanSnapshots: snapshots });
    const context = createContext();

    await handleTuiSlashCommand('/plan', context);
    expect(transientNotice.get()?.text).toBe('No focused session.');

    const streamId = 'plan-reader' as StreamTabId;
    patchStream(streamId, (slice) => ({ ...slice }));
    activeStreamId.set(streamId);
    await handleTuiSlashCommand('/plan', context);
    expect(transientNotice.get()?.text).toBe(
      'The focused session has no work plan.',
    );

    canonical = {
      plan: { objective: 'Check every case.' },
      todos: [
        {
          content: 'Check the base case',
          activeForm: 'Checking the base case',
          status: 'in_progress',
        },
      ],
    };
    await handleTuiSlashCommand('/plan', context);
    expect(streams.get().get(streamId)).toMatchObject(canonical);
    expect(snapshots.preload).toHaveBeenCalledTimes(2);
    expect(foregroundReader.get()).toEqual({ kind: 'workPlan', streamId });

    activeStreamId.set('another-stream');
    expect(foregroundReader.get()).toEqual({ kind: 'workPlan', streamId });
    expect(localEntries()).toEqual([]);
    closeForegroundReader();
  });

  it('waits for canonical hydration before deciding a focused plan is empty', async () => {
    const { promise: preload, resolve: resolvePreload } = deferred<void>();
    const streamId = 'historical-plan' as StreamTabId;
    registerBuiltinSlashCommands({
      workPlanSnapshots: workPlanSnapshots(
        () => ({
          plan: { objective: 'Hydrated historical objective.' },
          todos: [],
        }),
        () => preload,
      ),
    });
    patchStream(streamId, (slice) => ({ ...slice }));
    activeStreamId.set(streamId);

    const dispatched = handleTuiSlashCommand('/plan', createContext());
    expect(foregroundReader.get()).toMatchObject({
      kind: 'workPlan',
      streamId,
      loading: true,
    });
    expect(transientNotice.get()).toBeUndefined();

    resolvePreload();
    await dispatched;

    expect(streams.get().get(streamId)?.plan?.objective).toBe(
      'Hydrated historical objective.',
    );
    expect(foregroundReader.get()).toEqual({ kind: 'workPlan', streamId });
  });

  it('lets a newer plan request win when preloads resolve in reverse order', async () => {
    const streamA = 'plan-a' as StreamTabId;
    const streamB = 'plan-b' as StreamTabId;
    const resolvers = new Map<StreamTabId, () => void>();
    const snapshots = workPlanSnapshots(
      (streamId) => {
        return streamId === streamB
          ? { plan: { objective: 'Plan B.' }, todos: [] }
          : { plan: null, todos: [] };
      },
      async ([streamId]) =>
        new Promise<void>((resolve) => {
          resolvers.set(streamId, resolve);
        }),
    );
    registerBuiltinSlashCommands({ workPlanSnapshots: snapshots });
    patchStream(streamA, (slice) => ({ ...slice }));
    patchStream(streamB, (slice) => ({ ...slice }));

    activeStreamId.set(streamA);
    const requestA = handleTuiSlashCommand('/plan', createContext());
    activeStreamId.set(streamB);
    const requestB = handleTuiSlashCommand('/plan', createContext());
    expect(foregroundReader.get()).toMatchObject({
      kind: 'workPlan',
      streamId: streamB,
      loading: true,
    });

    resolvers.get(streamB)?.();
    await requestB;
    expect(foregroundReader.get()).toEqual({
      kind: 'workPlan',
      streamId: streamB,
    });
    expect(transientNotice.get()).toBeUndefined();

    resolvers.get(streamA)?.();
    await requestA;
    expect(foregroundReader.get()).toEqual({
      kind: 'workPlan',
      streamId: streamB,
    });
    expect(transientNotice.get()).toBeUndefined();
  });

  it('lets a newer no-focus request cancel pending ownership', async () => {
    const { promise: preload, resolve: resolvePreload } = deferred<void>();
    const streamId = 'superseded-loading-plan' as StreamTabId;
    registerBuiltinSlashCommands({
      workPlanSnapshots: workPlanSnapshots(
        () => ({ plan: { objective: 'Late plan.' }, todos: [] }),
        () => preload,
      ),
    });
    patchStream(streamId, (slice) => ({ ...slice }));
    activeStreamId.set(streamId);

    const first = handleTuiSlashCommand('/plan', createContext());
    activeStreamId.set(undefined);
    await handleTuiSlashCommand('/plan', createContext());
    expect(foregroundReader.get()).toBeUndefined();
    expect(transientNotice.get()?.text).toBe('No focused session.');

    resolvePreload();
    await first;
    expect(foregroundReader.get()).toBeUndefined();
    expect(transientNotice.get()?.text).toBe('No focused session.');
  });

  it('does not reopen a loading plan reader after Escape', async () => {
    const { promise: preload, resolve: resolvePreload } = deferred<void>();
    const streamId = 'escape-loading-plan' as StreamTabId;
    registerBuiltinSlashCommands({
      workPlanSnapshots: workPlanSnapshots(
        () => ({ plan: { objective: 'Late plan.' }, todos: [] }),
        () => preload,
      ),
    });
    patchStream(streamId, (slice) => ({ ...slice }));
    activeStreamId.set(streamId);

    const dispatched = handleTuiSlashCommand('/plan', createContext());
    expect(foregroundReader.get()).toMatchObject({ loading: true, streamId });
    closeForegroundReader();
    resolvePreload();
    await dispatched;

    expect(foregroundReader.get()).toBeUndefined();
    expect(transientNotice.get()).toBeUndefined();
  });

  it('closes a loading reader and reports a current preload error', async () => {
    const { promise: preload, reject: rejectPreload } = deferred<void>();
    const streamId = 'error-loading-plan' as StreamTabId;
    registerBuiltinSlashCommands({
      workPlanSnapshots: workPlanSnapshots(
        () => ({ plan: null, todos: [] }),
        () => preload,
      ),
    });
    patchStream(streamId, (slice) => ({ ...slice }));
    activeStreamId.set(streamId);

    const dispatched = handleTuiSlashCommand('/plan', createContext());
    expect(foregroundReader.get()).toMatchObject({ loading: true, streamId });
    rejectPreload(new Error('historical sidecar unreadable'));
    await dispatched;

    expect(foregroundReader.get()).toBeUndefined();
    expect(transientNotice.get()?.text).toBe(
      'Could not load workflow artifacts: historical sidecar unreadable',
    );
  });

  it('opens memory list and preview output in the reference pane', async () => {
    vi.spyOn(memoryFileSystem, 'loadMemoryItems').mockResolvedValue([]);
    vi.spyOn(memoryFileSystem, 'loadMemoryPreview').mockResolvedValue({
      storagePath: 'memory/note.md',
      lineCount: 1,
      preview: 'Remember this.',
    });

    await showCliMemoryList();
    expect(infoPane.get()).toEqual({
      title: '/memory list',
      lines: ['No memory files found.'],
    });

    await showCliMemoryPreview('note.md');
    expect(infoPane.get()?.title).toBe('/memory list');
    closeInfoPane();
    expect(infoPane.get()).toMatchObject({ title: '/memory preview' });
    expect(infoPane.get()?.lines).toContain('Remember this.');
    expect(localEntries()).toEqual([]);
  });

  it('adds a lazy command echo before errors even under echo never', async () => {
    registerSlashCommand({
      name: 'unavailable',
      description: 'Unavailable test command',
      echo: 'never',
    });

    await handleTuiSlashCommand('/unavailable', createContext());

    expect(localEntryPairs()).toEqual([
      { role: 'user', text: '/unavailable' },
      {
        role: 'assistant',
        text: '/unavailable is registered but is not available in this CLI view yet.',
      },
    ]);
  });

  it('threads deferred echo through fallback registered forms', async () => {
    registerSlashCommand({
      name: 'custom-form',
      description: 'Custom form',
      echo: 'ifPersists',
      formComponent: () => null,
    });

    await handleTuiSlashCommand('/custom-form', createContext());
    const form = activeForm.get()?.render(() => undefined, 20) as {
      props?: { onPersist?: () => void };
    };
    expect(localEntries()).toEqual([]);

    form.props?.onPersist?.();

    expect(localEntryPairs()).toEqual([{ role: 'user', text: '/custom-form' }]);
  });

  it('opens /models as the enable/disable catalog (not the active-model picker)', async () => {
    registerBuiltinSlashCommands();

    await expectFormOpens('/models', 'models');
  });

  it('opens /model as the active-model picker', async () => {
    registerBuiltinSlashCommands();

    await expectFormOpens('/model', 'model');
  });

  it('opens the login form for bare /login', async () => {
    registerBuiltinSlashCommands();

    await expectFormOpens('/login', 'login');
  });

  it('opens /approval status without an early transcript echo', async () => {
    registerBuiltinSlashCommands();

    await expectFormOpens('/approval status', 'approval');

    expect(localEntries()).toEqual([]);
  });

  it('opens the masked provider-key form through /key and /keys', async () => {
    registerBuiltinSlashCommands();
    const context = createContext();

    await expectFormOpens('/key', 'key', context);

    activeForm.set(undefined);
    await expectFormOpens('/keys', 'key', context);
  });

  it('discards inline key arguments without recording the secret', async () => {
    registerBuiltinSlashCommands();
    const secret = 'sk-private-test-value';

    await expectFormOpens(`/keys ${secret}`, 'key');

    expect(JSON.stringify(activeForm.get())).not.toContain(secret);
    expect(transientNotice.get()?.text).toContain(
      'does not accept a key as an argument',
    );
    expect(transcriptJson()).not.toContain(secret);
  });

  it('keeps malformed and mistyped key commands out of the transcript', async () => {
    registerBuiltinSlashCommands();
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
      await expectFormOpens(line, 'key', context);
      activeForm.set(undefined);
    }

    await expectFormOpens(`/ky ${typoSecret}`, 'key', context);
    const transcript = transcriptJson();
    for (const secret of [...malformedSecrets, typoSecret]) {
      expect(transcript).not.toContain(secret);
    }
  });

  it('leaves path-like equals input for the agent', async () => {
    registerBuiltinSlashCommands();

    expect(await handleTuiSlashCommand('/tmp=backup', createContext())).toBe(
      false,
    );
    expect(await handleTuiSlashCommand('/keynote.tex', createContext())).toBe(
      false,
    );
  });

  it('does not mistake ordinary key-prefixed commands for credential input', async () => {
    registerBuiltinSlashCommands();

    expect(
      await handleTuiSlashCommand('/keyboard shortcuts', createContext()),
    ).toBe(true);
    expect(activeForm.get()).toBeUndefined();
    expect(transientNotice.get()?.text).toContain(
      'Unknown command with protected input',
    );
  });

  it('redacts arbitrary concatenated key input without forcing the key form', async () => {
    registerBuiltinSlashCommands();
    const secret = 'keyArbitraryCredentialValue';

    expect(await handleTuiSlashCommand(`/${secret}`, createContext())).toBe(
      true,
    );
    expect(activeForm.get()).toBeUndefined();
    expect(transcriptJson()).not.toContain(secret);
  });

  it('routes the normalized /apikey spelling to the protected form', async () => {
    registerBuiltinSlashCommands();

    await expectFormOpens('/apikey private-value', 'key');

    expect(transcriptJson()).not.toContain('private-value');
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
    vi.spyOn(codexPreference, 'setPreferCodexSubscription').mockResolvedValue({
      effective: true,
      target: 'global',
    });

    const handled = await handleTuiSlashCommand(
      '/login chatgpt',
      createContext(),
    );

    expect(handled).toBe(true);
    expect(chatGptLogin.signInCliChatGpt).toHaveBeenCalledWith(
      expect.objectContaining({ device: true, noBrowser: false }),
      expect.any(Object),
    );
  });

  it('exposes cancellation for an interactive sign-in', async () => {
    const abort = abortRejection();
    vi.spyOn(chatGptLogin, 'signInCliChatGpt').mockImplementation(
      (_args, options) => abort.mock(options),
    );

    const completion = loginFromChat(
      'chatgpt --no-browser',
      createCliContext(),
      silentOutput(),
    );
    const rejection = expect(completion).rejects.toMatchObject({
      name: 'AbortError',
    });
    completion.abort();

    await rejection;
    expect(abort.receivedSignal()?.aborted).toBe(true);
  });

  it('derives /auth and /api status from the same access overview', async () => {
    registerBuiltinSlashCommands();
    const overview = vi
      .spyOn(apiStatus, 'loadCliDetailedAccountStatusLines')
      .mockResolvedValue([
        'ChatGPT: preferred · signed in as chatgpt@example.com',
        'Kimi Code: not preferred · key not configured',
        'Otherwise: Included access · signed in as texra@example.com · Researcher · included usage this month: 25% used, 75% remaining',
        'Other personal keys: DeepSeek',
      ]);
    const context = createContext();

    await handleTuiSlashCommand('/auth', context);
    const authStatusText = lastEntryText();
    expectAccessStatusText(authStatusText);

    await handleTuiSlashCommand('/api status', context);
    const apiStatusText = lastEntryText();
    expectAccessStatusText(apiStatusText);
    expect(apiStatusText).toBe(authStatusText);
    expect(overview).toHaveBeenCalledTimes(2);
  });

  it('preserves the current chat fallback when selecting ChatGPT', async () => {
    registerBuiltinSlashCommands();
    patchSessionMeta({ apiMode: 'personal' });
    const selection = vi
      .spyOn(modelAccessSelection, 'updateCliModelAccess')
      .mockResolvedValue({
        apiMode: 'personal',
        message: 'Model access: ChatGPT subscription.',
      });
    const session = createSession();
    session.markRunPending(new Promise(() => undefined));
    const context = createContext(session, {
      cliContext: createCliContext({ apiMode: 'included' }),
    });
    const previousPreferenceVersion = codexPreferenceVersion.get();

    await handleTuiSlashCommand('/api chatgpt', context);

    expect(selection).toHaveBeenCalledWith(
      expect.objectContaining({ apiMode: 'personal' }),
      {
        kind: 'subscription-preference',
        provider: 'chatgpt',
        state: 'on',
      },
      expect.any(Object),
    );
    expect(lastEntryText()).toBe(
      'Model access: ChatGPT subscription. · This model access setting applies to new chats. The current chat keeps its existing model connection.',
    );
    expect(codexPreferenceVersion.get()).toBe(previousPreferenceVersion + 1);
  });

  it('exposes cancellation while model access is signing in to ChatGPT', async () => {
    const abort = abortRejection();
    vi.spyOn(modelAccessSelection, 'updateCliModelAccess').mockImplementation(
      (_context, _selection, options) => {
        if (!options) throw new Error('Expected selection options');
        return abort.mock(options);
      },
    );
    const completion = applyCliModelAccessSelection(
      {
        kind: 'subscription-preference',
        provider: 'chatgpt',
        state: 'on',
      },
      createContext(),
      silentOutput(),
    );
    const rejection = expect(completion).rejects.toMatchObject({
      name: 'AbortError',
    });

    completion.abort();

    await rejection;
    expect(abort.receivedSignal()?.aborted).toBe(true);
  });

  it('clears TeXRA and ChatGPT credentials on /logout', async () => {
    registerBuiltinSlashCommands();
    const { signOutSupabase, signOutChatGpt } = mockSignOuts();

    const handled = await handleTuiSlashCommand('/logout all', createContext());

    expect(handled).toBe(true);
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt).toHaveBeenCalledOnce();
    const entry = lastEntryText();
    expect(entry).toContain(`Signed out of ${RESEARCHER_ACCESS.label}.`);
    expect(entry).toContain('Signed out of ChatGPT.');
    expect(entry).toContain('ChatGPT subscription disabled for Codex models.');
    expect(entry).not.toContain('\n');
  });

  it('opens an account-specific sign-out chooser for bare /logout', async () => {
    registerBuiltinSlashCommands();

    await expectFormOpens('/logout', 'logout');
  });

  it('signs out of only the requested account', async () => {
    registerBuiltinSlashCommands();
    const { signOutSupabase, signOutChatGpt } = mockSignOuts();
    const previousPreferenceVersion = codexPreferenceVersion.get();

    await handleTuiSlashCommand('/logout texra', createContext());
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt).not.toHaveBeenCalled();
    expect(codexPreferenceVersion.get()).toBe(previousPreferenceVersion + 1);

    await handleTuiSlashCommand('/logout chatgpt', createContext());
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt).toHaveBeenCalledOnce();
  });

  it('reports successful TeXRA sign-out when ChatGPT logout fails', async () => {
    registerBuiltinSlashCommands();
    vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockResolvedValue(undefined);
    vi.spyOn(chatGptLogin, 'signOutCliChatGpt').mockRejectedValue(
      new Error('Codex logout failed'),
    );
    mockModelAccessOverview();

    const handled = await handleTuiSlashCommand('/logout all', createContext());

    expect(handled).toBe(true);
    const entry = lastEntryText();
    expect(entry).toContain(`Signed out of ${RESEARCHER_ACCESS.label}.`);
    expect(entry).toContain('ChatGPT sign-out failed: Codex logout failed');
  });

  it('reports ChatGPT sign-out success when only preference cleanup fails', async () => {
    registerBuiltinSlashCommands();
    vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockResolvedValue(undefined);
    vi.spyOn(chatGptLogin, 'signOutCliChatGpt').mockResolvedValue({
      preferenceError: 'Config write failed',
    });
    mockModelAccessOverview();

    const handled = await handleTuiSlashCommand('/logout all', createContext());

    expect(handled).toBe(true);
    const entry = lastEntryText();
    expect(entry).toContain(`Signed out of ${RESEARCHER_ACCESS.label}.`);
    expect(entry).toContain('Signed out of ChatGPT.');
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
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.WAITING,
    });

    const handled = await handleTuiSlashCommand(
      '/status',
      createContext(session, { processCwd: '/tmp/workspace' }),
    );

    expect(handled).toBe(true);
    const statusText = lastEntryText(streamId);
    expect(statusText).toContain('resume later with: texra resume exec-1');
    expect(statusText).not.toContain('--cwd');
  });

  it('reports active children while preserving an idle focused root status', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const rootStreamId = 'stream-root' as StreamTabId;
    const childStreamId = 'stream-child' as StreamTabId;
    activeStreamId.set(rootStreamId);
    setStreamStatusInCliState({
      streamId: rootStreamId,
      status: STREAM_PHASE.WAITING,
    });
    setStreamStatusInCliState({
      streamId: childStreamId,
      status: STREAM_PHASE.RUNNING,
    });
    seedChildRoster(rootStreamId, [
      {
        executionId: 'child-exec',
        identity: { kind: 'agent', agent: 'critic' },
        agentName: 'critic',
        status: STREAM_PHASE.RUNNING,
        startedAt: 1,
        elapsed: '1s',
        childStreamId,
      },
    ]);

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootStreamId);
    expect(statusText).toContain('status: idle');
    expect(statusText).toContain('active background tasks: 1');
  });

  it('counts only running children among mixed direct-children phases', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const rootStreamId = 'stream-root' as StreamTabId;
    const parentStreamId = 'stream-parent' as StreamTabId;
    const rootSiblingIds = [
      'stream-root-sibling-1',
      'stream-root-sibling-2',
    ] as StreamTabId[];
    const runningChildId = 'stream-child-running' as StreamTabId;
    const waitingChildId = 'stream-child-waiting' as StreamTabId;
    activeStreamId.set(parentStreamId);
    for (const streamId of rootSiblingIds) {
      setStreamStatusInCliState({
        streamId,
        status: STREAM_PHASE.RUNNING,
      });
    }
    setStreamStatusInCliState({
      streamId: parentStreamId,
      status: STREAM_PHASE.WAITING,
    });
    setStreamStatusInCliState({
      streamId: runningChildId,
      status: STREAM_PHASE.RUNNING,
    });
    setStreamStatusInCliState({
      streamId: waitingChildId,
      status: STREAM_PHASE.WAITING,
    });
    const rosterRow = (
      childStreamId: StreamTabId,
      index: number,
      status: StreamPhase,
    ) => ({
      executionId: `child-exec-${index}`,
      identity: { kind: 'agent' as const, agent: `critic-${index}` },
      agentName: `critic-${index}`,
      status,
      startedAt: index + 1,
      elapsed: '1s',
      childStreamId,
    });
    seedChildRoster(rootStreamId, [
      rosterRow(parentStreamId, 0, STREAM_PHASE.WAITING),
      ...rootSiblingIds.map((streamId, index) =>
        rosterRow(streamId, index + 1, STREAM_PHASE.RUNNING),
      ),
    ]);
    seedChildRoster(parentStreamId, [
      rosterRow(runningChildId, 3, STREAM_PHASE.RUNNING),
      rosterRow(waitingChildId, 4, STREAM_PHASE.WAITING),
    ]);

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootStreamId);
    expect(statusText).toContain('active background tasks: 1');
    expect(statusText).not.toContain('active background tasks: 2');
  });

  it('does not count retained idle children as active background tasks', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const rootStreamId = 'stream-root' as StreamTabId;
    const childStreamIds = [
      'stream-child-1',
      'stream-child-2',
    ] as StreamTabId[];
    activeStreamId.set(rootStreamId);
    setStreamStatusInCliState({
      streamId: rootStreamId,
      status: STREAM_PHASE.WAITING,
    });
    for (const [index, childStreamId] of childStreamIds.entries()) {
      setStreamStatusInCliState({
        streamId: childStreamId,
        status: index === 0 ? STREAM_PHASE.WAITING : STREAM_PHASE.COMPLETED,
      });
    }
    seedChildRoster(
      rootStreamId,
      childStreamIds.map((childStreamId, index) => ({
        executionId: `child-exec-${index}`,
        identity: { kind: 'agent' as const, agent: `critic-${index}` },
        agentName: `critic-${index}`,
        status: index === 0 ? STREAM_PHASE.WAITING : STREAM_PHASE.COMPLETED,
        startedAt: index + 1,
        elapsed: '1s',
        childStreamId,
      })),
    );

    await handleTuiSlashCommand('/status', createContext(session));

    expect(lastEntryText(rootStreamId)).not.toContain(
      'active background tasks:',
    );
  });

  it('reports the owning workflow count while a background task is focused', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const rootStreamId = 'stream-root' as StreamTabId;
    const focusedChildId = 'stream-focused-child' as StreamTabId;
    const siblingChildId = 'stream-sibling-child' as StreamTabId;
    activeStreamId.set(focusedChildId);
    for (const streamId of [focusedChildId, siblingChildId]) {
      setStreamStatusInCliState({
        streamId,
        status: STREAM_PHASE.RUNNING,
      });
    }
    seedChildRoster(
      rootStreamId,
      [focusedChildId, siblingChildId].map((childStreamId, index) => ({
        executionId: `child-exec-${index}`,
        identity: { kind: 'agent' as const, agent: `critic-${index}` },
        agentName: `critic-${index}`,
        status: STREAM_PHASE.RUNNING,
        startedAt: index + 1,
        elapsed: '1s',
        childStreamId,
      })),
    );

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootStreamId);
    expect(statusText).toContain('status: running');
    expect(statusText).toContain('active background tasks: 2');
  });

  it('filters idle siblings from the owning workflow count', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const rootStreamId = 'stream-root' as StreamTabId;
    const focusedChildId = 'stream-focused-child' as StreamTabId;
    const runningSiblingId = 'stream-running-sibling' as StreamTabId;
    const idleSiblingId = 'stream-idle-sibling' as StreamTabId;
    activeStreamId.set(focusedChildId);
    setStreamStatusInCliState({
      streamId: focusedChildId,
      status: STREAM_PHASE.WAITING,
    });
    setStreamStatusInCliState({
      streamId: runningSiblingId,
      status: STREAM_PHASE.RUNNING,
    });
    setStreamStatusInCliState({
      streamId: idleSiblingId,
      status: STREAM_PHASE.WAITING,
    });
    seedChildRoster(
      rootStreamId,
      [focusedChildId, runningSiblingId, idleSiblingId].map(
        (childStreamId, index) => ({
          executionId: `child-exec-${index}`,
          identity: { kind: 'agent' as const, agent: `critic-${index}` },
          agentName: `critic-${index}`,
          status:
            childStreamId === runningSiblingId
              ? STREAM_PHASE.RUNNING
              : STREAM_PHASE.WAITING,
          startedAt: index + 1,
          elapsed: '1s',
          childStreamId,
        }),
      ),
    );

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootStreamId);
    expect(statusText).toContain('active background tasks: 1');
    expect(statusText).not.toContain('active background tasks: 3');
  });

  it('counts delegated work owned by a focused intermediate parent', async () => {
    registerBuiltinSlashCommands();
    const session = createSession();
    const rootStreamId = 'stream-root' as StreamTabId;
    const parentStreamId = 'stream-parent' as StreamTabId;
    const rootSiblingIds = [
      'stream-root-sibling-1',
      'stream-root-sibling-2',
    ] as StreamTabId[];
    const grandchildId = 'stream-grandchild' as StreamTabId;
    activeStreamId.set(parentStreamId);
    for (const streamId of [parentStreamId, ...rootSiblingIds, grandchildId]) {
      setStreamStatusInCliState({
        streamId,
        status: STREAM_PHASE.RUNNING,
      });
    }
    const rosterRow = (childStreamId: StreamTabId, index: number) => ({
      executionId: `nested-exec-${index}`,
      identity: { kind: 'agent' as const, agent: `reviewer-${index}` },
      agentName: `reviewer-${index}`,
      status: STREAM_PHASE.RUNNING,
      startedAt: index + 1,
      elapsed: '1s',
      childStreamId,
    });
    seedChildRoster(
      rootStreamId,
      [parentStreamId, ...rootSiblingIds].map(rosterRow),
    );
    seedChildRoster(parentStreamId, [rosterRow(grandchildId, 3)]);

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootStreamId);
    expect(statusText).toContain('active background tasks: 1');
    expect(statusText).not.toContain('active background tasks: 3');
  });

  it('reports the access route that produced the focused stream usage', async () => {
    registerBuiltinSlashCommands();
    const overview = vi.spyOn(apiStatus, 'loadCliModelAccessOverview');
    const session = createSession();
    const streamId = 'stream-access' as StreamTabId;
    activeStreamId.set(streamId);
    patchSessionMeta({ apiMode: 'personal', model: 'gpt55' });
    patchStream(streamId, (slice) => ({
      ...slice,
      model: 'gpt55',
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cost: 0,
        usageRoute: 'relay',
      },
    }));
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.WAITING,
    });

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(streamId);
    expect(statusText).toContain('model access: Included access');
    expect(statusText).not.toContain('model access: ChatGPT subscription');
    expect(overview).not.toHaveBeenCalled();
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
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.WAITING,
    });

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(streamId);
    expect(statusText).not.toContain('session: exec-ephemeral');
    expect(statusText).not.toContain('resume later with:');
  });
});
