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
      onAsyncError: vi.fn(),
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
      kickoffSetup: async () => {},
      signInWithChatGpt: async () => {},
      onAsyncError: vi.fn(),
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
    const { onboarding } = await createOnboardingHarness({
      hasCredential: () => true,
    });

    await onboarding.refreshOnboardingFunnel();
    await flushAsync();
    // Credential present, firstRunDone not set: State 1 (setup card).
    expectFunnelState(onboarding, 'setup');
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

  it('runs the real kickoff path on runSetup and refreshes after', async () => {
    const kickoffSetup = vi.fn(async () => {});
    const { onboarding } = await createOnboardingHarness({
      hasCredential: () => true,
      kickoffSetup,
    });

    await onboarding.runSetup();
    await flushAsync();

    // Real run-setup path: `runSetup` kicks off the conversation, then
    // recomputes the funnel, which enters State 1 (credential present).
    expect(kickoffSetup).toHaveBeenCalledOnce();
    expectFunnelState(onboarding, 'setup');
  });

  it('serializes overlapping funnel refreshes to one consistent terminal state', async () => {
    // A credential probe that resolves on the next macrotask, so two refreshes
    // started back-to-back genuinely overlap in flight. Serialized, the
    // second refresh sees `previous === 'setup'` and reports no change. (The
    // assertion pins the terminal state; it is not a strict interleave probe.)
    let credentialPresent = false;
    const hasCredential = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          setTimeout(() => resolve(credentialPresent), 0);
        }),
    );
    const { onboarding } = await createOnboardingHarness({ hasCredential });
    const funnelStates: string[] = [];
    onboarding.onFunnelChange((state) => funnelStates.push(state));

    // Fire them overlapping (no await between); the credential lands before
    // either probe resolves.
    const first = onboarding.refreshOnboardingFunnel();
    credentialPresent = true;
    const second = onboarding.refreshOnboardingFunnel();
    await Promise.all([first, second]);
    await flushAsync();

    // One change, to setup.
    expect(funnelStates).toEqual(['setup']);
  });
});
