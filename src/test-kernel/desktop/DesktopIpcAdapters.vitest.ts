// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  SETTINGS_VIEW_COMMANDS,
} from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createModuleMocks } from '@test/support/moduleMocks';

// Local imports - test support
import { loadSourceModule } from './loadSourceModule.ts';

const mocks = createModuleMocks();

type DesktopShellIpcModule = typeof import('@desktop/main/desktopShellIpc');
type DesktopShellActionFactoryOptions = Parameters<
  DesktopShellIpcModule['createDesktopShellActions']
>[1];
type DesktopOnboardingMainModule =
  typeof import('@desktop/main/desktopOnboardingIpc');
type DesktopOnboardingOptions = NonNullable<
  Parameters<DesktopOnboardingMainModule['createDesktopOnboardingIpc']>[1]
>;
type OnboardingHarnessOptions = Partial<
  Omit<DesktopOnboardingOptions, 'state'>
> & {
  seed?: Readonly<Record<string, unknown>>;
};

// The WEBVIEW_READY / run-setup handlers trigger refreshOnboardingFunnel as a
// fire-and-forget task whose chain (credential probe → selectSetupAgent →
// guarded kickoffSetup → re-derive) is several awaits deep.
// Drain via macrotask boundaries rather than counting microtask hops: each
// setTimeout(0) lets the entire pending microtask queue — and any
// setTimeout(0)-scheduled credential probe — settle, so this stays correct if
// the chain depth changes.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// Drain a promise and its .then() continuation (two microtask hops).
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function createShellHarness(
  overrides: Partial<DesktopShellActionFactoryOptions> = {},
) {
  const { createDesktopShellActions, createDesktopShellIpc } =
    await loadSourceModule('@desktop/main/desktopShellIpc');
  const postToRenderer = vi.fn();
  const actions = createDesktopShellActions(
    { postToRenderer },
    {
      getCustomAgentDirectory: async () => '/agents/custom',
      openExternalUrl: vi.fn(async () => {}),
      openLogFolder: vi.fn(async () => {}),
      openPath: vi.fn(async () => {}),
      openWorkspaceFolder: vi.fn(async () => {}),
      signIn: vi.fn(async () => {}),
      getRecentCommits: async () => ({ commits: [], isGitRepo: false }),
      showInfoMessage: vi.fn(),
      ...overrides,
    },
  );
  return {
    actions,
    postToRenderer,
    shellIpc: createDesktopShellIpc(actions),
  };
}

// Own the repeated onboarding boundary setup so each test declares only its
// initial state and host callbacks. `update` is spied so tests can assert
// persisted keys; `state` is the store the adapter reads and writes.
async function createOnboardingHarness({
  seed = {},
  ...options
}: OnboardingHarnessOptions = {}) {
  const [
    { createDesktopOnboardingIpc },
    { DESKTOP_ONBOARDING_DISMISSED_STATE_KEY },
  ] = await Promise.all([
    loadSourceModule('@desktop/main/desktopOnboardingIpc'),
    loadSourceModule('@desktop/shared/desktopOnboardingMessages'),
  ]);
  const state = new FakeStateStore({ ...seed });
  const update = vi.spyOn(state, 'update');
  const postToRenderer = vi.fn();
  const onboarding = createDesktopOnboardingIpc(
    { postToRenderer },
    {
      hasCredential: () => false,
      selectSetupAgent: async () => {},
      kickoffSetup: async () => {},
      signInWithChatGpt: async () => {},
      openGettingStarted: async () => {},
      ...options,
      state,
    },
  );
  return {
    state,
    update,
    onboarding,
    postToRenderer,
    dismissedStateKey: DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
  };
}

function expectLastFunnelState(
  postToRenderer: ReturnType<typeof vi.fn>,
  state: 'needs-credential' | 'setup' | 'done',
): void {
  expect(postToRenderer).toHaveBeenLastCalledWith({
    command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
    state,
  });
}

