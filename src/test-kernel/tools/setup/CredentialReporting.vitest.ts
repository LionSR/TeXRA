// Third-party imports
import { strict as assert } from 'node:assert';
import { afterEach, describe, it, vi } from 'vitest';

// Local imports
import { ProbeEnvironmentTool } from '@tools/setup/ProbeEnvironmentTool';
import { VerifySetupTool } from '@tools/setup/VerifySetupTool';
import * as setupPlatformModule from '@tools/setup/platform';
import { setSetupPlatform, setupSecrets } from '@tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

const ORIGINAL_PROVIDERS = setupSecrets.providers;

function installSetupPlatformWithSecrets(options: {
  providers?: typeof setupSecrets.providers;
  apiKeyOrigin?: typeof setupSecrets.apiKeyOrigin;
  anyUsableCredentialExists?: typeof setupSecrets.anyUsableCredentialExists;
}): void {
  setSetupPlatform(createFakeSetupPlatform());
  if (options.providers) {
    Object.defineProperty(setupSecrets, 'providers', {
      configurable: true,
      value: options.providers,
    });
  }
  if (options.apiKeyOrigin) {
    vi.spyOn(setupSecrets, 'apiKeyOrigin').mockImplementation(
      options.apiKeyOrigin,
    );
  }
  if (options.anyUsableCredentialExists) {
    vi.spyOn(setupSecrets, 'anyUsableCredentialExists').mockImplementation(
      options.anyUsableCredentialExists,
    );
  }
}

function installChatGptOnlySetupPlatform(): void {
  setSetupPlatform(createFakeSetupPlatform());
  vi.spyOn(setupSecrets, 'anyUsableCredentialExists').mockResolvedValue(true);
  vi.spyOn(
    setupPlatformModule,
    'getChatGptSubscriptionStatus',
  ).mockResolvedValue({ signedIn: true, enabled: true });
}

async function assertAuthPrecedesCredentialProbe(
  run: () => Promise<unknown>,
): Promise<void> {
  const calls: string[] = [];
  setSetupPlatform(createFakeSetupPlatform());
  vi.spyOn(setupPlatformModule, 'getSetupAuthStatus').mockImplementation(
    async () => {
      calls.push('auth');
      return {
        authenticated: false,
        remoteAgentCatalogAvailable: false,
      };
    },
  );
  vi.spyOn(setupSecrets, 'anyUsableCredentialExists').mockImplementation(
    async () => {
      calls.push('credential');
      return false;
    },
  );

  await run();

  assert.deepEqual(calls, ['auth', 'credential']);
}

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(setupSecrets, 'providers', {
    configurable: true,
    value: ORIGINAL_PROVIDERS,
  });
});

describe('setup credential reporting', () => {
  it('reports the active host and provider-key origin without secret values', async () => {
    installSetupPlatformWithSecrets({
      providers: ['deepseek'],
      async apiKeyOrigin() {
        return 'env';
      },
    });

    const result = await new ProbeEnvironmentTool().call({});

    assert.match(result.output ?? '', /"host": "cli"/);
    assert.match(result.output ?? '', /"provider": "deepseek"/);
    assert.match(result.output ?? '', /"origin": "env"/);
    assert.match(result.output ?? '', /provider API key in environment/);
    assert.doesNotMatch(result.output ?? '', /private-test-value/);
  });

  it('reports a usable non-API-key credential in the environment probe headline', async () => {
    installChatGptOnlySetupPlatform();

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(
      result.output ?? '',
      /credentials: ChatGPT subscription enabled/,
    );
    assert.doesNotMatch(
      result.output ?? '',
      /ChatGPT subscription enabled \+ usable credential/,
    );
    assert.match(result.output ?? '', /"hasAnyUsableCredential": true/);
    assert.match(result.output ?? '', /"anyApiKeySet": false/);
    assert.match(result.output ?? '', /"chatGptSubscription"/);
    assert.match(result.output ?? '', /"enabled": true/);
    assert.doesNotMatch(result.output ?? '', /researcher@example\.com/);
  });

  it('keeps probing when one provider key origin is unavailable', async () => {
    installSetupPlatformWithSecrets({
      providers: ['openai'],
      async apiKeyOrigin() {
        throw new Error('Keychain unavailable');
      },
      async anyUsableCredentialExists() {
        throw new Error('Credential scan unavailable');
      },
    });

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /"origin": "unknown"/);
    assert.match(result.output ?? '', /provider API key status unavailable/);
    assert.match(result.output ?? '', /"anyApiKeySet": false/);
    assert.match(result.output ?? '', /"usableCredentialStatus": "unknown"/);
  });

  it('reports when aggregate credential readiness is unavailable', async () => {
    installSetupPlatformWithSecrets({
      async anyUsableCredentialExists() {
        throw new Error('Credential scan unavailable');
      },
    });

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /overall credential status unavailable/);
    assert.match(result.output ?? '', /"usableCredentialStatus": "unknown"/);
  });

  it('reports a usable non-API-key credential in setup verification', async () => {
    installChatGptOnlySetupPlatform();

    const result = await new VerifySetupTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(
      result.output ?? '',
      /Credentials: usable model credential available\./,
    );
  });

  it('settles authentication before the environment credential probe', async () => {
    await assertAuthPrecedesCredentialProbe(() =>
      new ProbeEnvironmentTool().call({}),
    );
  });

  it('settles authentication before the setup credential probe', async () => {
    await assertAuthPrecedesCredentialProbe(() =>
      new VerifySetupTool().call({}),
    );
  });
});
