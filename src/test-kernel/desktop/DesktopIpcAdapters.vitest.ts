import { it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import { FakeStateStore } from '@test/support/FakePlatform';

type DesktopOnboardingMainModule =
  typeof import('@desktop/main/desktopOnboardingIpc');
type DesktopOnboardingOptions = NonNullable<
  Parameters<DesktopOnboardingMainModule['createDesktopOnboardingIpc']>[0]
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

// `update` is spied so tests can assert persisted keys.
async function createOnboardingHarness({
  seed = {},
  ...options
}: OnboardingHarnessOptions = {}) {
  const { createDesktopOnboardingIpc } =
    await import('@desktop/main/desktopOnboardingIpc');
  const state = new FakeStateStore({ ...seed });
  const update = vi.spyOn(state, 'update');
  const runtime = testRuntime();
  const onboarding = createDesktopOnboardingIpc({
    hasCredential: () => Effect.succeed(false),
    kickoffSetup: () => Effect.void,
    signInWithChatGpt: () => Effect.void,
    ...options,
    state,
  });
  return { state, update, onboarding, runtime };
}

function expectFunnelState(
  onboarding: { funnelState(): string | null },
  state: 'needs-credential' | 'setup' | 'done',
): void {
  expect(onboarding.funnelState()).toBe(state);
}

describe('desktop IPC adapters', () => {
  it.effect('derives State 0 on a fresh install and skips to done', () =>
    Effect.gen(function* () {
      const { onboarding, runtime, update } = yield* Effect.promise(() =>
        createOnboardingHarness(),
      );

      yield* withProcessServices(runtime, onboarding.refreshOnboardingFunnel());
      // The refresh is serialized through a promise chain (concurrency guard), so
      // drain microtasks before asserting the derived state.
      yield* Effect.promise(() => flushAsync());
      // Fresh install with no credential: State 0 (the Connect a model card).
      expectFunnelState(onboarding, 'needs-credential');

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
