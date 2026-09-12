// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe, vi } from 'vitest';

// Local imports
import { API_PROVIDERS, apiKeySecretName } from '@model/apiProviders';
import { platform } from '@platform/platform';
import type { ToolResult } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';
import { ListApiKeysTool } from '@tools/setup/ListApiKeysTool';

const tool = new ListApiKeysTool();

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
  it.effect('reports unsupported enumeration instead of an empty store', () =>
    Effect.gen(function* () {
      vi.spyOn(platform().secrets, 'listStoredKeys').mockRejectedValue(
        new Error('SecretStorage key enumeration is not supported'),
      );

      const result = yield* tool
        .call({})
        .pipe(Effect.provide(nativeToolTestLayer()));

      assert.equal(result.status, 'error');
      assert.match(result.error ?? '', /enumeration is not supported/);
      assert.doesNotMatch(outputOf(result), /credential store is empty/);
    }),
  );

  it.effect('shows known provider keys by provider name', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys([apiKeySecretName('anthropic')]);
      assert.match(outputOf(result), /Provider API keys stored/);
      assert.match(outputOf(result), /^\s+anthropic$/m);
      assert.doesNotMatch(outputOf(result), /apiKey\.anthropic/);
    }),
  );

  it.effect('recognises the GitHub token', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys([GITHUB_TOKEN_STORAGE_KEY]);
      assert.match(outputOf(result), /GitHub token: stored/);
    }),
  );

  it.effect('reports stale provider entries as diagnostic', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys(['apiKey.oldprovider']);
      assert.match(outputOf(result), /diagnostic only/);
      assert.match(outputOf(result), /not unset_api_key providers/);
      assert.match(outputOf(result), /apiKey\.oldprovider/);
    }),
  );

  it.effect('redacts other stored secret names', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys(['texra.supabase.session']);
      assert.match(
        outputOf(result),
        /Other stored secrets: 1 redacted key name/,
      );
      assert.doesNotMatch(outputOf(result), /texra\.supabase\.session/);
    }),
  );

  it.effect('counts stored provider keys against the full catalog', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys([apiKeySecretName('anthropic')]);
      assert.equal(
        result.summary,
        `1 stored secret: 1/${API_PROVIDERS.length} persisted provider API keys`,
      );
    }),
  );

  it.effect('shows missing providers with no persisted provider keys', () =>
    Effect.gen(function* () {
      const result = yield* callWithStoredKeys([GITHUB_TOKEN_STORAGE_KEY]);
      assert.match(
        outputOf(result),
        /No provider API keys persisted in TeXRA secrets/,
      );
      assert.match(
        outputOf(result),
        /Providers without a key in TeXRA secrets/,
      );
      assert.match(outputOf(result), /anthropic/);
      assert.match(outputOf(result), /openai/);
    }),
  );
});
