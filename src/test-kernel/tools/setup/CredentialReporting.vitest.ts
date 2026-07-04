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
});
