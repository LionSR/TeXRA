import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import { FakeStateStore } from '@test/support/FakePlatform';

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

async function createShellHarness(
  overrides: Partial<DesktopShellActionFactoryOptions> = {},
) {
  const { createDesktopShellActions, createDesktopShellIpc } =
    await import('@desktop/main/desktopShellIpc');
  const postToRenderer = vi.fn();
  const actions = createDesktopShellActions(
    { postToRenderer },
    {
      getCustomAgentDirectory: () => Effect.succeed('/agents/custom'),
      openExternalUrl: vi.fn(() => Effect.void),
      openLogFolder: vi.fn(() => Effect.void),
      openPath: vi.fn(() => Effect.void),
      openWorkspaceFolder: vi.fn(() => Effect.void),
      signIn: vi.fn(() => Effect.void),
      showInfoMessage: vi.fn(),
      onAsyncError: vi.fn(),
      runtime: testRuntime(),
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
    import('@desktop/main/desktopOnboardingIpc'),
    import('@desktop/shared/desktopOnboardingMessages'),
  ]);
  const state = new FakeStateStore({ ...seed });
  const update = vi.spyOn(state, 'update');
  const postToRenderer = vi.fn();
  const runtime = options.runtime ?? testRuntime();
  const onboarding = createDesktopOnboardingIpc(
    { postToRenderer },
    {
      hasCredential: () => Effect.succeed(false),
      kickoffSetup: () => Effect.void,
      signInWithChatGpt: () => Effect.void,
      onAsyncError: vi.fn(),
      ...options,
      runtime,
      state,
    },
  );
  return {
    state,
    update,
    onboarding,
    postToRenderer,
    runtime,
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

  it.effect(
    'persists first-run walkthrough dismissal in the onboarding adapter',
    () =>
      Effect.gen(function* () {
        const {
          dismissedStateKey,
          onboarding,
          postToRenderer,
          runtime,
          update,
        } = yield* Effect.promise(() => createOnboardingHarness());

        yield* withProcessServices(
          runtime,
          onboarding.refreshOnboardingFunnel(),
        );
        // The refresh is serialized through a promise chain (concurrency guard), so
        // drain microtasks before asserting the derived state.
        yield* Effect.promise(() => flushAsync());
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
        yield* Effect.promise(() => Promise.resolve());
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
        yield* withProcessServices(runtime, onboarding.skipOnboarding());
        // The skip persists the declined flag then refreshes through the serialized
        // chain, so drain microtasks before asserting.
        yield* Effect.promise(() => flushAsync());
        expect(update).toHaveBeenLastCalledWith(
          GlobalStateKey.ONBOARDING_DECLINED,
          true,
        );
        expectFunnelState(onboarding, 'done');
      }),
  );

  it.effect(
    'derives State 1 (setup) when hasCredential is true on fresh install',
    () =>
      Effect.gen(function* () {
        const { onboarding, runtime } = yield* Effect.promise(() =>
          createOnboardingHarness({
            hasCredential: () => Effect.succeed(true),
          }),
        );

        yield* withProcessServices(
          runtime,
          onboarding.refreshOnboardingFunnel(),
        );
        yield* Effect.promise(() => flushAsync());
        // Credential present, firstRunDone not set: State 1 (setup card).
        expectFunnelState(onboarding, 'setup');
      }),
  );

  it.effect('derives State 2 (done) for veterans with firstRunDone set', () =>
    Effect.gen(function* () {
      const { onboarding, runtime } = yield* Effect.promise(() =>
        createOnboardingHarness({
          seed: { [GlobalStateKey.ONBOARDING_FIRST_RUN_DONE]: true },
          hasCredential: () => Effect.succeed(true),
        }),
      );

      yield* withProcessServices(runtime, onboarding.refreshOnboardingFunnel());
      yield* Effect.promise(() => flushAsync());
      // Veteran with firstRunDone set: State 2 (done), no onboarding UI shown.
      expectFunnelState(onboarding, 'done');
    }),
  );

  it.effect('handles skipSetup by setting firstRunDone and deriving done', () =>
    Effect.gen(function* () {
      const { onboarding, runtime, update } = yield* Effect.promise(() =>
        createOnboardingHarness({
          hasCredential: () => Effect.succeed(true),
        }),
      );

      yield* withProcessServices(runtime, onboarding.refreshOnboardingFunnel());
      yield* Effect.promise(() => flushAsync());
      expectFunnelState(onboarding, 'setup');
      update.mockClear();

      yield* withProcessServices(runtime, onboarding.skipSetup());
      yield* Effect.promise(() => flushAsync());
      expect(update).toHaveBeenCalledWith(
        GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
        true,
      );
      expectFunnelState(onboarding, 'done');
    }),
  );

  it.effect('runs the real kickoff path on runSetup and refreshes after', () =>
    Effect.gen(function* () {
      const kickoffSetup = vi.fn(() => Effect.void);
      const { onboarding, runtime } = yield* Effect.promise(() =>
        createOnboardingHarness({
          hasCredential: () => Effect.succeed(true),
          kickoffSetup,
        }),
      );

      yield* withProcessServices(runtime, onboarding.runSetup());
      yield* Effect.promise(() => flushAsync());

      // Real run-setup path: `runSetup` kicks off the conversation, then
      // recomputes the funnel, which enters State 1 (credential present).
      expect(kickoffSetup).toHaveBeenCalledOnce();
      expectFunnelState(onboarding, 'setup');
    }),
  );

  it.effect(
    'serializes overlapping funnel refreshes to one consistent terminal state',
    () =>
      Effect.gen(function* () {
        // A credential probe that resolves on the next macrotask, so two refreshes
        // started back-to-back genuinely overlap in flight. Serialized, the
        // second refresh sees `previous === 'setup'` and reports no change. (The
        // assertion pins the terminal state; it is not a strict interleave probe.)
        let credentialPresent = false;
        const hasCredential = vi.fn(() =>
          Effect.promise(
            () =>
              new Promise<boolean>((resolve) => {
                setTimeout(() => resolve(credentialPresent), 0);
              }),
          ),
        );
        const { onboarding, runtime } = yield* Effect.promise(() =>
          createOnboardingHarness({
            hasCredential,
          }),
        );
        const funnelStates: string[] = [];
        onboarding.onFunnelChange((state) =>
          Effect.sync(() => {
            funnelStates.push(state);
          }),
        );

        // Fire them overlapping (no await between); the credential lands before
        // either probe resolves.
        const first = yield* Effect.forkChild(
          withProcessServices(runtime, onboarding.refreshOnboardingFunnel()),
          { startImmediately: true },
        );
        credentialPresent = true;
        const second = yield* Effect.forkChild(
          withProcessServices(runtime, onboarding.refreshOnboardingFunnel()),
          { startImmediately: true },
        );
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        yield* Effect.promise(() => flushAsync());

        // One change, to setup.
        expect(funnelStates).toEqual(['setup']);
      }),
  );
});
