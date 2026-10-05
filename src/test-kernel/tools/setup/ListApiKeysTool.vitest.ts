// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, vi } from 'vitest';

// Local imports
import { SecretsFailed } from '@texra-ai/llm';
import type { ToolResult } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  hostStores,
  installPlatform,
  setupPlatform,
} from '@test/support/setupPlatform';
import { ListApiKeysTool } from '@texra/tools/setup/ListApiKeysTool';

const tool = ListApiKeysTool;

setupPlatform();

/** Seed the fake host's credential store with exactly `keys`, then audit it. */
function callWithStoredKeys(keys: readonly string[]) {
  return Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      installPlatform({
        secrets: Object.fromEntries(keys.map((key) => [key, 'stored-value'])),
      }),
    );
    const result = yield* tool
      .call({})
      .pipe(Effect.provide(nativeToolTestLayer()));
    assert.equal(result.status, 'executed');
    return result;
  });
}

function outputOf(result: ToolResult): string {
  return result.output ?? '';
}

describe('list_api_keys tool', () => {
  it.effect('reports an unreadable store instead of an empty one', () =>
    Effect.gen(function* () {
      vi.spyOn(hostStores().secrets, 'listStoredKeys').mockReturnValue(
        Effect.fail(
          new SecretsFailed({
            reason: 'io',
            operation: 'listStoredKeys',
            message: 'The credential store could not be read',
          }),
        ),
      );

      const result = yield* tool
        .call({})
        .pipe(Effect.provide(nativeToolTestLayer()));

      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /could not be read/);
      assert.doesNotMatch(outputOf(result), /credential store is empty/);
    }),
  );

  it.effect('redacts other stored secret names', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys(['texra.other.secret']);
      assert.match(
        outputOf(result),
        /Other stored secrets: 1 redacted key name/,
      );
      assert.doesNotMatch(outputOf(result), /texra\.other\.secret/);
    }),
  );
});
