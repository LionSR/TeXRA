// Third-party imports
import { strict as assert } from 'node:assert';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

// Local imports
import { apiKeyEnvName, invalidateApiKeyCache } from '@model/apiProviders';
import * as apiProviders from '@model/apiProviders';
import * as setupCredentialAccess from '@model/setupCredentialAccess';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { ProbeEnvironmentTool } from '@tools/setup/ProbeEnvironmentTool';
import { VerifySetupTool } from '@tools/setup/VerifySetupTool';
import * as setupPlatformModule from '@tools/setup/platform';

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

/**
 * No provider key anywhere, but the aggregate readiness probe reports a
 * usable credential: the ChatGPT-subscription-only shape.
 */
function installChatGptOnlySetupPlatform(): void {
  vi.spyOn(setupCredentialAccess, 'hasUsableSetupCredential').mockResolvedValue(
    true,
  );
  vi.spyOn(setupPlatformModule, 'getChatGptSubscriptionStatus').mockReturnValue(
    Effect.succeed({ signedIn: true, enabled: true }),
  );
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
  it('reports the active host and provider-key origin without secret values', async () => {
    await installPlatform(
      { secretsEnv: { [apiKeyEnvName('deepseek')]: 'private-test-value' } },
      { setup: createFakeSetupPlatform() },
    );

    const result = await new ProbeEnvironmentTool().call({});

    assert.match(outputOf(result), /"host": "cli"/);
    assert.match(outputOf(result), /"provider": "deepseek"/);
    assert.match(outputOf(result), /"origin": "env"/);
    assert.match(outputOf(result), /provider API key in environment/);
    assert.doesNotMatch(outputOf(result), /private-test-value/);
  });

  it('reports a usable non-API-key credential in the environment probe headline', async () => {
    installChatGptOnlySetupPlatform();

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(outputOf(result), /credentials: ChatGPT subscription enabled/);
    assert.doesNotMatch(
      outputOf(result),
      /ChatGPT subscription enabled \+ usable credential/,
    );
    assert.match(outputOf(result), /"hasAnyUsableCredential": true/);
    assert.match(outputOf(result), /"anyApiKeySet": false/);
    assert.match(outputOf(result), /"chatGptSubscription"/);
    assert.match(outputOf(result), /"enabled": true/);
    assert.doesNotMatch(outputOf(result), /researcher@example\.com/);
  });

  it('keeps probing when one provider key origin is unavailable', async () => {
    vi.spyOn(apiProviders, 'lookupApiKeyOrigin').mockRejectedValue(
      new Error('Keychain unavailable'),
    );
    vi.spyOn(
      setupCredentialAccess,
      'hasUsableSetupCredential',
    ).mockRejectedValue(new Error('Credential scan unavailable'));

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(outputOf(result), /"origin": "unknown"/);
    assert.match(outputOf(result), /provider API key status unavailable/);
    assert.match(outputOf(result), /"anyApiKeySet": false/);
    assert.match(outputOf(result), /"usableCredentialStatus": "unknown"/);
  });

  it('reports when aggregate credential readiness is unavailable', async () => {
    vi.spyOn(
      setupCredentialAccess,
      'hasUsableSetupCredential',
    ).mockRejectedValue(new Error('Credential scan unavailable'));

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(outputOf(result), /overall credential status unavailable/);
    assert.match(outputOf(result), /"usableCredentialStatus": "unknown"/);
  });

  it('reports a usable non-API-key credential in setup verification', async () => {
    installChatGptOnlySetupPlatform();

    const result = await new VerifySetupTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(
      outputOf(result),
      /Credentials: usable model credential available\./,
    );
  });
});
