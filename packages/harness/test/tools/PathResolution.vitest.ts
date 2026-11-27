import { Effect } from 'effect';
import { it } from '@effect/vitest';

import { describe, expect } from 'vitest';

import {
  assertNoParentTraversal,
  ToolError,
} from '@texra-ai/worldline/plugins';

describe('assertNoParentTraversal', () => {
  it.effect.each(['../x', 'a/../../x'])('rejects %s', (targetPath) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(assertNoParentTraversal(targetPath));
      expect(error).toEqual(
        new ToolError(`path must not contain '..': ${targetPath}`),
      );
    }),
  );
});
