// Test composition imports

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';

// Local imports

import { closeAllSessions } from '@agent/runtime/sessionGraph';
import { closeSessionOf } from '@test/support/sessionEnd';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { createTestSession } from '@test/support/sessionTestUtils';

describe('agent shutdown', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.effect("drains every live session's background processes once", () =>
    Effect.gen(function* () {
      const firstSession = createTestSession();
      const secondSession = createTestSession();
      yield* Effect.addFinalizer(() =>
        closeSessionOf(firstSession).pipe(
          Effect.andThen(closeSessionOf(secondSession)),
        ),
      );
      const compatibilitySession = testDefaultSession();
      const firstDrain = vi.spyOn(firstSession.runs, 'killBackgroundProcesses');
      const secondDrain = vi.spyOn(
        secondSession.runs,
        'killBackgroundProcesses',
      );
      const compatibilityDrain = vi.spyOn(
        compatibilitySession.runs,
        'killBackgroundProcesses',
      );

      // A host's shutdown closes every held session; a later close finds
      // them released and drains nothing again.
      yield* closeAllSessions();
      yield* closeAllSessions();

      expect(firstDrain).toHaveBeenCalledOnce();
      expect(secondDrain).toHaveBeenCalledOnce();
      expect(compatibilityDrain).toHaveBeenCalledOnce();
    }),
  );
});
