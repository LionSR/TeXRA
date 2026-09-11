// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { Effect } from 'effect';

// Slash command run dispatch.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';

import { defaultSession } from '@agent/runtime/SessionHandle';
import { handleTuiSlashCommand } from '@cli/chat/tui/commands/handleSlashCommand';
import {
  applyCliModelAccessSelection,
  applyCliProviderApiKey,
} from '@cli/chat/tui/commands/handlers/modelAccessCommands';
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
import { transcriptRowHeadline } from '@cli/chat/tui/panes/transcriptEntries';
import {
  CLI_LOCAL_RUN_ID,
  notices,
  noticesFor,
} from '@cli/chat/tui/state/transcript';
import {
  activeForm,
  activeRunId,
  closeForegroundReader,
  closeInfoPane,
  foregroundReader,
  infoPane,
  patchSessionMeta,
  resetCliState,
  transientNotice,
} from '@cli/chat/tui/state/cliState';
import * as apiStatus from '@cli/runtime/apiStatus';
import * as subscriptionLogin from '@cli/runtime/subscriptionLogin';
import type { CliContext } from '@cli/runtime/cliContext';
import * as modelAccessSelection from '@cli/runtime/modelAccessSelection';
import * as providerApiKey from '@cli/runtime/providerApiKey';
import * as supabaseAuth from '@cli/runtime/supabaseAuth';
import { TuiSession } from '@cli/chat/tui/state/sessionRunState';
import * as codexPreference from '@model/codex/codexPreference';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  AgentCategory,
  RUN_PHASE,
  type ActiveChildInfo,
  type RunId,
  type Plan,
  type RunPhase,
  type TodoItem,
} from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import { RESEARCHER_ACCESS_AUTH } from '@shared/copy/accountAuth';
import type { RunView } from '@shared/session/sessionView';
import { createTestCliContext } from '@test/cli/fixtures/cliContext';
import { FakeSecrets, FakeStateStore } from '@test/support/FakePlatform';
import * as memoryFileSystem from '@tools/memory/memoryFileSystem';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

