// Third-party imports
import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { expect } from 'vitest';

// Local imports
import { FakeHost } from '@test/support/testKernel';
import { LaunchSurfaceSchema } from '@texra/shared/session/surface';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import {
  launchFormOf,
  prepareSurfaceLaunch,
} from '@texra/controllers/mainView/backend/MainViewRunLaunchController';

/** The storage root the requesting session's pasted images live under. */
const ROOTS = { storage: '/papers/first/.texra' };

function launchRequest(
  patch: Record<string, unknown> = {},
): Extract<HostCommand, { kind: 'launch' }> {
  return {
    kind: 'launch',
    launch: Schema.decodeUnknownSync(LaunchSurfaceSchema)(patch),
    instruction: 'Improve the draft.',
  };
}

layer(FakeHost.layer())('main-view run launch controller', (it) => {
  it.effect('fills Run again… with the model a form launch saved', () =>
    Effect.gen(function* () {
      // Failure mode: the model loses the effort the run ran at.
      const selections = { model: 'openai/gpt-5.6-terra@high' };
      const config = yield* prepareSurfaceLaunch(
        launchRequest(selections),
        ROOTS,
      );

      expect(launchFormOf(config)).toMatchObject({
        ...selections,
        instruction: 'Improve the draft.',
      });
    }),
  );
});
