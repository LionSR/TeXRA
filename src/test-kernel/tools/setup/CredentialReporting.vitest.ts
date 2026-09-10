// Third-party imports
import { strict as assert } from 'node:assert';
import { Effect } from 'effect';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

// Local imports
import { ProbeEnvironmentTool } from '@tools/setup/ProbeEnvironmentTool';
import { VerifySetupTool } from '@tools/setup/VerifySetupTool';
import * as setupPlatformModule from '@tools/setup/platform';
import { setSetupPlatform } from '@tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

const mocks = vi.hoisted(() => ({
  apiKeyOrigin:
    vi.fn<
      () => Effect.Effect<'secret' | 'env' | 'none' | 'unknown', unknown>
    >(),
  anyUsableCredentialExists: vi.fn<() => Effect.Effect<boolean, unknown>>(),
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

vi.mock('@tools/setup/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tools/setup/platform')>();
  return {
    ...actual,
    setupSecrets: {
      ...actual.setupSecrets,
      providers: ['deepseek'],
      apiKeyOrigin: mocks.apiKeyOrigin,
      anyUsableCredentialExists: mocks.anyUsableCredentialExists,
    },
  };
});

function outputOf(result: { output?: string }): string {
  return result.output ?? '';
}

function installChatGptOnlySetupPlatform(): void {
  mocks.anyUsableCredentialExists.mockReturnValue(Effect.succeed(true));
  vi.spyOn(setupPlatformModule, 'getChatGptSubscriptionStatus').mockReturnValue(
    Effect.succeed({ signedIn: true, enabled: true }),
  );
}

beforeEach(() => {
  setSetupPlatform(createFakeSetupPlatform());
  mocks.apiKeyOrigin.mockReset().mockReturnValue(Effect.succeed('none'));
  mocks.anyUsableCredentialExists
    .mockReset()
    .mockReturnValue(Effect.succeed(false));
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
    mocks.apiKeyOrigin.mockReturnValue(Effect.succeed('env'));

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
    mocks.apiKeyOrigin.mockReturnValue(
      Effect.fail(new Error('Keychain unavailable')),
    );
    mocks.anyUsableCredentialExists.mockReturnValue(
      Effect.fail(new Error('Credential scan unavailable')),
    );

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(outputOf(result), /"origin": "unknown"/);
    assert.match(outputOf(result), /provider API key status unavailable/);
    assert.match(outputOf(result), /"anyApiKeySet": false/);
    assert.match(outputOf(result), /"usableCredentialStatus": "unknown"/);
  });

  it('reports when aggregate credential readiness is unavailable', async () => {
    mocks.anyUsableCredentialExists.mockReturnValue(
      Effect.fail(new Error('Credential scan unavailable')),
    );

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
