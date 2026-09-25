// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, vi } from 'vitest';

// Local imports
import { apiKeyEnvName, invalidateApiKeyCache } from '@model/apiProviders';
import * as apiProviders from '@model/apiProviders';
import { SecretsFailed } from '@platform/secrets';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { ProbeEnvironmentTool } from '@tools/setup/ProbeEnvironmentTool';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

const mocks = vi.hoisted(() => ({
  locateTool:
    vi.fn<
      (
        name: string,
      ) => Effect.Effect<
        { name: string; installed: boolean; path?: string },
        unknown
      >
    >(),
}));

vi.mock('@tools/setup/toolProbing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tools/setup/toolProbing')>()),
  locateTool: mocks.locateTool,
}));

function outputOf(result: { output?: string }): string {
  return result.output ?? '';
}

setupPlatform({}, { setup: createFakeSetupPlatform() });

beforeEach(() => {
  // The `Secrets` service is one stable object over whichever fake host is
  // installed, so the API-key lookup cache it keys on outlives a host swap.
  invalidateApiKeyCache();
  // The default fake host has no credentials at all, so the aggregate probe
  // answers false without any stubbing; each test seeds what it needs.
  mocks.locateTool.mockReset().mockImplementation((name) =>
    Effect.succeed({
      name,
      installed: true,
      path: '/test/tool',
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setup credential reporting', () => {
  it.effect(
    'reports the active host and provider-key origin without secret values',
    () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          installPlatform(
            {
              env: { [apiKeyEnvName('deepseek')]: 'private-test-value' },
            },
            { setup: createFakeSetupPlatform() },
          ),
        );

        const result = yield* ProbeEnvironmentTool.call({}).pipe(
          Effect.provide(nativeToolTestLayer()),
        );

        assert.match(outputOf(result), /"host": "cli"/);
        assert.match(outputOf(result), /"provider": "deepseek"/);
        assert.match(outputOf(result), /"origin": "env"/);
        assert.match(outputOf(result), /provider API key in environment/);
        assert.doesNotMatch(outputOf(result), /private-test-value/);
      }),
  );

  it.effect('keeps probing when one provider key origin is unavailable', () =>
    Effect.gen(function* () {
      vi.spyOn(apiProviders, 'lookupApiKeyOrigin').mockReturnValue(
        Effect.fail(
          new SecretsFailed({
            reason: 'io',
            operation: 'get',
            message: 'Keychain unavailable',
          }),
        ),
      );

      const result = yield* ProbeEnvironmentTool.call({}).pipe(
        Effect.provide(nativeToolTestLayer()),
      );

      assert.equal(result.status, 'executed');
      assert.match(outputOf(result), /"origin": "unknown"/);
      assert.match(outputOf(result), /provider API key status unavailable/);
      assert.match(outputOf(result), /"anyApiKeySet": false/);
      assert.match(outputOf(result), /"hasAnyUsableCredential": false/);
    }),
  );
});
