// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports
import { ProbeEnvironmentTool } from '@tools/setup/ProbeEnvironmentTool';
import { VerifySetupTool } from '@tools/setup/VerifySetupTool';
import { setSetupPlatform } from '@tools/setup/platform';

// Local file imports
import { createFakeSetupPlatform } from './fixtures';

function installChatGptOnlySetupPlatform(): void {
  const platform = createFakeSetupPlatform();
  setSetupPlatform({
    ...platform,
    secrets: {
      ...platform.secrets,
      async anyUsableCredentialExists() {
        return true;
      },
    },
    modelAccess: {
      async getChatGptSubscriptionStatus() {
        return {
          signedIn: true,
          enabled: true,
        };
      },
    },
  });
}

async function assertAuthPrecedesCredentialProbe(
  run: () => Promise<unknown>,
): Promise<void> {
  const calls: string[] = [];
  const platform = createFakeSetupPlatform();
  setSetupPlatform({
    ...platform,
    auth: {
      async getStatus() {
        calls.push('auth');
        return {
          authenticated: false,
          remoteAgentCatalogAvailable: false,
        };
      },
    },
    secrets: {
      ...platform.secrets,
      async anyUsableCredentialExists() {
        calls.push('credential');
        return false;
      },
    },
  });

  await run();

  assert.deepEqual(calls, ['auth', 'credential']);
}

describe('setup credential reporting', () => {
  it('reports the active host and provider-key origin without secret values', async () => {
    const platform = createFakeSetupPlatform({ host: 'cli' });
    setSetupPlatform({
      ...platform,
      secrets: {
        ...platform.secrets,
        providers: ['deepseek'],
        async apiKeyOrigin() {
          return 'env';
        },
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
    assert.match(result.output ?? '', /"hasAnyUsableCredential": true/);
    assert.match(result.output ?? '', /"anyApiKeySet": false/);
    assert.match(result.output ?? '', /"chatGptSubscription"/);
    assert.match(result.output ?? '', /"enabled": true/);
    assert.doesNotMatch(result.output ?? '', /researcher@example\.com/);
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
