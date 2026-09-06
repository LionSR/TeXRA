import { describe, expect, it, vi } from 'vitest';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { FakeStateStore } from '@test/support/FakePlatform';
import { createModuleMocks } from '@test/support/moduleMocks';

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

// refreshOnboardingFunnel runs fire-and-forget through a chain several awaits
// deep; each setTimeout(0) settles the whole pending microtask queue (and any
// scheduled credential probe), so this stays correct if the chain deepens.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

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

// `update` is spied so tests can assert persisted keys.
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

function expectFunnelState(
  onboarding: { funnelState(): string | null },
  state: 'needs-credential' | 'setup' | 'done',
): void {
  expect(onboarding.funnelState()).toBe(state);
}

describe('desktop IPC adapters', () => {
  it('opens settings tabs and the custom agent directory from the shell actions', async () => {
    const openPath = vi.fn(async (_filePath: string) => {});
    const { actions, postToRenderer } = await createShellHarness({ openPath });

    actions.showLauncher();
    actions.showSettings('models');
    actions.showSettings('agents', 'toolUse');
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
      tab: 'models',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(4, {
      command: 'desktop:openWorkbench',
      kind: 'settings',
    });
    expect(postToRenderer).toHaveBeenNthCalledWith(5, {
      agentSubTab: 'toolUse',
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tab: 'agents',
    });

    actions.openAgentDirectory(true);
    await flushMicrotasks();
    expect(openPath).toHaveBeenCalledWith('/agents/custom');

    postToRenderer.mockClear();
    actions.openAgentDirectory(false);
    expect(postToRenderer).toHaveBeenCalledWith({
      command: 'desktop:openWorkbench',
      kind: 'settings',
    });
    expect(postToRenderer).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.SET_TAB,
      tab: 'agents',
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

  it('shows the launcher for New Session through the shell messages', async () => {
    const { actions, postToRenderer } = await createShellHarness();

    actions.resetMainView();

    expect(postToRenderer.mock.calls.map(([message]) => message)).toEqual([
      { command: 'desktop:showLauncher' },
    ]);
  });

  it('claims only the desktop-local shell commands', async () => {
    const { postToRenderer, shellIpc } = await createShellHarness();

    expect(shellIpc.handleMessage({ command: 'texra.totallyUnknown' })).toBe(
      false,
    );
    expect(
      shellIpc.handleMessage({ command: 'texra.desktop.openDesktopDocs' }),
    ).toBe(true);
    expect(postToRenderer).not.toHaveBeenCalled();
  });

  it('persists first-run walkthrough dismissal in the onboarding adapter', async () => {
    const { dismissedStateKey, onboarding, postToRenderer, update } =
      await createOnboardingHarness();

    await onboarding.refreshOnboardingFunnel();
    // The refresh is serialized through a promise chain (concurrency guard), so
    // drain microtasks before asserting the derived state.
    await flushAsync();
    // Fresh install with no credential: State 0 (welcome card).
    expectFunnelState(onboarding, 'needs-credential');
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
    await onboarding.skipOnboarding();
    // The skip persists the declined flag then refreshes through the serialized
    // chain, so drain microtasks before asserting.
    await flushAsync();
    expect(update).toHaveBeenLastCalledWith(
      GlobalStateKey.ONBOARDING_DECLINED,
      true,
    );
    expectFunnelState(onboarding, 'done');
  });

  it('derives State 1 (setup) when hasCredential is true on fresh install', async () => {
    const selectSetupAgent = vi.fn(async () => {});
    const { onboarding } = await createOnboardingHarness({
      hasCredential: () => true,
      selectSetupAgent,
    });

    await onboarding.refreshOnboardingFunnel();
    await flushAsync();
    // Credential present, firstRunDone not set: State 1 (setup card).
    expectFunnelState(onboarding, 'setup');
    // selectSetupAgent callback fires on State 1 entry.
    expect(selectSetupAgent).toHaveBeenCalled();
  });

  it('derives State 2 (done) for backfilled veterans with firstRunDone set', async () => {
    const { onboarding } = await createOnboardingHarness({
      seed: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
      hasCredential: () => true,
    });

    await onboarding.refreshOnboardingFunnel();
    await flushAsync();
    // Backfilled veteran: State 2 (done), no onboarding UI shown.
    expectFunnelState(onboarding, 'done');
  });

  it('handles skipSetup by setting firstRunDone and deriving done', async () => {
    const { onboarding, update } = await createOnboardingHarness({
      hasCredential: () => true,
    });

    await onboarding.refreshOnboardingFunnel();
    await flushAsync();
    expectFunnelState(onboarding, 'setup');
    update.mockClear();

    await onboarding.skipSetup();
    await flushAsync();
    expect(update).toHaveBeenCalledWith(
      GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
      true,
    );
    expectFunnelState(onboarding, 'done');
  });

  it('calls the ChatGPT sign-in callback and refreshes the funnel', async () => {
    const signInCalled = vi.fn(async () => {});
    const { onboarding } = await createOnboardingHarness({
      signInWithChatGpt: signInCalled,
    });

    await onboarding.signInWithChatGpt();
    await flushAsync();
    expect(signInCalled).toHaveBeenCalledOnce();
    expectFunnelState(onboarding, 'needs-credential');
  });

  it('runs the real kickoff path on runSetup and refreshes after', async () => {
    const callOrder: string[] = [];
    const selectSetupAgent = vi.fn(async () => {
      callOrder.push('select');
    });
    const kickoffSetup = vi.fn(async () => {
      callOrder.push('kickoff');
    });
    const { onboarding } = await createOnboardingHarness({
      hasCredential: () => true,
      selectSetupAgent,
      kickoffSetup,
    });

    await onboarding.runSetup();
    await flushAsync();

    // Real run-setup path: `runSetup` selects the setup agent and kicks off the
    // conversation, then recomputes the funnel. The follow-up refresh enters
    // State 1 (credential present) so it also selects the setup agent — hence
    // `select` fires twice, framing `kickoff`. The terminal state is 'setup'.
    expect(kickoffSetup).toHaveBeenCalledOnce();
    expect(selectSetupAgent).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual(['select', 'kickoff', 'select']);
    expectFunnelState(onboarding, 'setup');
  });

  it('opens the getting-started docs without deriving a funnel state', async () => {
    const openGettingStarted = vi.fn(async () => {});
    const { onboarding } = await createOnboardingHarness({
      openGettingStarted,
    });

    await onboarding.openGettingStarted();
    await flushAsync();
    expect(openGettingStarted).toHaveBeenCalledOnce();
    expect(onboarding.funnelState()).toBeNull();
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
    const { onboarding } = await createOnboardingHarness({
      hasCredential,
      selectSetupAgent,
    });
    const funnelStates: string[] = [];
    onboarding.onFunnelChange((state) => funnelStates.push(state));

    // First refresh: no credential yet, needs-credential. Second refresh: a
    // credential lands, setup. Fire them overlapping (no await between).
    const first = onboarding.refreshOnboardingFunnel();
    credentialPresent = true;
    const second = onboarding.refreshOnboardingFunnel();
    await Promise.all([first, second]);
    await flushAsync();

    // The terminal state is consistent (setup), and the State 0 to 1
    // transition selected the setup agent exactly once: proof the refreshes
    // did not interleave and clobber `previousFunnelState`.
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
