import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';

import { createFakeUIHosts } from '../support/FakeHosts';

function createController(options?: {
  inputResponses?: readonly (string | undefined)[];
  confirmResponses?: readonly boolean[];
  urls?: Record<string, string | undefined>;
  setError?: Error;
  deleteError?: Error;
}): {
  controller: SettingsProfileKeyController;
  hosts: ReturnType<typeof createFakeUIHosts>;
  secrets: Map<string, string>;
  deleted: string[];
  refreshCount: () => number;
} {
  const hosts = createFakeUIHosts({
    inputResponses: options?.inputResponses,
    confirmResponses: options?.confirmResponses ?? [true],
  });
  const secrets = new Map<string, string>();
  const deleted: string[] = [];
  let refreshCount = 0;

  return {
    controller: new SettingsProfileKeyController({
      prompt: hosts.prompt,
      externalOpener: hosts.externalOpener,
      getProviderDisplayName: (provider) =>
        provider === 'openai' ? 'OpenAI' : provider,
      getProviderKeyUrl: (provider) => options?.urls?.[provider],
      getApiKeySecretName: (provider) => `${provider}-secret`,
      setSecret: async (key, value) => {
        if (options?.setError) throw options.setError;
        secrets.set(key, value);
      },
      deleteSecret: async (key) => {
        if (options?.deleteError) throw options.deleteError;
        deleted.push(key);
        secrets.delete(key);
      },
      refreshAfterKeyChange: async () => {
        refreshCount += 1;
      },
    }),
    hosts,
    secrets,
    deleted,
    refreshCount: () => refreshCount,
  };
}

describe('SettingsProfileKeyController', () => {
  it('stores provider keys and refreshes dependent state', async () => {
    const { controller, hosts, secrets, refreshCount } = createController({
      inputResponses: ['  sk-test  '],
    });

    await controller.setProviderKey('openai');

    assert.equal(secrets.get('openai-secret'), 'sk-test');
    assert.equal(refreshCount(), 1);
    assert.equal(
      hosts.prompt.inputs[0]?.options.prompt,
      'Enter OpenAI API key',
    );
    assert.equal(hosts.prompt.inputs[0]?.options.password, true);
    assert.equal(
      hosts.prompt.messages.at(-1)?.message,
      'OpenAI API key has been set',
    );
  });

  it('does nothing when provider key input is cancelled', async () => {
    const { controller, secrets, refreshCount, hosts } = createController({
      inputResponses: [undefined],
    });

    await controller.setProviderKey('openai');

    assert.equal(secrets.size, 0);
    assert.equal(refreshCount(), 0);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  it('removes provider keys after confirmation and refreshes dependent state', async () => {
    const { controller, deleted, refreshCount, hosts } = createController();

    await controller.removeProviderKey('openai');

    assert.deepEqual(deleted, ['openai-secret']);
    assert.equal(refreshCount(), 1);
    assert.equal(
      hosts.prompt.confirms[0]?.message,
      'Remove the OpenAI API key? This cannot be undone.',
    );
    assert.equal(hosts.prompt.confirms[0]?.options?.modal, false);
    assert.equal(
      hosts.prompt.messages.at(-1)?.message,
      'OpenAI API key has been removed',
    );
  });

  it('does nothing when provider key removal is not confirmed', async () => {
    const { controller, deleted, refreshCount, hosts } = createController({
      confirmResponses: [false],
    });

    await controller.removeProviderKey('openai');

    assert.deepEqual(deleted, []);
    assert.equal(refreshCount(), 0);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  it('commits a provider key without prompting for input', async () => {
    const { controller, hosts, secrets, refreshCount } = createController();

    await controller.commitProviderKey('openai', '  sk-direct  ');

    assert.equal(secrets.get('openai-secret'), 'sk-direct');
    assert.equal(hosts.prompt.inputs.length, 0);
    assert.equal(refreshCount(), 1);
    assert.equal(
      hosts.prompt.messages.at(-1)?.message,
      'OpenAI API key has been set',
    );
  });

  it('does nothing when committing an empty provider key', async () => {
    const { controller, secrets, refreshCount, hosts } = createController();

    await controller.commitProviderKey('openai', '');

    assert.equal(secrets.size, 0);
    assert.equal(refreshCount(), 0);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  it('opens provider key URLs when configured', async () => {
    const { controller, hosts } = createController({
      urls: { openai: 'https://platform.openai.com/api-keys' },
    });

    await controller.openProviderKeyUrl('openai');

    assert.deepEqual(hosts.externalOpener.externalUrls, [
      'https://platform.openai.com/api-keys',
    ]);
  });

  it('skips opening missing provider key URLs', async () => {
    const { controller, hosts } = createController();

    await controller.openProviderKeyUrl('unknown');

    assert.deepEqual(hosts.externalOpener.externalUrls, []);
  });

  it('does not refresh when secret storage fails', async () => {
    const error = new Error('write failed');
    const { controller, refreshCount } = createController({
      inputResponses: ['sk-test'],
      setError: error,
    });

    await assert.rejects(() => controller.setProviderKey('openai'), error);
    assert.equal(refreshCount(), 0);
  });

  it('does not refresh when secret deletion fails', async () => {
    const error = new Error('delete failed');
    const { controller, refreshCount, deleted } = createController({
      deleteError: error,
    });

    await assert.rejects(() => controller.removeProviderKey('openai'), error);

    assert.deepEqual(deleted, []);
    assert.equal(refreshCount(), 0);
  });
});
