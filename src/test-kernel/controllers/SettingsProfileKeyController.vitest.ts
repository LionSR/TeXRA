import { strict as assert } from 'node:assert';

import { describe, it } from 'vitest';

import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';

import { createFakeUIHosts } from '../support/FakeHosts';
import { FakeSecrets } from '../support/FakePlatform';
import { installPlatform } from '../support/setupPlatform';

async function createController(options?: {
  inputResponses?: readonly (string | undefined)[];
  confirmResponses?: readonly boolean[];
  urls?: Record<string, string | undefined>;
  setError?: Error;
  deleteError?: Error;
}): Promise<{
  controller: SettingsProfileKeyController;
  hosts: ReturnType<typeof createFakeUIHosts>;
  secrets: FakeSecrets;
  deleted: string[];
  failures: string[];
  refreshCount: () => number;
}> {
  const hosts = createFakeUIHosts({
    inputResponses: options?.inputResponses,
    confirmResponses: options?.confirmResponses ?? [true],
  });
  const secrets = new FakeSecrets();
  const deleted: string[] = [];
  const failures: string[] = [];
  let refreshCount = 0;

  const originalSet = secrets.set.bind(secrets);
  secrets.set = async (key, value) => {
    if (options?.setError) throw options.setError;
    await originalSet(key, value);
  };
  const originalDelete = secrets.delete.bind(secrets);
  secrets.delete = async (key) => {
    if (options?.deleteError) throw options.deleteError;
    deleted.push(key);
    await originalDelete(key);
  };
  await installPlatform({}, { secrets });

  return {
    controller: new SettingsProfileKeyController({
      prompt: hosts.prompt,
      externalOpener: hosts.externalOpener,
      getProviderDisplayName: (provider) =>
        provider === 'openai' ? 'OpenAI' : provider,
      getProviderKeyUrl: (provider) => options?.urls?.[provider],
      refreshAfterKeyChange: async () => {
        refreshCount += 1;
      },
      reportFailure: async (message, error) => {
        failures.push(`${message}: ${String(error)}`);
      },
    }),
    hosts,
    secrets,
    deleted,
    failures,
    refreshCount: () => refreshCount,
  };
}

describe('SettingsProfileKeyController', () => {
  it('stores provider keys and refreshes dependent state', async () => {
    const { controller, hosts, secrets, refreshCount } = await createController(
      {
        inputResponses: ['  sk-real-openai-key  '],
      },
    );

    await controller.setProviderKey('openai');

    assert.equal(await secrets.get('apiKey.openai'), 'sk-real-openai-key');
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
    const { controller, secrets, refreshCount, hosts } = await createController(
      {
        inputResponses: [undefined],
      },
    );

    await controller.setProviderKey('openai');

    assert.equal(await secrets.get('apiKey.openai'), undefined);
    assert.equal(refreshCount(), 0);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  // Regression pin: the placeholder guard used to live only in the CLI, so the
  // graphical hosts happily wrote `sk-xxxxxx` into the secret store.
  it('reports a placeholder key instead of storing it', async () => {
    const { controller, secrets, failures, refreshCount } =
      await createController();

    await controller.commitProviderKey('openai', 'sk-xxxxxx');

    assert.equal(await secrets.get('apiKey.openai'), undefined);
    assert.equal(refreshCount(), 0);
    assert.match(failures[0] ?? '', /Failed to set OpenAI API key/);
    assert.match(failures[0] ?? '', /looks like a placeholder/);
  });

  it('removes provider keys after confirmation and refreshes dependent state', async () => {
    const { controller, deleted, refreshCount, hosts } =
      await createController();

    await controller.removeProviderKey('openai');

    assert.deepEqual(deleted, ['apiKey.openai']);
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
    const { controller, deleted, refreshCount, hosts } = await createController(
      {
        confirmResponses: [false],
      },
    );

    await controller.removeProviderKey('openai');

    assert.deepEqual(deleted, []);
    assert.equal(refreshCount(), 0);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  it('commits a provider key without prompting for input', async () => {
    const { controller, hosts, secrets, refreshCount } =
      await createController();

    await controller.commitProviderKey('openai', '  sk-direct-secret  ');

    assert.equal(await secrets.get('apiKey.openai'), 'sk-direct-secret');
    assert.equal(hosts.prompt.inputs.length, 0);
    assert.equal(refreshCount(), 1);
    assert.equal(
      hosts.prompt.messages.at(-1)?.message,
      'OpenAI API key has been set',
    );
  });

  it('does nothing when committing an empty provider key', async () => {
    const { controller, secrets, refreshCount, hosts } =
      await createController();

    await controller.commitProviderKey('openai', '');

    assert.equal(await secrets.get('apiKey.openai'), undefined);
    assert.equal(refreshCount(), 0);
    assert.equal(hosts.prompt.messages.length, 0);
  });

  it('opens provider key URLs when configured', async () => {
    const { controller, hosts } = await createController({
      urls: { openai: 'https://platform.openai.com/api-keys' },
    });

    await controller.openProviderKeyUrl('openai');

    assert.deepEqual(hosts.externalOpener.externalUrls, [
      'https://platform.openai.com/api-keys',
    ]);
  });

  it('skips opening missing provider key URLs', async () => {
    const { controller, hosts } = await createController();

    await controller.openProviderKeyUrl('unknown');

    assert.deepEqual(hosts.externalOpener.externalUrls, []);
  });

  it('does not refresh when secret storage fails', async () => {
    const error = new Error('write failed');
    const { controller, refreshCount, failures } = await createController({
      inputResponses: ['sk-real-openai-key'],
      setError: error,
    });

    await controller.setProviderKey('openai');

    assert.match(failures[0] ?? '', /Failed to set OpenAI API key/);
    assert.equal(refreshCount(), 0);
  });

  it('does not refresh when secret deletion fails', async () => {
    const error = new Error('delete failed');
    const { controller, refreshCount, deleted, failures } =
      await createController({ deleteError: error });

    await controller.removeProviderKey('openai');

    assert.match(failures[0] ?? '', /Failed to remove OpenAI API key/);
    assert.deepEqual(deleted, []);
    assert.equal(refreshCount(), 0);
  });
});
