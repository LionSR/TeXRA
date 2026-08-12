// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

// Local imports
import { ProbeEnvironmentTool } from '@tools/setup/ProbeEnvironmentTool';
import { VerifySetupTool } from '@tools/setup/VerifySetupTool';
import * as setupPlatformModule from '@tools/setup/platform';
import { setSetupPlatform } from '@tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

const mocks = vi.hoisted(() => ({
  apiKeyOrigin: vi.fn<() => Promise<'secret' | 'env' | 'none' | 'unknown'>>(),
  anyUsableCredentialExists: vi.fn<() => Promise<boolean>>(),
  locateTool:
    vi.fn<
      (
        name: string,
      ) => Promise<{ name: string; installed: boolean; path?: string }>
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
  mocks.anyUsableCredentialExists.mockResolvedValue(true);
  vi.spyOn(
    setupPlatformModule,
    'getChatGptSubscriptionStatus',
  ).mockResolvedValue({ signedIn: true, enabled: true });
}

async function assertAuthPrecedesCredentialProbe(
  run: () => Promise<unknown>,
): Promise<void> {
  const calls: string[] = [];
  vi.spyOn(setupPlatformModule, 'getSetupAuthStatus').mockImplementation(
    async () => {
      calls.push('auth');
      return {
        authenticated: false,
        remoteAgentCatalogAvailable: false,
      };
    },
  );
  mocks.anyUsableCredentialExists.mockImplementation(async () => {
    calls.push('credential');
    return false;
  });

  await run();

  assert.deepEqual(calls, ['auth', 'credential']);
}

beforeEach(() => {
  setSetupPlatform(createFakeSetupPlatform());
  mocks.apiKeyOrigin.mockReset().mockResolvedValue('none');
  mocks.anyUsableCredentialExists.mockReset().mockResolvedValue(false);
  mocks.locateTool.mockReset().mockImplementation(async (name) => ({
    name,
    installed: true,
    path: '/test/tool',
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('setup credential reporting', () => {
  it('reports the active host and provider-key origin without secret values', async () => {
    mocks.apiKeyOrigin.mockResolvedValue('env');

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
    mocks.apiKeyOrigin.mockRejectedValue(new Error('Keychain unavailable'));
    mocks.anyUsableCredentialExists.mockRejectedValue(
      new Error('Credential scan unavailable'),
    );

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(outputOf(result), /"origin": "unknown"/);
    assert.match(outputOf(result), /provider API key status unavailable/);
    assert.match(outputOf(result), /"anyApiKeySet": false/);
    assert.match(outputOf(result), /"usableCredentialStatus": "unknown"/);
  });

  it('reports when aggregate credential readiness is unavailable', async () => {
    mocks.anyUsableCredentialExists.mockRejectedValue(
      new Error('Credential scan unavailable'),
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

  it.each([
    {
      probe: 'environment',
      run: () => new ProbeEnvironmentTool().call({}),
    },
    {
      probe: 'setup',
      run: () => new VerifySetupTool().call({}),
    },
  ])(
    'settles authentication before the $probe credential probe',
    async ({ run }) => {
      await assertAuthPrecedesCredentialProbe(run);
    },
  );
});
