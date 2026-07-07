// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - webview command constants
import {
  COMMON_COMMANDS,
  MAIN_VIEW_COMMANDS,
  SETTINGS_VIEW_COMMANDS,
} from '@shared/ipc';
import { AgentCategory } from '@shared/schemas/agent';
import { SETTINGS_TAB } from '@shared/schemas/settingsViewMessages';
import { GlobalStateKey } from '@shared/state/stateKeys';

// Local imports - desktop test paths
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopRenderer {
  postToRenderer(message: unknown): void;
}

interface DesktopShellIpcModule {
  createDesktopShellIpc(
    renderer: DesktopRenderer,
    options?: {
      getCustomAgentDirectory?: () => Promise<string>;
      openPath?: (filePath: string) => Promise<void>;
      signIn?: () => Promise<void>;
      isWorkspaceGitRepo?: () => boolean;
      getRecentCommits?: () => Promise<{
        commits: string[];
        isGitRepo: boolean;
      }>;
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

interface DesktopLogIpcModule {
  createDesktopLogIpc(
    renderer: DesktopRenderer,
    options?: {
      readLog?: () => { text: string; truncated: boolean; path?: string };
      copyLog?: (text: string) => Promise<void>;
      exportLog?: (text: string) => Promise<void>;
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    handleMessage(message: { command: string }): boolean;
  };
}

interface DesktopExecutionIpcModule {
  createDesktopExecutionIpc(options?: {
    executeAgent?: (message: unknown) => Promise<void>;
    onAsyncError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

interface DesktopOnboardingIpcModule {
  DESKTOP_ONBOARDING_DISMISSED_STATE_KEY: string;
  createDesktopOnboardingIpc(
    renderer: DesktopRenderer,
    options?: {
      state?: {
        get<T>(key: string, defaultValue?: T): T;
        update(key: string, value: unknown): PromiseLike<void>;
      };
      hasCredential?: () => boolean | Promise<boolean>;
      readyGate?: Promise<void>;
      selectSetupAgent?: () => Promise<void>;
      kickoffSetup?: () => Promise<void>;
      signInWithChatGpt?: () => Promise<void>;
      openGettingStarted?: () => Promise<void>;
      onAsyncError?: (error: unknown) => void;
    },
  ): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
    refreshOnboardingFunnel(): Promise<void>;
  };
}

interface DesktopViewStateIpcModule {
  createDesktopViewStateIpc(
    renderer: DesktopRenderer,
    options?: {
      debugMode?: boolean;
      getTheme?: () => 'dark' | 'light' | 'high-contrast';
    },
  ): {
    handleMessage(message: { command: string }): boolean;
    dispose(): void;
  };
}

// The WEBVIEW_READY / run-setup handlers trigger refreshOnboardingFunnel as a
// fire-and-forget task whose chain (readyGate → credential probe →
// selectSetupAgent → guarded kickoffSetup → re-derive) is several awaits deep.
// Drain via macrotask boundaries rather than counting microtask hops: each
// setTimeout(0) lets the entire pending microtask queue — and any
// setTimeout(0)-scheduled credential probe — settle, so this stays correct if
// the chain depth changes.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loadDesktopShellIpc(): Promise<DesktopShellIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopShellIpc.ts'))
  ) as Promise<DesktopShellIpcModule>;
}

async function loadDesktopExecutionIpc(): Promise<DesktopExecutionIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopExecutionIpc.ts'))
  ) as Promise<DesktopExecutionIpcModule>;
}

async function loadDesktopOnboardingIpc(): Promise<DesktopOnboardingIpcModule> {
  const [onboardingIpc, onboardingMessages] = await Promise.all([
    import(
      moduleFileUrl(desktopSourcePath('main', 'desktopOnboardingIpc.ts'))
    ) as Promise<DesktopOnboardingIpcModule>,
    import(
      moduleFileUrl(desktopSourcePath('desktopOnboardingMessages.ts'))
    ) as Promise<{ DESKTOP_ONBOARDING_DISMISSED_STATE_KEY: string }>,
  ]);
  return { ...onboardingIpc, ...onboardingMessages };
}

async function loadDesktopLogIpc(): Promise<DesktopLogIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopLogIpc.ts'))
  ) as Promise<DesktopLogIpcModule>;
}

async function loadDesktopViewStateIpc(nativeTheme: {
  shouldUseDarkColors: boolean;
  shouldUseHighContrastColors: boolean;
  on(event: 'updated', listener: () => void): void;
  off(event: 'updated', listener: () => void): void;
}): Promise<DesktopViewStateIpcModule> {
  vi.resetModules();
  vi.doMock('electron', () => ({ nativeTheme }));
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopViewStateIpc.ts'))
  ) as Promise<DesktopViewStateIpcModule>;
}

