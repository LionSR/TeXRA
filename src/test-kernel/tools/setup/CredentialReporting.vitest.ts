// Node imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, vi } from 'vitest';

// Local imports
import * as apiProviders from '@texra-ai/llm';
import { apiKeyEnvName, SecretsFailed } from '@texra-ai/llm';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  hostStores,
  installPlatform,
  setupPlatform,
} from '@test/support/setupPlatform';
import * as setupCredentialAccess from '@texra/model/setupCredentialAccess';
import * as githubAuth from '@texra/tools/github/githubAuth';
import { ProbeEnvironmentTool } from '@texra/tools/setup/ProbeEnvironmentTool';
import * as setupPlatformModule from '@texra/tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform, withSetup } from './fixtures';

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

vi.mock('@texra/tools/setup/toolProbing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@texra/tools/setup/toolProbing')>()),
  locateTool: mocks.locateTool,
}));

function outputOf(result: { output?: string }): string {
  return result.output ?? '';
}

/**
 * No provider key anywhere, but the aggregate readiness probe reports a
 * usable credential: the ChatGPT-subscription-only shape.
 */
function installChatGptOnlySetupPlatform(): void {
  vi.spyOn(setupCredentialAccess, 'hasUsableSetupCredential').mockReturnValue(
    Effect.succeed(true),
  );
  vi.spyOn(setupPlatformModule, 'getChatGptSubscriptionStatus').mockReturnValue(
    Effect.succeed({ signedIn: true, enabled: true }),
  );
}

setupPlatform({}, { setup: createFakeSetupPlatform() });

beforeEach(() => {
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
              host: 'cli',
            },
            { setup: createFakeSetupPlatform() },
          ),
        );
        const result = yield* ProbeEnvironmentTool.call({}).pipe(
          Effect.provide(withSetup(nativeToolTestLayer())),
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
        Effect.provide(withSetup(nativeToolTestLayer())),
      );

      assert.equal(result.status, 'executed');
      assert.match(outputOf(result), /"origin": "unknown"/);
      assert.match(outputOf(result), /provider API key status unavailable/);
      assert.match(outputOf(result), /"anyApiKeySet": false/);
      assert.match(outputOf(result), /"hasAnyUsableCredential": false/);
    }),
  );

  it.effect('reports a usable non-API-key credential', () =>
    Effect.gen(function* () {
      installChatGptOnlySetupPlatform();

      const result = yield* ProbeEnvironmentTool.call({}).pipe(
        Effect.provide(withSetup(nativeToolTestLayer())),
      );

      assert.equal(result.status, 'executed');
      assert.match(outputOf(result), /"anyApiKeySet": false/);
      assert.match(outputOf(result), /"hasAnyUsableCredential": true/);
      assert.match(outputOf(result), /ChatGPT subscription enabled/);
    }),
  );

  it.effect(
    'reports an unreadable credential store instead of an empty one',
    () =>
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

        const result = yield* ProbeEnvironmentTool.call({}).pipe(
          Effect.provide(withSetup(nativeToolTestLayer())),
        );

        assert.equal(result.status, 'executed');
        assert.match(outputOf(result), /"storedSecrets": "unavailable"/);
        assert.match(outputOf(result), /credential store unreadable/);
      }),
  );

  it.effect(
    'reports an unreadable GitHub token as unknown, not as a stale entry',
    () =>
      Effect.gen(function* () {
        yield* Effect.tryPromise(() =>
          installPlatform(
            { secrets: { 'github.token': 'stored-value' } },
            { setup: createFakeSetupPlatform() },
          ),
        );
        vi.spyOn(githubAuth, 'resolveGitHubTokenSource').mockReturnValue(
          Effect.fail(
            new SecretsFailed({
              reason: 'io',
              operation: 'get',
              message: 'The token file could not be read',
            }),
          ),
        );

        const result = yield* ProbeEnvironmentTool.call({}).pipe(
          Effect.provide(withSetup(nativeToolTestLayer())),
        );

        assert.match(outputOf(result), /"githubToken": "unknown"/);
        assert.doesNotMatch(outputOf(result), /"github\.token"/);
      }),
  );

  it.effect('names stale apiKey.* entries and redacts other secret names', () =>
    Effect.gen(function* () {
      yield* Effect.tryPromise(() =>
        installPlatform(
          {
            secrets: {
              'apiKey.retired-provider': 'stored-value',
              'apiKey.openai': '   ',
              'github.token': '  ',
              'texra.other.secret': 'stored-value',
            },
          },
          { setup: createFakeSetupPlatform() },
        ),
      );
      const result = yield* ProbeEnvironmentTool.call({}).pipe(
        Effect.provide(withSetup(nativeToolTestLayer())),
      );

      assert.match(outputOf(result), /"apiKey\.retired-provider"/);
      // A known provider's blank entry is not a saved key, so it is stale too.
      assert.match(outputOf(result), /"apiKey\.openai"/);
      assert.match(outputOf(result), /"github\.token"/);
      assert.match(outputOf(result), /"otherRedactedCount": 1/);
      assert.doesNotMatch(outputOf(result), /texra\.other\.secret/);
      assert.doesNotMatch(outputOf(result), /stored-value/);
    }),
  );
});
