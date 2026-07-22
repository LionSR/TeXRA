// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { beforeEach, describe, it, vi } from 'vitest';

// Local imports
import { apiKeySecretName } from '@model/apiProviders';
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';
import { ListApiKeysTool } from '@tools/setup/ListApiKeysTool';

const FAKE_PROVIDERS = ['anthropic', 'openai'] as const;
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

function installPlatform(
  listStoredKeys: () => Promise<readonly string[]>,
): void {
  mocks.listStoredKeys.mockImplementation(listStoredKeys);
}

function installPlatformWithKeys(keys: readonly string[]): void {
  installPlatform(async () => keys);
}

const tool = new ListApiKeysTool();

beforeEach(() => {
  mocks.listStoredKeys.mockReset();
});

describe('list_api_keys tool', () => {
  it('reports an empty credential store', async () => {
    installPlatformWithKeys([]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.equal(result.summary, 'No secrets stored');
    assert.match(result.output ?? '', /credential store is empty/);
  });

  it('reports unsupported enumeration instead of an empty store', async () => {
    installPlatform(async () => {
      throw new Error('SecretStorage key enumeration is not supported');
    });

    const result = await tool.call({});

    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /enumeration is not supported/);
    assert.doesNotMatch(result.output ?? '', /credential store is empty/);
  });

  it('shows known provider keys by provider name, not raw storage key', async () => {
    installPlatformWithKeys([apiKeySecretName('anthropic')]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /Provider API keys stored/);
    assert.match(result.output ?? '', /^\s+anthropic$/m);
    assert.doesNotMatch(result.output ?? '', /apiKey\.anthropic/);
  });

  it('lists providers without a stored key', async () => {
    installPlatformWithKeys([apiKeySecretName('anthropic')]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(
      result.output ?? '',
      /Providers without a key in TeXRA secrets/,
    );
    assert.match(result.output ?? '', /openai/);
  });

  it('recognises the GitHub token', async () => {
    installPlatformWithKeys([GITHUB_TOKEN_STORAGE_KEY]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /GitHub token: stored/);
  });

  it('reports stale apiKey.* entries as diagnostic rather than removable providers', async () => {
    installPlatformWithKeys(['apiKey.oldprovider']);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /diagnostic only/);
    assert.match(result.output ?? '', /not unset_api_key providers/);
    assert.match(result.output ?? '', /apiKey\.oldprovider/);
  });

  it('redacts non-provider non-github secret key names under Other', async () => {
    installPlatformWithKeys(['texra.supabase.session']);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(
      result.output ?? '',
      /Other stored secrets: 1 redacted key name/,
    );
    assert.doesNotMatch(result.output ?? '', /texra\.supabase\.session/);
  });

  it('categorises all key types simultaneously', async () => {
    installPlatformWithKeys([
      apiKeySecretName('anthropic'),
      GITHUB_TOKEN_STORAGE_KEY,
      'apiKey.oldprovider',
      'texra.supabase.session',
    ]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(result.output ?? '', /Provider API keys stored/);
    assert.match(result.output ?? '', /GitHub token: stored/);
    assert.match(result.output ?? '', /Unrecognised apiKey\.\*/);
    assert.match(
      result.output ?? '',
      /Other stored secrets: 1 redacted key name/,
    );
    assert.doesNotMatch(result.output ?? '', /texra\.supabase\.session/);
  });

  it('summary counts reflect platform.secrets.providers, not the global import', async () => {
    installPlatformWithKeys([apiKeySecretName('anthropic')]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.equal(
      result.summary,
      '1 stored secret: 1/2 persisted provider API keys',
    );
  });

  it('summary uses plural form for multiple secrets', async () => {
    installPlatformWithKeys([
      apiKeySecretName('anthropic'),
      apiKeySecretName('openai'),
    ]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.equal(
      result.summary,
      '2 stored secrets: 2/2 persisted provider API keys',
    );
  });

  it('shows missing providers even when no provider keys are stored', async () => {
    installPlatformWithKeys([GITHUB_TOKEN_STORAGE_KEY]);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(
      result.output ?? '',
      /No provider API keys persisted in TeXRA secrets/,
    );
    assert.match(
      result.output ?? '',
      /Providers without a key in TeXRA secrets/,
    );
    assert.match(result.output ?? '', /anthropic/);
    assert.match(result.output ?? '', /openai/);
  });

  it('summary reads "no provider keys" when only non-provider secrets are stored', async () => {
    installPlatformWithKeys(['texra.supabase.session']);
    const result = await tool.call({});
    assert.equal(result.status, 'executed');
    assert.match(result.summary ?? '', /no persisted provider API keys/);
  });
});