// Backing store the onboarding adapter reads and writes; `update` is a spy so
// tests can assert persisted keys, `values` exposes the raw map for seeding.
function createMemoryState() {
  const values = new Map<string, unknown>();
  const update = vi.fn(async (key: string, value: unknown) => {
    values.set(key, value);
  });
  const state = {
    get<T>(key: string, defaultValue?: T): T {
      return (values.has(key) ? values.get(key) : defaultValue) as T;
    },
    update,
  };
  return { values, update, state };
}

// Shared setup for onboarding tests that only need a fresh memory-backed
// state store and a postToRenderer spy (no seeded values, no update spy).
async function createOnboardingHarness() {
  const { createDesktopOnboardingIpc } = await loadDesktopOnboardingIpc();
  const { state } = createMemoryState();
  const postToRenderer = vi.fn();
  return { createDesktopOnboardingIpc, state, postToRenderer };
}

describe('desktop IPC adapters', () => {
  afterEach(() => {
    vi.doUnmock('electron');
  });

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
    const { createDesktopViewStateIpc } =
      await loadDesktopViewStateIpc(nativeTheme);
    const postToRenderer = vi.fn();
    const stateIpc = createDesktopViewStateIpc(
      { postToRenderer },
      { debugMode: true },
    );

    expect(
      stateIpc.handleMessage({ command: MAIN_VIEW_COMMANDS.WEBVIEW_READY }),
    ).toBe(true);
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

  it('keeps shell routing and launcher fallbacks in the shell adapter', async () => {
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const openPath = vi.fn(async (_filePath: string) => {});
    const shellIpc = createDesktopShellIpc(
      { postToRenderer },
      {
        getCustomAgentDirectory: async () => '/agents/custom',
        openPath,
      },
    );

    shellIpc.handleMessage({
      command: COMMON_COMMANDS.SWITCH_VIEW,
      view: 'progress',
    });
    shellIpc.handleMessage({ command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS });
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      sessionType: AgentCategory.ToolUse,
    });
    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
    });

    expect(postToRenderer).toHaveBeenNthCalledWith(1, {
      command: 'desktop:setRoute',
      route: 'progress',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(2, {
      command: 'desktop:setRoute',
      route: 'settings',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(3, {
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.MODELS,
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(4, {
      command: 'desktop:setRoute',
      route: 'settings',
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
    await Promise.resolve();
    await Promise.resolve();
    expect(openPath).toHaveBeenCalledWith('/agents/custom');

    postToRenderer.mockClear();
    createDesktopShellIpc({ postToRenderer }).handleMessage({
      command: MAIN_VIEW_COMMANDS.OPEN_AGENT_DIRECTORY,
      customDirSet: true,
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: 'desktop:setRoute',
      route: 'settings',
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tabIndex: SETTINGS_TAB.AGENTS,
    });
  });

  it('forwards real recent commits when a git host is wired', async () => {
    // Closes audit item A: `getRecentCommits` is now a first-class shell
    // option, so the launcher banner sees the actual `git log` output
    // instead of the legacy empty stub.
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const getRecentCommits = vi.fn(async () => ({
      commits: ['abc1234: Add feature (2 days ago)'],
      isGitRepo: true,
    }));
    const shellIpc = createDesktopShellIpc(
      { postToRenderer },
      { getRecentCommits },
    );

    expect(
      shellIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      }),
    ).toBe(true);
    // Resolve the inner promise then the .then() chain.
    await Promise.resolve();
    await Promise.resolve();
    expect(getRecentCommits).toHaveBeenCalledOnce();
    expect(postToRenderer).toHaveBeenCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits: ['abc1234: Add feature (2 days ago)'],
      isGitRepo: true,
    });
  });

  it('falls back to empty list + isWorkspaceGitRepo when no git host is wired', async () => {
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const isWorkspaceGitRepo = vi.fn(() => true);
    const shellIpc = createDesktopShellIpc(
      { postToRenderer },
      { isWorkspaceGitRepo },
    );

    shellIpc.handleMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
    });

    expect(isWorkspaceGitRepo).toHaveBeenCalledOnce();
    expect(postToRenderer).toHaveBeenCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_RECENT_COMMITS,
      commits: [],
      isGitRepo: true,
    });
  });

  it('parses tab-separated git log output into renderer-shaped labels', async () => {
    // The git host parser shapes lines into `<hash>: <subject>
    // (<relative>)` so the renderer can keep its existing string[] schema.
    const { parseCommitLog } = (await import(
      moduleFileUrl(desktopSourcePath('main', 'desktopGitHost.ts'))
    )) as { parseCommitLog: (stdout: string) => string[] };

    const stdout = [
      'abc1234\tAdd feature\t2 days ago',
      'def5678\tFix: handle edge case\t3 days ago',
      // Blank lines are silently skipped.
      '',
      // Lines missing a relative date are skipped (defensive — should not
      // happen with our format but proves the parser doesn't crash).
      'badrow',
    ].join('\n');

    expect(parseCommitLog(stdout)).toEqual([
      'abc1234: Add feature (2 days ago)',
      'def5678: Fix: handle edge case (3 days ago)',
    ]);
    expect(parseCommitLog('')).toEqual([]);
  });

  it('wires the main login banner to desktop sign-in', async () => {
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const signIn = vi.fn(async () => {});
    const shellIpc = createDesktopShellIpc({ postToRenderer }, { signIn });

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
    const { createDesktopShellIpc } = await loadDesktopShellIpc();
    const postToRenderer = vi.fn();
    const shellIpc = createDesktopShellIpc({ postToRenderer });

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
    const { createDesktopExecutionIpc } = await loadDesktopExecutionIpc();
    const executeMessage = {
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent: 'direct-agent',
      model: 'gpt-5.4',
    };
    const executeAgent = vi.fn(async (_message: unknown) => {});
    const executionIpc = createDesktopExecutionIpc({ executeAgent });

    expect(executionIpc.handleMessage(executeMessage)).toBe(true);
    await Promise.resolve();
    expect(executeAgent).toHaveBeenCalledWith(executeMessage);

    const malformedError = vi.fn();
    const malformedExecutionIpc = createDesktopExecutionIpc({
      executeAgent,
      onAsyncError: malformedError,
    });
    expect(
      malformedExecutionIpc.handleMessage({
        command: MAIN_VIEW_COMMANDS.EXECUTE,
        files: { inputFiles: 'main.tex' },
      }),
    ).toBe(true);
    expect(executeAgent).toHaveBeenCalledTimes(1);
    expect(malformedError).toHaveBeenCalledWith(expect.any(Error));

    const error = new Error('execution failed');
    const onAsyncError = vi.fn();
    createDesktopExecutionIpc({
      executeAgent: vi.fn(async () => {
        throw error;
      }),
      onAsyncError,
    }).handleMessage(executeMessage);
    await Promise.resolve();
    await Promise.resolve();
    expect(onAsyncError).toHaveBeenCalledWith(error);
  });

  it('persists first-run walkthrough dismissal in the onboarding adapter', async () => {
    const {
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      createDesktopOnboardingIpc,
    } = await loadDesktopOnboardingIpc();
    const { update, state } = createMemoryState();
    const postToRenderer = vi.fn();
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      { state },
    );

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
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'needs-credential',
    });
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
    expect(update).toHaveBeenCalledWith(
      DESKTOP_ONBOARDING_DISMISSED_STATE_KEY,
      true,
    );
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
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'done',
    });
  });

  it('derives State 1 (setup) when hasCredential is true on fresh install', async () => {
    const { createDesktopOnboardingIpc, state, postToRenderer } =
      await createOnboardingHarness();
    const selectSetupAgent = vi.fn(async () => {});
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      {
        state,
        hasCredential: () => true,
        selectSetupAgent,
      },
    );

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    await flushAsync();
    // Credential present, firstRunDone not set → State 1 (setup card).
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'setup',
    });
    // selectSetupAgent callback fires on State 1 entry.
    expect(selectSetupAgent).toHaveBeenCalled();
  });

  it('derives State 2 (done) for backfilled veterans with firstRunDone set', async () => {
    const { createDesktopOnboardingIpc } = await loadDesktopOnboardingIpc();
    const { values, state } = createMemoryState();
    values.set(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, true);
    const postToRenderer = vi.fn();
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      {
        state,
        hasCredential: () => true,
      },
    );

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    await flushAsync();
    // Backfilled veteran → State 2 (done), no onboarding UI shown.
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'done',
    });
  });

  it('handles ONBOARDING_SKIP_SETUP by setting firstRunDone and pushing done', async () => {
    const { createDesktopOnboardingIpc } = await loadDesktopOnboardingIpc();
    const { update, state } = createMemoryState();
    const postToRenderer = vi.fn();
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      {
        state,
        hasCredential: () => true,
      },
    );

    // Enter State 1 first.
    onboarding.handleMessage({
      command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
      view: 'main',
    });
    await flushAsync();
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'setup',
    });
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
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'done',
    });
  });

  it('calls onboarding run-setup / sign-in-chatgpt callbacks', async () => {
    const { createDesktopOnboardingIpc, state, postToRenderer } =
      await createOnboardingHarness();
    const runSetupCalled = vi.fn(async () => {});
    const signInCalled = vi.fn(async () => {});
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      {
        state,
        hasCredential: () => true,
        selectSetupAgent: runSetupCalled, // reused for run_setup path
        kickoffSetup: runSetupCalled,
        signInWithChatGpt: signInCalled,
      },
    );

    // ONBOARDING_RUN_SETUP: runSetup selects the setup agent (1) and kicks off
    // the conversation through the guarded path (1), then the follow-up refresh
    // re-enters State 1 and selects the setup agent again (1). The shared mock
    // therefore lands at 3 once the chain fully drains; the guard keeps kickoff
    // to exactly one call.
    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.ONBOARDING_RUN_SETUP,
      }),
    ).toBe(true);
    await flushAsync();
    expect(runSetupCalled).toHaveBeenCalledTimes(3);

    // ONBOARDING_SIGN_IN_CHATGPT calls signInCallback + refresh.
    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.ONBOARDING_SIGN_IN_CHATGPT,
      }),
    ).toBe(true);
    await flushAsync();
    expect(signInCalled).toHaveBeenCalled();
  });

  it('runs the real kickoff path on ONBOARDING_RUN_SETUP and refreshes after', async () => {
    const { createDesktopOnboardingIpc, state, postToRenderer } =
      await createOnboardingHarness();
    const callOrder: string[] = [];
    const selectSetupAgent = vi.fn(async () => {
      callOrder.push('select');
    });
    const kickoffSetup = vi.fn(async () => {
      callOrder.push('kickoff');
    });
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      {
        state,
        hasCredential: () => true,
        selectSetupAgent,
        kickoffSetup,
      },
    );

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
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'setup',
    });
  });

  it('opens the getting-started docs on ONBOARDING_OPEN_GETTING_STARTED', async () => {
    const { createDesktopOnboardingIpc, state, postToRenderer } =
      await createOnboardingHarness();
    const openGettingStarted = vi.fn(async () => {});
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      { state, openGettingStarted },
    );

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
    const { createDesktopOnboardingIpc, state, postToRenderer } =
      await createOnboardingHarness();
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
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      { state, hasCredential, selectSetupAgent },
    );

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

  it('defers the first funnel derivation until the readyGate resolves', async () => {
    const { createDesktopOnboardingIpc } = await loadDesktopOnboardingIpc();
    const { values, state } = createMemoryState();
    const postToRenderer = vi.fn();
    let openGate: () => void = () => {};
    const readyGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    // A returning veteran: credential present but firstRunDone not yet written.
    // Before the backfill settles this derives 'setup'; the gate must hold the
    // first derivation so the renderer never sees the transient State 1.
    const selectSetupAgent = vi.fn(async () => {});
    const onboarding = createDesktopOnboardingIpc(
      { postToRenderer },
      { state, readyGate, hasCredential: () => true, selectSetupAgent },
    );

    expect(
      onboarding.handleMessage({
        command: MAIN_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'main',
      }),
    ).toBe(false);
    await flushAsync();
    // Gate still closed → no funnel pushed, no setup-agent selection yet.
    expect(postToRenderer).not.toHaveBeenCalled();
    expect(selectSetupAgent).not.toHaveBeenCalled();

    // Backfill marks the veteran done, then opens the gate.
    values.set(GlobalStateKey.ONBOARDING_FIRST_RUN_DONE, true);
    openGate();
    await flushAsync();

    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: MAIN_VIEW_COMMANDS.SET_ONBOARDING_FUNNEL,
      state: 'done',
    });
    expect(selectSetupAgent).not.toHaveBeenCalled();
  });

  it('serves desktop log snapshots and copy/export actions', async () => {
    const { createDesktopLogIpc } = await loadDesktopLogIpc();
    const postToRenderer = vi.fn();
    const copyLog = vi.fn(async (_text: string) => {});
    const exportLog = vi.fn(async (_text: string) => {});
    const readLog = vi.fn(() => ({
      path: '/logs/texra-desktop.log',
      text: '2026-05-07T00:00:00.000Z [info] safe log line',
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
        text: '2026-05-07T00:00:00.000Z [info] safe log line',
        truncated: false,
      },
    });

    expect(logs.handleMessage({ command: 'desktop:copyLog' })).toBe(true);
    await Promise.resolve();
    expect(copyLog).toHaveBeenCalledWith(
      '2026-05-07T00:00:00.000Z [info] safe log line',
    );

    expect(logs.handleMessage({ command: 'desktop:exportLog' })).toBe(true);
    await Promise.resolve();
    expect(exportLog).toHaveBeenCalledWith(
      '2026-05-07T00:00:00.000Z [info] safe log line',
    );
  });
});
