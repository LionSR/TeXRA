// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { beforeEach, describe, it, vi } from 'vitest';

// Local imports
import { apiKeySecretName } from '@model/apiProviders';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';
import { ListApiKeysTool } from '@tools/setup/ListApiKeysTool';

const mocks = vi.hoisted(() => ({
  listStoredKeys: vi.fn<() => Promise<readonly string[]>>(),
}));

vi.mock('@tools/setup/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tools/setup/platform')>();
  return {
    ...actual,
    setupSecrets: {
      ...actual.setupSecrets,
      providers: ['anthropic', 'openai'],
      listStoredKeys: mocks.listStoredKeys,
    },
  };
});

const tool = new ListApiKeysTool();

type ToolCallResult = Awaited<ReturnType<ListApiKeysTool['call']>>;

beforeEach(() => {
  mocks.listStoredKeys.mockReset();
});

async function callWithStoredKeys(
  keys: readonly string[],
): Promise<ToolCallResult> {
  mocks.listStoredKeys.mockResolvedValue(keys);
  const result = await tool.call({});
  assert.equal(result.status, 'executed');
  return result;
}

function outputOf(result: ToolCallResult): string {
  return result.output ?? '';
}

describe('list_api_keys tool', () => {
  it('reports an empty credential store', async () => {
    const result = await callWithStoredKeys([]);
    assert.equal(result.summary, 'No secrets stored');
    assert.match(outputOf(result), /credential store is empty/);
  });

  it('reports unsupported enumeration instead of an empty store', async () => {
    mocks.listStoredKeys.mockRejectedValue(
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

  it('lists providers without a stored key', async () => {
    const result = await callWithStoredKeys([apiKeySecretName('anthropic')]);
    assert.match(outputOf(result), /Providers without a key in TeXRA secrets/);
    assert.match(outputOf(result), /openai/);
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

  it('categorises all key types simultaneously', async () => {
    const result = await callWithStoredKeys([
      apiKeySecretName('anthropic'),
      GITHUB_TOKEN_STORAGE_KEY,
      'apiKey.oldprovider',
      'texra.supabase.session',
    ]);
    assert.match(outputOf(result), /Provider API keys stored/);
    assert.match(outputOf(result), /GitHub token: stored/);
    assert.match(outputOf(result), /Unrecognised apiKey\.\*/);
    assert.match(outputOf(result), /Other stored secrets: 1 redacted key name/);
    assert.doesNotMatch(outputOf(result), /texra\.supabase\.session/);
  });

  it('summary counts reflect platform.secrets.providers, not the global import', async () => {
    const result = await callWithStoredKeys([apiKeySecretName('anthropic')]);
    assert.equal(
      result.summary,
      '1 stored secret: 1/2 persisted provider API keys',
    );
  });

  it('summary uses plural form for multiple secrets', async () => {
    const result = await callWithStoredKeys([
      apiKeySecretName('anthropic'),
      apiKeySecretName('openai'),
    ]);
    assert.equal(
      result.summary,
      '2 stored secrets: 2/2 persisted provider API keys',
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

  it('summary reads "no provider keys" when only non-provider secrets are stored', async () => {
    const result = await callWithStoredKeys(['texra.supabase.session']);
    assert.match(result.summary ?? '', /no persisted provider API keys/);
  });
});