describe('desktop IPC adapters', () => {
  it('keeps theme and debug state in the view-state adapter', async () => {
    let themeListener: (() => void) | undefined;
    const nativeTheme = {
      shouldUseDarkColors: true,
      shouldUseHighContrastColors: false,
      on: vi.fn((_event: 'updated', listener: () => void) => {
        themeListener = listener;
      }),
      off: vi.fn(),
    };
    vi.resetModules();
    mocks.doMock('electron', () => ({ nativeTheme }));
    const { createDesktopViewStateIpc } = await loadSourceModule(
      '@desktop/main/desktopViewStateIpc',
    );
    const postToRenderer = vi.fn();
    const stateIpc = createDesktopViewStateIpc(
      { postToRenderer },
      { debugMode: true },
    );

    // WEBVIEW_READY is a broadcast every webview posts on mount; only the
    // main webview's readiness should sync theme/debug-mode here.
    expect(
      stateIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'progress',
      }),
    ).toBe(false);
    expect(postToRenderer).not.toHaveBeenCalled();

    expect(
      stateIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    expect(postToRenderer).toHaveBeenCalledWith({
      command: COMMON_COMMANDS.THEME_SET,
      theme: 'dark',
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: COMMON_COMMANDS.DEBUG_MODE_SET,
      debugMode: true,
    });

    nativeTheme.shouldUseHighContrastColors = true;
    themeListener?.();
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: COMMON_COMMANDS.THEME_SET,
      theme: 'high-contrast',
    });

    stateIpc.dispose();
    expect(nativeTheme.off).toHaveBeenCalledWith('updated', themeListener);
  });

  it('keeps shell routing and launcher actions in the shell adapter', async () => {
    const openPath = vi.fn(async (_filePath: string) => {});
    const { postToRenderer, shellIpc } = await createShellHarness({ openPath });

    shellIpc.handleMessage({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'main',
    });
    shellIpc.handleMessage({ command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS });
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      sessionType: AgentCategory.ToolUse,
    });
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
    });
    await flushMicrotasks();

    expect(postToRenderer).toHaveBeenNthCalledWith(1, {
      command: 'desktop:showLauncher',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(2, {
      command: 'desktop:openWorkbench',
      kind: 'settings',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(3, {
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.MODELS,
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(4, {
      command: 'desktop:openWorkbench',
      kind: 'settings',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(5, {
      agentSubTab: AgentCategory.ToolUse,
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.AGENTS,
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(6, {
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits: [],
      isGitRepo: false,
    });

    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });
    await flushMicrotasks();
    expect(openPath).toHaveBeenCalledWith('/agents/custom');

    postToRenderer.mockClear();
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: false,
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: 'desktop:openWorkbench',
      kind: 'settings',
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.AGENTS,
    });
  });

  it('forwards native layout commands to the renderer', async () => {
    const { actions, postToRenderer } = await createShellHarness();

    actions.toggleSummaryBar?.();
    actions.toggleBottomBar?.();
    actions.toggleSidePanel?.();

    expect(postToRenderer.mock.calls.map(([message]) => message)).toEqual([
      { command: 'desktop:toggleLayout', panel: 'summaryBar' },
      { command: 'desktop:toggleLayout', panel: 'bottomBar' },
      { command: 'desktop:toggleLayout', panel: 'sidePanel' },
    ]);
  });

  it('forwards real recent commits when a git host is wired', async () => {
    // `getRecentCommits` is a first-class shell option, so the launcher
    // banner shows the host's actual `git log` output.
    const getRecentCommits = vi.fn(async () => ({
      commits: ['abc1234: Add feature (2 days ago)'],
      isGitRepo: true,
    }));
    const { postToRenderer, shellIpc } = await createShellHarness({
      getRecentCommits,
    });

    expect(
      shellIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      }),
    ).toBe(true);
    await flushMicrotasks();
    expect(getRecentCommits).toHaveBeenCalledOnce();
    expect(postToRenderer).toHaveBeenCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits: ['abc1234: Add feature (2 days ago)'],
      isGitRepo: true,
    });
  });

  it('wires the main login banner to desktop sign-in', async () => {
    const signIn = vi.fn(async () => {});
    const { postToRenderer, shellIpc } = await createShellHarness({ signIn });

    expect(
      shellIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.SIGN_IN_FROM_BANNER,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(signIn).toHaveBeenCalledOnce();
    expect(postToRenderer).not.toHaveBeenCalled();
  });

  it('rejects shell payloads that fail the MainView inbound schema', async () => {
    const { postToRenderer, shellIpc } = await createShellHarness();

    // SWITCH_VIEW with an invalid `view` value fails the discriminated-union
    // parse and is no longer dispatched as a real switch — i.e. the single
    // entry-point parse is the validation boundary, not per-handler reads.
    expect(
      shellIpc.handleMessage({
        command: COMMON_COMMANDS.SWITCH_VIEW,
        view: 'not-a-real-route',
      }),
    ).toBe(false);
    expect(postToRenderer).not.toHaveBeenCalled();

    // Unknown command falls through entirely (neither a main-view variant
    // nor a desktop-local command) so the dispatcher chain can keep walking.
    expect(shellIpc.handleMessage({ command: 'texra.totallyUnknown' })).toBe(
      false,
    );
  });

  it('keeps execution forwarding in the execution adapter', async () => {
    const { createDesktopExecutionIpc } = await loadSourceModule(
      '@desktop/main/desktopExecutionIpc',
    );
    const executeMessage = {
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'direct-agent',
      model: 'gpt-5.4',
    };
    const handleExecuteMessage = vi.fn(async (_message: unknown) => {});
    const executionIpc = createDesktopExecutionIpc({ handleExecuteMessage });

    expect(executionIpc.handleMessage(executeMessage)).toBe(true);
    await Promise.resolve();
    expect(handleExecuteMessage).toHaveBeenCalledWith(executeMessage);

    const malformedError = vi.fn();
    const malformedExecutionIpc = createDesktopExecutionIpc({
      handleExecuteMessage,
      onAsyncError: malformedError,
    });
    expect(
      malformedExecutionIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.EXECUTE,
        files: { inputFiles: 'main.tex' },
      }),
    ).toBe(true);
    expect(handleExecuteMessage).toHaveBeenCalledTimes(1);
    expect(malformedError).toHaveBeenCalledWith(expect.any(Error));

    const error = new Error('execution failed');
    const onAsyncError = vi.fn();
    createDesktopExecutionIpc({
      handleExecuteMessage: vi.fn(async () => {
        throw error;
      }),
      onAsyncError,
    }).handleMessage(executeMessage);
    await flushMicrotasks();
    expect(onAsyncError).toHaveBeenCalledWith(error);
  });

  it('persists first-run walkthrough dismissal in the onboarding adapter', async () => {
    const { dismissedStateKey, onboarding, postToRenderer, update } =
      await createOnboardingHarness();

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    // The refresh is serialized through a promise chain (concurrency guard), so
    // drain microtasks before asserting the pushed state.
    await flushAsync();
    // Fresh install with no credential → State 0 (welcome card).
    expectLastFunnelState(postToRenderer, 'needs-credential');
    postToRenderer.mockClear();

    expect(
      onboarding.handleMessage({ command: 'desktop:requestOnboarding' }),
    ).toBe(true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: true,
    });

    expect(
      onboarding.handleMessage({ command: 'desktop:dismissOnboarding' }),
    ).toBe(true);
    await Promise.resolve();
    expect(update).toHaveBeenCalledWith(dismissedStateKey, true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: false,
    });

    expect(
      onboarding.handleMessage({ command: 'desktop:requestOnboarding' }),
    ).toBe(true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setOnboarding',
      shouldShow: false,
    });

    expect(
      onboarding.handleMessage({ command: 'desktop:showOnboarding' }),
    ).toBe(false);

    postToRenderer.mockClear();
    expect(
      onboarding.handleMessage({ command: MAIN_VIEW_COMMANDS.ONBOARDING_SKIP }),
    ).toBe(true);
    // The skip persists the declined flag then refreshes through the serialized
    // chain, so drain microtasks before asserting.
    await flushAsync();
    expect(update).toHaveBeenLastCalledWith(
      GlobalStateKey.ONBOARDING_DECLINED,
      true,
    );
    expectLastFunnelState(postToRenderer, 'done');
  });

  it('derives State 1 (setup) when hasCredential is true on fresh install', async () => {
    const selectSetupAgent = vi.fn(async () => {});
    const { onboarding, postToRenderer } = await createOnboardingHarness({
      hasCredential: () => true,
      selectSetupAgent,
    });

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    await flushAsync();
    // Credential present, firstRunDone not set → State 1 (setup card).
    expectLastFunnelState(postToRenderer, 'setup');
    // selectSetupAgent callback fires on State 1 entry.
    expect(selectSetupAgent).toHaveBeenCalled();
  });

  it('derives State 2 (done) for backfilled veterans with firstRunDone set', async () => {
    const { onboarding, postToRenderer } = await createOnboardingHarness({
      seed: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
      hasCredential: () => true,
    });

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    await flushAsync();
    // Backfilled veteran → State 2 (done), no onboarding UI shown.
    expectLastFunnelState(postToRenderer, 'done');
  });

  it('handles ONBOARDING_SKIP_SETUP by setting firstRunDone and pushing done', async () => {
    const { onboarding, postToRenderer, update } =
      await createOnboardingHarness({ hasCredential: () => true });

    // Enter State 1 first.
    onboarding.handleMessage({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    await flushAsync();
    expectLastFunnelState(postToRenderer, 'setup');
    postToRenderer.mockClear();
    update.mockClear();

    // Skip setup → firstRunDone=true, funnel → 'done'.
    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.ONBOARDING_SKIP_SETUP,
      }),
    ).toBe(true);
    await flushAsync();
    expect(update).toHaveBeenCalledWith(
      GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
      true,
    );
    expectLastFunnelState(postToRenderer, 'done');
  });

  it('calls the ChatGPT sign-in callback and refreshes the funnel', async () => {
    const signInCalled = vi.fn(async () => {});
    const { onboarding, postToRenderer } = await createOnboardingHarness({
      signInWithChatGpt: signInCalled,
    });

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT,
      }),
    ).toBe(true);
    await flushAsync();
    expect(signInCalled).toHaveBeenCalledOnce();
    expectLastFunnelState(postToRenderer, 'needs-credential');
  });

  it('runs the real kickoff path on ONBOARDING_RUN_SETUP and refreshes after', async () => {
    const callOrder: string[] = [];
    const selectSetupAgent = vi.fn(async () => {
      callOrder.push('select');
    });
    const kickoffSetup = vi.fn(async () => {
      callOrder.push('kickoff');
    });
    const { onboarding, postToRenderer } = await createOnboardingHarness({
      hasCredential: () => true,
      selectSetupAgent,
      kickoffSetup,
    });

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP,
      }),
    ).toBe(true);
    await flushAsync();

    // Real run-setup path: `runSetup` selects the setup agent and kicks off the
    // conversation, then recomputes the funnel. The follow-up refresh enters
    // State 1 (credential present) so it also selects the setup agent — hence
    // `select` fires twice, framing `kickoff`. The terminal state is 'setup'.
    expect(kickoffSetup).toHaveBeenCalledOnce();
    expect(selectSetupAgent).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['select', 'kickoff', 'select']);
    expectLastFunnelState(postToRenderer, 'setup');
  });

  it('opens the getting-started docs on ONBOARDING_OPEN_GETTING_STARTED', async () => {
    const openGettingStarted = vi.fn(async () => {});
    const { onboarding, postToRenderer } = await createOnboardingHarness({
      openGettingStarted,
    });

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.ONBOARDING_OPEN_GETTING_STARTED,
      }),
    ).toBe(true);
    await flushAsync();
    expect(openGettingStarted).toHaveBeenCalledOnce();
    // Opening the walkthrough does not push a funnel state (no derivation
    // change), so no SET_ONBOARDING_FUNNEL is sent for this command.
    expect(postToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      }),
    );
  });

  it('serializes overlapping funnel refreshes to one consistent terminal state', async () => {
    // A credential probe that resolves on the next macrotask, so two refreshes
    // started back-to-back genuinely overlap in flight. `selectSetupAgent`
    // would only fire when `previous !== 'setup'`; if the two refreshes
    // interleaved and both computed against `previous === undefined`, it would
    // be called twice. Serialized, the second refresh sees `previous === 'setup'`
    // and does not re-select.
    let credentialPresent = false;
    const hasCredential = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(credentialPresent), 0);
        }),
    );
    const selectSetupAgent = vi.fn(async () => {});
    const { onboarding, postToRenderer } = await createOnboardingHarness({
      hasCredential,
      selectSetupAgent,
    });

    // First refresh: no credential yet → needs-credential. Second refresh: a
    // credential lands → setup. Fire them overlapping (no await between).
    const first = onboarding.refreshOnboardingFunnel();
    credentialPresent = true;
    const second = onboarding.refreshOnboardingFunnel();
    await Promise.all([first, second]);
    await flushAsync();

    const funnelStates = postToRenderer.mock.calls
      .map(([message]) => message as { command: string; state?: string })
      .filter(
        (message) =>
          message.command === MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      )
      .map((message) => message.state);

    // The terminal state is consistent (setup), and the State 0→1 transition
    // selected the setup agent exactly once — proof the refreshes did not
    // interleave and clobber `previousFunnelState`.
    expect(funnelStates.at(-1)).toBe('setup');
    expect(selectSetupAgent).toHaveBeenCalledOnce();
  });

  it('serves desktop log snapshots and copy/export actions', async () => {
    const { createDesktopLogIpc } = await loadSourceModule(
      '@desktop/main/desktopLogIpc',
    );
    const logText = '2026-05-07T00:00:00.000Z [info] safe log line';
    const postToRenderer = vi.fn();
    const copyLog = vi.fn(async (_text: string) => {});
    const exportLog = vi.fn(async (_text: string) => {});
    const readLog = vi.fn(() => ({
      path: '/logs/texra-desktop.log',
      text: logText,
      truncated: false,
    }));
    const logs = createDesktopLogIpc(
      { postToRenderer },
      { readLog, copyLog, exportLog },
    );

    expect(logs.handleMessage({ command: 'desktop:requestLog' })).toBe(true);
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: 'desktop:setLog',
      log: {
        path: '/logs/texra-desktop.log',
        text: logText,
        truncated: false,
      },
    });

    expect(logs.handleMessage({ command: 'desktop:copyLog' })).toBe(true);
    await Promise.resolve();
    expect(copyLog).toHaveBeenCalledWith(logText);

    expect(logs.handleMessage({ command: 'desktop:exportLog' })).toBe(true);
    await Promise.resolve();
    expect(exportLog).toHaveBeenCalledWith(logText);
  });
});
