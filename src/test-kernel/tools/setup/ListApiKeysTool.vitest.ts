// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it, vi } from 'vitest';

// Local imports
import { API_PROVIDERS, apiKeySecretName } from '@model/apiProviders';
import { platform } from '@platform/platform';
import { installPlatform, setupPlatform } from '@test/support/setupPlatform';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';
import { ListApiKeysTool } from '@tools/setup/ListApiKeysTool';

const tool = new ListApiKeysTool();

type ToolCallResult = Awaited<ReturnType<ListApiKeysTool['call']>>;

setupPlatform();

/** Seed the fake host's credential store with exactly `keys`, then audit it. */
async function callWithStoredKeys(
  keys: readonly string[],
): Promise<ToolCallResult> {
  await installPlatform({
    secrets: Object.fromEntries(keys.map((key) => [key, 'stored-value'])),
  });
  const result = await tool.call({});
  assert.equal(result.status, 'executed');
  return result;
}

function outputOf(result: ToolCallResult): string {
  return result.output ?? '';
}

describe('list_api_keys tool', () => {
  it('reports unsupported enumeration instead of an empty store', async () => {
    vi.spyOn(platform().secrets, 'listStoredKeys').mockRejectedValue(
      new Error('SecretStorage key enumeration is not supported'),
    );

    const result = await tool.call({});

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /enumeration is not supported/);
    assert.doesNotMatch(outputOf(result), /credential store is empty/);
  });

  it('shows known provider keys by provider name, not raw storage key', async () => {
    const result = await callWithStoredKeys([apiKeySecretName('anthropic')]);
    assert.match(outputOf(result), /Provider API keys stored/);
    assert.match(outputOf(result), /^\s+anthropic$/m);
    assert.doesNotMatch(outputOf(result), /apiKey\.anthropic/);
  });

  it('recognises the GitHub token', async () => {
    const result = await callWithStoredKeys([GITHUB_TOKEN_STORAGE_KEY]);
    assert.match(outputOf(result), /GitHub token: stored/);
  });

  it('reports stale apiKey.* entries as diagnostic rather than removable providers', async () => {
    const result = await callWithStoredKeys(['apiKey.oldprovider']);
    assert.match(outputOf(result), /diagnostic only/);
    assert.match(outputOf(result), /not unset_api_key providers/);
    assert.match(outputOf(result), /apiKey\.oldprovider/);
  });

  it('redacts non-provider non-github secret key names under Other', async () => {
    const result = await callWithStoredKeys(['texra.supabase.session']);
    assert.match(outputOf(result), /Other stored secrets: 1 redacted key name/);
    assert.doesNotMatch(outputOf(result), /texra\.supabase\.session/);
  });

  it('counts stored provider keys against the full provider catalog', async () => {
    const result = await callWithStoredKeys([apiKeySecretName('anthropic')]);
    assert.equal(
      result.summary,
      `1 stored secret: 1/${API_PROVIDERS.length} persisted provider API keys`,
    );
  });

  it('shows missing providers even when no provider keys are stored', async () => {
    const result = await callWithStoredKeys([GITHUB_TOKEN_STORAGE_KEY]);
    assert.match(
      outputOf(result),
      /No provider API keys persisted in TeXRA secrets/,
    );
    assert.match(outputOf(result), /Providers without a key in TeXRA secrets/);
    assert.match(outputOf(result), /anthropic/);
    assert.match(outputOf(result), /openai/);
  });
});