// The runs a case names live in the fold's view: /status reads child
// counts, parent edges, and each stream's phase from there.
const seeded = new Map<RunId, RunView>();
function syncSeededView(): void {
  seedView(viewWith([...seeded.values()]));
}
function ensureRun(
  id: RunId,
  over: Partial<Omit<RunView, 'category'>> = {},
): void {
  const current = seeded.get(id);
  seeded.set(id, makeRunView({ ...(current ?? {}), ...over, id }) as RunView);
  syncSeededView();
}
beforeAll(bindTestSessionView);
// `/plan` reads the focused run off the session's own fold, `/status` off the
// TUI's projection of it; one seeded map answers both.
beforeEach(() => {
  vi.spyOn(defaultSession(), 'runView').mockImplementation((id) =>
    seeded.get(id),
  );
});
afterEach(() => {
  for (const cmd of [...listSlashCommands()]) unregisterSlashCommand(cmd.name);
  seeded.clear();
  syncSeededView();
  resetCliState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
/** The focused run's work plan as the fold states it. */
function seedWorkPlan(
  runId: RunId,
  plan: Plan | null,
  todos: readonly TodoItem[],
): void {
  ensureRun(runId);
  seeded.set(runId, {
    ...makeRunView({ id: runId }),
    plan,
    todos: [...todos],
  } as RunView);
  syncSeededView();
}
function seedChildRoster(
  parentRunId: RunId,
  rows: readonly ActiveChildInfo[],
): void {
  ensureRun(parentRunId);
  const parent = seeded.get(parentRunId);
  for (const row of rows) {
    ensureRun(row.childRunId, {
      parentId: parentRunId,
      ancestors: [
        ...(parent?.ancestors ?? []),
        { id: parentRunId, label: parentRunId },
      ],
      label: row.agentName,
      identity: row.identity,
      status: row.status ?? RUN_PHASE.COMPLETED,
    });
  }
}
/**
 * The process stores the built-in commands and the slash context read, the
 * pair the chat entry point threads in from its own platform services.
 */
const stores = { secrets: new FakeSecrets(), state: new FakeStateStore() };

function createSession(): TuiSession {
  return new TuiSession();
}

function mockModelAccessOverview(): void {
  vi.spyOn(apiStatus, 'loadCliModelAccessOverview').mockResolvedValue({
    access: {
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
      texraSignedIn: false,
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
    secrets: stores.secrets,
    state: stores.state,
    processCwd: '/tmp/launcher',
    initialAgent: 'chat',
    initialModel: 'deepseekT',
    requestInputExit: vi.fn(),
    getApprovalPolicy: () => approvalPolicy,
    setApprovalPolicy: (policy) => {
      approvalPolicy = policy;
    },
    canSelectModel: () => true,
    resetSession: vi.fn(),
    resumeRun: (_id: RunId) => Promise.resolve(),
    ...overrides,
  };
}

function lastEntryText(runId: RunId = CLI_LOCAL_RUN_ID): string | undefined {
  const last = noticesFor(notices.get(), runId).at(-1)?.row;
  return last && transcriptRowHeadline(last);
}

function localEntries(): readonly TranscriptRow[] {
  return noticesFor(notices.get(), CLI_LOCAL_RUN_ID).map(({ row }) => row);
}

function localEntryPairs(): Array<{ kind: string; text: string }> {
  return localEntries().map((row) => ({
    kind: row.kind,
    text: transcriptRowHeadline(row),
  }));
}

function transcriptJson(): string {
  return JSON.stringify(notices.get());
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

function mockSignOuts(): {
  signOutSupabase: MockInstance<typeof supabaseAuth.signOutCliSupabase>;
  signOutChatGpt: MockInstance<typeof subscriptionLogin.signOutCliSubscription>;
} {
  const signOutSupabase = vi
    .spyOn(supabaseAuth, 'signOutCliSupabase')
    .mockResolvedValue(undefined);
  const signOutChatGpt = vi
    .spyOn(subscriptionLogin, 'signOutCliSubscription')
    .mockReturnValue(
      Effect.succeed({
        preferenceUpdate: { effective: false, target: 'global' as const },
      }),
    );
  mockModelAccessOverview();
  return { signOutSupabase, signOutChatGpt };
}

function expectAccessStatusText(text: string | undefined): void {
  expect(text).toContain('ChatGPT: preferred');
  expect(text).toContain('Kimi Code: not preferred');
  expect(text).toContain('Otherwise: Your own API keys');
  expect(text).toContain('Other API keys: DeepSeek');
}

describe('handleTuiSlashCommand', () => {
  it('opens reference commands without leaving transcript rows', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const context = createContext();

    await handleTuiSlashCommand('/tools', context);
    expect(localEntries()).toEqual([]);

    await handleTuiSlashCommand('/help', context);
    expect(infoPane.get()).toMatchObject({ title: '/help' });
    expect(infoPane.get()?.lines.join('\n')).toContain('**Keyboard**');
    expect(localEntries()).toEqual([]);

    closeInfoPane();
    await handleTuiSlashCommand('/goal', context);
    expect(activeForm.get()).toMatchObject({ commandName: 'goal' });
    expect(localEntries()).toEqual([]);
  });

  it('opens a live work-plan reader for the focused stream', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const context = createContext();

    await handleTuiSlashCommand('/plan', context);
    expect(transientNotice.get()?.text).toBe('No focused session.');

    const runId = 'plan-reader' as RunId;
    ensureRun(runId);
    activeRunId.set(runId);
    await handleTuiSlashCommand('/plan', context);
    expect(transientNotice.get()?.text).toBe(
      'The focused session has no work plan.',
    );

    seedWorkPlan(runId, { objective: 'Check every case.' }, [
      {
        content: 'Check the base case',
        activeForm: 'Checking the base case',
        status: 'in_progress',
      },
    ]);
    await handleTuiSlashCommand('/plan', context);
    expect(foregroundReader.get()).toEqual({ kind: 'workPlan', runId });

    activeRunId.set('another-stream' as RunId);
    expect(foregroundReader.get()).toEqual({ kind: 'workPlan', runId });
    expect(localEntries()).toEqual([]);
    closeForegroundReader();
  });

  it('opens memory list and preview output in the reference pane', async () => {
    vi.spyOn(memoryFileSystem, 'loadMemoryItems').mockReturnValue(
      Effect.succeed([]),
    );
    vi.spyOn(memoryFileSystem, 'loadMemoryPreview').mockReturnValue(
      Effect.succeed({
        storagePath: 'memory/note.md',
        lineCount: 1,
        preview: 'Remember this.',
      }),
    );

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
      { kind: 'user', text: '/unavailable' },
      {
        kind: 'assistant',
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

    expect(localEntryPairs()).toEqual([{ kind: 'user', text: '/custom-form' }]);
  });

  it('opens /models as the enable/disable catalog (not the active-model picker)', async () => {
    registerBuiltinSlashCommands({ ...stores });

    await expectFormOpens('/models', 'models');
  });

  it('opens /model as the active-model picker', async () => {
    registerBuiltinSlashCommands({ ...stores });

    await expectFormOpens('/model', 'model');
  });

  it('opens /approval status without an early transcript echo', async () => {
    registerBuiltinSlashCommands({ ...stores });

    await expectFormOpens('/approval status', 'approval');

    expect(localEntries()).toEqual([]);
  });

  it('opens the masked provider-key form through /key and /keys', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const context = createContext();

    await expectFormOpens('/key', 'key', context);

    activeForm.set(undefined);
    await expectFormOpens('/keys', 'key', context);
  });

  it('discards inline key arguments without recording the secret', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const secret = 'sk-private-test-value';

    await expectFormOpens(`/keys ${secret}`, 'key');

    expect(JSON.stringify(activeForm.get())).not.toContain(secret);
    expect(transientNotice.get()?.text).toContain(
      'does not accept a key as an argument',
    );
    expect(transcriptJson()).not.toContain(secret);
  });

  it('keeps malformed and mistyped key commands out of the transcript', async () => {
    registerBuiltinSlashCommands({ ...stores });
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
    registerBuiltinSlashCommands({ ...stores });

    expect(await handleTuiSlashCommand('/tmp=backup', createContext())).toBe(
      false,
    );
    expect(await handleTuiSlashCommand('/keynote.tex', createContext())).toBe(
      false,
    );
  });

  it('does not mistake ordinary key-prefixed commands for credential input', async () => {
    registerBuiltinSlashCommands({ ...stores });

    expect(
      await handleTuiSlashCommand('/keyboard shortcuts', createContext()),
    ).toBe(true);
    expect(activeForm.get()).toBeUndefined();
    expect(transientNotice.get()?.text).toContain(
      'Unknown command with protected input',
    );
  });

  it('redacts arbitrary concatenated key input without forcing the key form', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const secret = 'keyArbitraryCredentialValue';

    expect(await handleTuiSlashCommand(`/${secret}`, createContext())).toBe(
      true,
    );
    expect(activeForm.get()).toBeUndefined();
    expect(transcriptJson()).not.toContain(secret);
  });

  it('routes the normalized /apikey spelling to the protected form', async () => {
    registerBuiltinSlashCommands({ ...stores });

    await expectFormOpens('/apikey private-value', 'key');

    expect(transcriptJson()).not.toContain('private-value');
  });

  it('uses ChatGPT device-code login from a likely remote shell', async () => {
    registerBuiltinSlashCommands({ ...stores });
    vi.stubEnv('SSH_TTY', '/dev/pts/3');
    vi.spyOn(subscriptionLogin, 'signInCliSubscription').mockReturnValue(
      Effect.succeed({
        signedIn: true,
        email: 'person@example.com',
        label: 'person@example.com',
      }),
    );
    vi.spyOn(codexPreference, 'setPreferCodexSubscription').mockResolvedValue({
      effective: true,
      target: 'global',
    });

    const handled = await handleTuiSlashCommand(
      '/login chatgpt',
      createContext(),
    );

    expect(handled).toBe(true);
    expect(subscriptionLogin.signInCliSubscription).toHaveBeenCalledWith(
      'chatgpt',
      expect.objectContaining({ device: true, noBrowser: false }),
      expect.any(Object),
    );
  });

  it('exposes cancellation for an interactive sign-in', async () => {
    const signIn = interruptibleProgram();
    vi.spyOn(subscriptionLogin, 'signInCliSubscription').mockReturnValue(
      signIn.program,
    );

    const completion = loginFromChat(
      'chatgpt --no-browser',
      createCliContext(),
      silentOutput(),
    );
    const rejection = expect(completion).rejects.toThrow(/interrupted/);
    completion.abort();

    await rejection;
    expect(signIn.interrupted()).toBe(true);
  });

  it('derives /auth and /api status from the same access overview', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const overview = vi
      .spyOn(apiStatus, 'loadCliDetailedAccountStatusLines')
      .mockResolvedValue([
        'ChatGPT: preferred · signed in as chatgpt@example.com',
        'Kimi Code: not preferred · key not configured',
        'Otherwise: Your own API keys',
        'Other API keys: DeepSeek',
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

  it('explains the shared GLM key routes after saving it', async () => {
    const save = vi
      .spyOn(providerApiKey, 'saveProviderApiKey')
      .mockResolvedValue(undefined);

    const notice = await applyCliProviderApiKey(
      stores.secrets,
      'glm',
      'glm-secret',
    );

    expect(save).toHaveBeenCalledWith(stores.secrets, 'glm', 'glm-secret');
    expect(notice).toBe(
      "Tip: the regular GLM endpoint is the default; enable 'Prefer GLM Coding Plan' with `/api glm-code` or in `/config` to use GLM Coding Plan.",
    );
  });

  it('exposes cancellation while model access is signing in to ChatGPT', async () => {
    const update = interruptibleProgram();
    vi.spyOn(modelAccessSelection, 'updateCliModelAccess').mockReturnValue(
      update.program,
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
    const rejection = expect(completion).rejects.toThrow(/interrupted/);

    completion.abort();

    await rejection;
    expect(update.interrupted()).toBe(true);
  });

  it('clears TeXRA and ChatGPT credentials on /logout', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const { signOutSupabase, signOutChatGpt } = mockSignOuts();

    const handled = await handleTuiSlashCommand('/logout all', createContext());

    expect(handled).toBe(true);
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt.mock.calls).toEqual([['chatgpt'], ['grok']]);
    const entry = lastEntryText();
    expect(entry).toContain(RESEARCHER_ACCESS_AUTH.signedOut);
    expect(entry).toContain('Signed out of ChatGPT.');
    expect(entry).toContain('ChatGPT subscription disabled for Codex models.');
    expect(entry).not.toContain('\n');
  });

  it('opens an account-specific sign-out chooser for bare /logout', async () => {
    registerBuiltinSlashCommands({ ...stores });

    await expectFormOpens('/logout', 'logout');
  });

  it('signs out of only the requested account', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const { signOutSupabase, signOutChatGpt } = mockSignOuts();

    await handleTuiSlashCommand('/logout texra', createContext());
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt).not.toHaveBeenCalled();

    await handleTuiSlashCommand('/logout chatgpt', createContext());
    expect(signOutSupabase).toHaveBeenCalledOnce();
    expect(signOutChatGpt).toHaveBeenCalledOnce();
  });

  it('reports successful TeXRA sign-out when ChatGPT logout fails', async () => {
    registerBuiltinSlashCommands({ ...stores });
    vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockResolvedValue(undefined);
    vi.spyOn(subscriptionLogin, 'signOutCliSubscription').mockReturnValue(
      Effect.fail(new Error('Codex logout failed')),
    );
    mockModelAccessOverview();

    const handled = await handleTuiSlashCommand('/logout all', createContext());

    expect(handled).toBe(true);
    const entry = lastEntryText();
    expect(entry).toContain(RESEARCHER_ACCESS_AUTH.signedOut);
    expect(entry).toContain('ChatGPT sign-out failed: Codex logout failed');
  });

  it('reports ChatGPT sign-out success when only preference cleanup fails', async () => {
    registerBuiltinSlashCommands({ ...stores });
    vi.spyOn(supabaseAuth, 'signOutCliSupabase').mockResolvedValue(undefined);
    vi.spyOn(subscriptionLogin, 'signOutCliSubscription').mockReturnValue(
      Effect.succeed({ preferenceError: 'Config write failed' }),
    );
    mockModelAccessOverview();

    const handled = await handleTuiSlashCommand('/logout all', createContext());

    expect(handled).toBe(true);
    const entry = lastEntryText();
    expect(entry).toContain(RESEARCHER_ACCESS_AUTH.signedOut);
    expect(entry).toContain('Signed out of ChatGPT.');
    expect(entry).toContain(
      'ChatGPT subscription preference could not be disabled: Config write failed',
    );
    expect(entry).not.toContain('ChatGPT sign-out failed');
  });

  it('treats /quit as the canonical exit command without echoing it', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const session = createSession();
    const requestInputExit = vi.fn();

    const handled = await handleTuiSlashCommand(
      '/quit',
      createContext(session, { requestInputExit }),
    );

    expect(handled).toBe(true);
    // `stopRequested` is set here and nowhere else on this path: the graceful
    // teardown's `followUpQueue.onIdle()` await depends on it. The interrupt
    // is deliberately NOT raised — the teardown owns that policy.
    expect(session.stopRequested).toBe(true);
    expect(requestInputExit).toHaveBeenCalledOnce();
    expect(activeRunId.get()).toBeUndefined();
  });

  it('uses the provided process cwd when formatting /status resume hints', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const session = createSession();
    const runId = 'stream-1' as RunId;
    session.runId = runId;
    session.runId = 'exec-1' as RunId;
    activeRunId.set(runId);
    ensureRun(runId, { status: RUN_PHASE.WAITING });

    const handled = await handleTuiSlashCommand(
      '/status',
      createContext(session, { processCwd: '/tmp/workspace' }),
    );

    expect(handled).toBe(true);
    const statusText = lastEntryText(runId);
    expect(statusText).toContain('resume later with: texra resume exec-1');
    expect(statusText).not.toContain('--cwd');
  });

  it('reports active children while preserving an idle focused root status', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const session = createSession();
    const rootRunId = 'stream-root' as RunId;
    const childRunId = 'stream-child' as RunId;
    activeRunId.set(rootRunId);
    ensureRun(rootRunId, { status: RUN_PHASE.WAITING });
    ensureRun(childRunId, { status: RUN_PHASE.RUNNING });
    seedChildRoster(rootRunId, [
      {
        identity: { kind: 'agent', agent: 'critic' },
        agentName: 'critic',
        status: RUN_PHASE.RUNNING,
        startedAt: 1,
        childRunId,
      },
    ]);

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootRunId);
    expect(statusText).toContain('status: Idle');
    expect(statusText).toContain('active background tasks: 1');
  });

  it('counts only running children among mixed direct-children phases', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const session = createSession();
    const rootRunId = 'stream-root' as RunId;
    const parentRunId = 'stream-parent' as RunId;
    const rootSiblingIds = [
      'stream-root-sibling-1',
      'stream-root-sibling-2',
    ] as RunId[];
    const runningChildId = 'stream-child-running' as RunId;
    const waitingChildId = 'stream-child-waiting' as RunId;
    activeRunId.set(parentRunId);
    for (const runId of rootSiblingIds) {
      ensureRun(runId, { status: RUN_PHASE.RUNNING });
    }
    ensureRun(parentRunId, { status: RUN_PHASE.WAITING });
    ensureRun(runningChildId, { status: RUN_PHASE.RUNNING });
    ensureRun(waitingChildId, { status: RUN_PHASE.WAITING });
    const rosterRow = (childRunId: RunId, index: number, status: RunPhase) => ({
      identity: { kind: 'agent' as const, agent: `critic-${index}` },
      agentName: `critic-${index}`,
      status,
      startedAt: index + 1,
      childRunId,
    });
    seedChildRoster(rootRunId, [
      rosterRow(parentRunId, 0, RUN_PHASE.WAITING),
      ...rootSiblingIds.map((runId, index) =>
        rosterRow(runId, index + 1, RUN_PHASE.RUNNING),
      ),
    ]);
    seedChildRoster(parentRunId, [
      rosterRow(runningChildId, 3, RUN_PHASE.RUNNING),
      rosterRow(waitingChildId, 4, RUN_PHASE.WAITING),
    ]);

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootRunId);
    expect(statusText).toContain('active background tasks: 1');
    expect(statusText).not.toContain('active background tasks: 2');
  });

  it('does not count retained idle children as active background tasks', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const session = createSession();
    const rootRunId = 'stream-root' as RunId;
    const childRunIds = ['stream-child-1', 'stream-child-2'] as RunId[];
    activeRunId.set(rootRunId);
    ensureRun(rootRunId, { status: RUN_PHASE.WAITING });
    for (const [index, childRunId] of childRunIds.entries()) {
      ensureRun(childRunId, {
        status: index === 0 ? RUN_PHASE.WAITING : RUN_PHASE.COMPLETED,
      });
    }
    seedChildRoster(
      rootRunId,
      childRunIds.map((childRunId, index) => ({
        identity: { kind: 'agent' as const, agent: `critic-${index}` },
        agentName: `critic-${index}`,
        status: index === 0 ? RUN_PHASE.WAITING : RUN_PHASE.COMPLETED,
        startedAt: index + 1,
        childRunId,
      })),
    );

    await handleTuiSlashCommand('/status', createContext(session));

    expect(lastEntryText(rootRunId)).not.toContain('active background tasks:');
  });

  it('reports the owning workflow count while a background task is focused', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const session = createSession();
    const rootRunId = 'stream-root' as RunId;
    const focusedChildId = 'stream-focused-child' as RunId;
    const siblingChildId = 'stream-sibling-child' as RunId;
    activeRunId.set(focusedChildId);
    for (const runId of [focusedChildId, siblingChildId]) {
      ensureRun(runId, { status: RUN_PHASE.RUNNING });
    }
    seedChildRoster(
      rootRunId,
      [focusedChildId, siblingChildId].map((childRunId, index) => ({
        identity: { kind: 'agent' as const, agent: `critic-${index}` },
        agentName: `critic-${index}`,
        status: RUN_PHASE.RUNNING,
        startedAt: index + 1,
        childRunId,
      })),
    );

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(rootRunId);
    expect(statusText).toContain('status: Running');
    expect(statusText).toContain('active background tasks: 2');
  });

  it('reports the access route that produced the focused stream usage', async () => {
    registerBuiltinSlashCommands({ ...stores });
    const overview = vi.spyOn(apiStatus, 'loadCliModelAccessOverview');
    const session = createSession();
    const runId = 'stream-access' as RunId;
    activeRunId.set(runId);
    patchSessionMeta({ model: 'gpt55' });
    // The access route comes off the fold's cumulative usage for the stream.
    ensureRun(runId, {
      status: RUN_PHASE.WAITING,
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cost: 0,
        usageRoute: 'api-key',
      },
    });

    await handleTuiSlashCommand('/status', createContext(session));

    const statusText = lastEntryText(runId);
    expect(statusText).toContain('model access: Your own API keys');
    expect(statusText).not.toContain('model access: ChatGPT subscription');
    expect(overview).not.toHaveBeenCalled();
  });

  it('surfaces status lookup failures without rejecting', async () => {
    registerBuiltinSlashCommands({ ...stores });

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
});
