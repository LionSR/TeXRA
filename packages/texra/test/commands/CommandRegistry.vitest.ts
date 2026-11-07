// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { assert, describe, expect } from 'vitest';

// Local imports
import { dispatchCommandFromRegistry } from '@texra/shared/commands/registry';

describe('dispatchCommandFromRegistry', () => {
  // Regression guard for #3782: a handler's program must reach the caller
  // untouched, not be swallowed by a fire-and-forget `void actions.X();
  // return true;`, so running it surfaces the rejection to `executeCommand`
  // callers.
  it.effect("returns the handler's failing program to the caller (#3782)", () =>
    Effect.gen(function* () {
      const failure = new Error('boom');
      const program = dispatchCommandFromRegistry(
        'texra.showMemory',
        { 'texra.showMemory': () => Effect.fail(failure) },
        undefined,
      );
      assert(program !== false);
      expect(yield* Effect.flip(program)).toBe(failure);
    }),
  );
});
