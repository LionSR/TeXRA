import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, expect, vi } from 'vitest';

import { withProcessServices } from '@platform/processRuntime';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { testRuntime } from '@test/support/testProcessRuntime';
import { FakeStateStore } from '@test/support/FakePlatform';

// refreshOnboardingFunnel runs fire-and-forget through a chain several awaits
// deep; each setTimeout(0) settles the whole pending microtask queue (and any
// scheduled credential probe), so this stays correct if the chain deepens.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('desktop IPC adapters', () => {
  it.effect('derives State 0 on a fresh install and skips to done', () =>
    Effect.gen(function* () {
      const { createDesktopOnboardingIpc } = yield* Effect.promise(
        () => import('@desktop/main/desktopOnboardingIpc'),
      );
      const state = new FakeStateStore({});
      const update = vi.spyOn(state, 'update');
      const runtime = testRuntime();
      const onboarding = createDesktopOnboardingIpc({
        hasCredential: () => Effect.succeed(false),
        kickoffSetup: () => Effect.void,
        signInWithChatGpt: () => Effect.void,
        state,
      });

      yield* withProcessServices(runtime, onboarding.refreshOnboardingFunnel());
      // The refresh is serialized through a promise chain (concurrency guard), so
      // drain microtasks before asserting the derived state.
      yield* Effect.promise(() => flushAsync());
      // Fresh install with no credential: State 0 (the Connect a model card).
      expect(onboarding.funnelState()).toBe('needs-credential');

      yield* withProcessServices(runtime, onboarding.skipOnboarding());
      // The skip persists the declined flag then refreshes through the serialized
      // chain, so drain microtasks before asserting.
      yield* Effect.promise(() => flushAsync());
      expect(update).toHaveBeenLastCalledWith(
        GlobalStateKey.ONBOARDING_DECLINED,
        true,
      );
      expect(onboarding.funnelState()).toBe('done');
    }),
  );
});
