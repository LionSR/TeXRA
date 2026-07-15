// Third-party imports
import { strict as assert } from 'node:assert';
import { setImmediate } from 'node:timers/promises';
import { afterEach, describe, it, vi } from 'vitest';

// Local imports - tests
import { installPlatform } from '@test/support/setupPlatform';

// Local imports - auth
import * as serverKeysModule from '@auth/serverKeys';

// Local imports - desktop
import { createDesktopSettingsIpc } from '@desktop/main/desktopSettingsIpc';

// Local imports - model
import { apiKeySecretName } from '@model/apiProviders';

// Local imports - shared
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - desktop test support
import {
  createStubDesktopAgentSettingsController,
  createStubDesktopHistoryOptions,
} from './desktopSettingsTestSupport';

// Local imports - platform
import type { StateStore } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';

class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createSecrets(
  initial: Record<string, string> = {},
): PlatformSecrets & {
  deleted: string[];
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  const deleted: string[] = [];

  return {
    values,
    deleted,
    async get(key) {
      return values.get(key);
    },
    async getStored(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
    async delete(key) {
      deleted.push(key);
      values.delete(key);
    },
    async listStoredKeys() {
      return [...values.keys()];
    },
    getEnv() {
      return undefined;
    },
  };
}

async function createSettingsIpc(options: {
  confirm: boolean;
  secrets: PlatformSecrets;
  confirms: string[];
  infos: string[];
  onApiKeyChanged?: () => Promise<void>;
}) {
  await installPlatform(
    { workspacePath: '/workspace' },
    { secrets: options.secrets },
  );
  vi.spyOn(serverKeysModule, 'getServerSideKeyService').mockReturnValue({
    canUseServerSideKeys: async () => false,
    getUseIncludedModelAccess: () => false,
    wasQuotaAutoSwitched: () => false,
    isRelayQuotaExceeded: () => false,
    isProviderOnServer: () => false,
    canUseModelSync: () => false,
  } as unknown as ReturnType<typeof serverKeysModule.getServerSideKeyService>);

  return createDesktopSettingsIpc({
    ...createStubDesktopHistoryOptions(),
    postToRenderer: () => {},
    agentSettingsController: createStubDesktopAgentSettingsController(),
    globalState: new MemoryStateStore(),
    workspaceState: new MemoryStateStore(),
    secrets: options.secrets,
    modelListRefresh: Promise.resolve(),
    confirmAction: async (message) => {
      options.confirms.push(message);
      return options.confirm;
    },
    showInfoMessage: async (message) => {
      options.infos.push(message);
    },
    onApiKeyChanged: options.onApiKeyChanged,
  });
}

describe('createDesktopSettingsIpc provider keys', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a provider API key when removal is not confirmed', async () => {
    const secretName = apiKeySecretName('openai');
    const secrets = createSecrets({ [secretName]: 'sk-test' });
    const confirms: string[] = [];
    const infos: string[] = [];
    let refreshCount = 0;
    const ipc = await createSettingsIpc({
      confirm: false,
      secrets,
      confirms,
      infos,
      onApiKeyChanged: async () => {
        refreshCount += 1;
      },
    });

    const handled = ipc.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
      provider: 'openai',
    });
    await setImmediate();

    assert.equal(handled, true);
    assert.deepEqual(confirms, [
      'Remove the OpenAI API key? This cannot be undone.',
    ]);
    assert.deepEqual(secrets.deleted, []);
    assert.equal(await secrets.get(secretName), 'sk-test');
    assert.deepEqual(infos, []);
    assert.equal(refreshCount, 0);
  });

  it('removes a provider API key after confirmation', async () => {
    const secretName = apiKeySecretName('openai');
    const secrets = createSecrets({ [secretName]: 'sk-test' });
    const confirms: string[] = [];
    const infos: string[] = [];
    let refreshCount = 0;
    const ipc = await createSettingsIpc({
      confirm: true,
      secrets,
      confirms,
      infos,
      onApiKeyChanged: async () => {
        refreshCount += 1;
      },
    });

    const handled = ipc.handleMessage({
      command: SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY,
      provider: 'openai',
    });
    await setImmediate();

    assert.equal(handled, true);
    assert.deepEqual(confirms, [
      'Remove the OpenAI API key? This cannot be undone.',
    ]);
    assert.deepEqual(secrets.deleted, [secretName]);
    assert.equal(await secrets.get(secretName), undefined);
    assert.deepEqual(infos, ['OpenAI API key has been removed']);
    assert.equal(refreshCount, 1);
  });
});
