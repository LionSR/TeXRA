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
  it('reports a usable non-API-key credential in the environment probe headline', async () => {
    installChatGptOnlySetupPlatform();

    const result = await new ProbeEnvironmentTool().call({});

    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /credentials: usable credential/);
    assert.match(result.output ?? '', /"hasAnyUsableCredential": true/);
    assert.match(result.output ?? '', /"anyApiKeySet": false/);
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
