// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { assert, expect } from 'vitest';

// Local imports
import { waitForCondition } from '@test/support/asyncTestUtils';
import { scriptedSpawnerLayer } from '@test/support/childProcessTestLayer';
import { FakeHost, SessionGraph } from '@test/support/testKernel';
import { wolfram } from '@texra/tools/wolframPlugin';
import { texraPlugins } from '@texra/tools/registry';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { DISABLED_TOOLS_KEY } from '@shared/state/disabledTools';

/** A host whose DISABLED_TOOLS list is already seeded, and empty. */
const seeded = FakeHost.layer({
  globalState: { [DISABLED_TOOLS_KEY.key]: [] },
});

layer(seeded, { buildPerTest: true })('seedDisabledToolDefaults', (it) => {
  // An empty list is the person's choice (every tool enabled); reseeding it
  // would silently switch their tools back off on the next start.
  it.effect(
    'does not seed for an already-seeded DISABLED_TOOLS list, even an empty one',
    () =>
      Effect.gen(function* () {
        const { globalState } = (yield* FakeHost).roots;

        yield* seedDisabledToolDefaults(
          globalState,
          texraPlugins({ name: 'vscode' }),
        );

        expect(yield* globalState.get(DISABLED_TOOLS_KEY.key)).toEqual([]);
      }),
  );
});

/**
 * A dashboard refresh forks the version probes; an interrupted refresh must
 * stop the `<tool> --version` process it spawned, not leave it running.
 */
layer(SessionGraph.hosted)('external tool availability probes', (it) => {
  it.effect('an interrupted version probe stops the process it spawned', () =>
    Effect.gen(function* () {
      const spawner = scriptedSpawnerLayer(() => 'hang');
      const { roots } = yield* FakeHost;
      const { availability } = wolfram;
      assert.exists(availability);
      const fiber = yield* Effect.forkChild(
        availability.check(roots).pipe(Effect.provide(spawner.layer)),
      );

      yield* Effect.promise(() =>
        waitForCondition(() => spawner.calls.length > 0),
      );
      yield* Fiber.interrupt(fiber);

      expect(spawner.killed).toEqual(spawner.calls);
    }),
  );
});
