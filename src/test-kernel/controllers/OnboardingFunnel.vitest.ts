import { Deferred, Effect, Fiber } from 'effect';
import { it } from '@effect/vitest';
import { describe, expect } from 'vitest';

import {
  OnboardingFunnelRefresher,
  planOnboardingFunnelTransition,
} from '@controllers/onboarding/onboardingFunnel';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { OnboardingFunnelState } from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';

type OnboardingFunnelInputs = Parameters<
  typeof planOnboardingFunnelTransition
>[1];
type OnboardingFunnelTransition = ReturnType<
  typeof planOnboardingFunnelTransition
>;

describe('planOnboardingFunnelTransition', () => {
  it.each<
    [
      string,
      OnboardingFunnelState | undefined,
      OnboardingFunnelInputs,
      OnboardingFunnelTransition,
    ]
  >([
    [
      'in-session State 0 → 1: selects the setup agent but never auto-runs',
      'needs-credential',
      { hasCredential: true, declined: false, firstRunDone: false },
      { state: 'setup', selectSetupAgent: true, clearDeclined: false },
    ],
    [
      'plain activation in State 1 (previous undefined): selects but never auto-runs',
      undefined,
      { hasCredential: true, declined: false, firstRunDone: false },
      { state: 'setup', selectSetupAgent: true, clearDeclined: false },
    ],
    [
      'a refresh already in State 1 never re-selects (user agent switches survive)',
      'setup',
      { hasCredential: true, declined: false, firstRunDone: false },
      { state: 'setup', selectSetupAgent: false, clearDeclined: false },
    ],
    [
      'skipped user who later configures a credential: re-enters State 1, clears the skip, no auto-run',
      'done',
      { hasCredential: true, declined: true, firstRunDone: false },
      { state: 'setup', selectSetupAgent: true, clearDeclined: true },
    ],
    [
      'first run already done: credential arrival lands in State 2 with no setup actions',
      'needs-credential',
      { hasCredential: true, declined: false, firstRunDone: true },
      { state: 'done', selectSetupAgent: false, clearDeclined: false },
    ],
    [
      'first run already done: missing credentials stay in State 2',
      'needs-credential',
      { hasCredential: false, declined: false, firstRunDone: true },
      { state: 'done', selectSetupAgent: false, clearDeclined: false },
    ],
    [
      'State 0 holds while no credential exists',
      'needs-credential',
      { hasCredential: false, declined: false, firstRunDone: false },
      {
        state: 'needs-credential',
        selectSetupAgent: false,
        clearDeclined: false,
      },
    ],
    [
      'skip while in State 0: moves to done without setup actions',
      'needs-credential',
      { hasCredential: false, declined: true, firstRunDone: false },
      { state: 'done', selectSetupAgent: false, clearDeclined: false },
    ],
  ])('%s', (_name, previous, inputs, expected) => {
    expect(planOnboardingFunnelTransition(previous, inputs)).toEqual(expected);
  });
});

describe('OnboardingFunnelRefresher', () => {
  it.effect(
    'waits for publication and retries a transition interrupted before it lands',
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const transitions: OnboardingFunnelTransition[] = [];
        const refresher = new OnboardingFunnelRefresher({
          hasCredential: () => Effect.succeed(true),
          flags: new FakeStateStore(),
          apply: (transition) =>
            Effect.gen(function* () {
              transitions.push(transition);
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }),
        });

        const first = yield* Effect.forkChild(refresher.run());
        yield* Deferred.await(entered);
        expect(refresher.state).toBeUndefined();
        yield* Fiber.interrupt(first);
        expect(refresher.state).toBeUndefined();

        yield* Deferred.succeed(release, undefined);
        yield* refresher.run();
        expect(refresher.state).toBe('setup');
        expect(transitions).toHaveLength(2);
        expect(transitions[1]?.selectSetupAgent).toBe(true);
      }).pipe(
        Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
      ),
  );
});
