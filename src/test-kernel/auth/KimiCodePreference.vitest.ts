// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test support
import { installPlatform } from '@test/support/setupPlatform';

// Local imports - auth
import { platform } from '@platform/platform';
import {
  KIMI_CODE_PREFER_SUBSCRIPTION_KEY,
  isKimiCodeSubscriptionToolUseOnly,
  isPreferKimiCodeSubscription,
  setPreferKimiCodeSubscription,
} from '@auth/kimiCode';

// Local imports - platform types
import type {
  ConfigInspection,
  ConfigProvider,
  ConfigTarget,
  Disposable,
} from '@platform/interfaces';

class FolderOverrideConfigProvider implements ConfigProvider {
  private readonly globalValues = new Map<string, unknown>();
  private readonly workspaceValues = new Map<string, unknown>();
  private readonly folderValues = new Map<string, unknown>();

  constructor(folderValue: boolean) {
    this.folderValues.set(KIMI_CODE_PREFER_SUBSCRIPTION_KEY, folderValue);
  }

  get<T>(key: string, defaultValue?: T): T {
    return (this.folderValues.get(key) ??
      this.workspaceValues.get(key) ??
      this.globalValues.get(key) ??
      defaultValue) as T;
  }

  async update<T>(
    key: string,
    value: T,
    target: ConfigTarget = 'workspace',
  ): Promise<void> {
    const values =
      target === 'global' ? this.globalValues : this.workspaceValues;
    values.set(key, value);
  }

  inspect<T = unknown>(key: string): ConfigInspection<T> | undefined {
    return {
      globalValue: this.globalValues.get(key) as T | undefined,
      workspaceValue: this.workspaceValues.get(key) as T | undefined,
      workspaceFolderValue: this.folderValues.get(key) as T | undefined,
      effectiveValue: this.get<T>(key),
    };
  }

  isExplicitlySet(key: string): boolean {
    return (
      this.globalValues.has(key) ||
      this.workspaceValues.has(key) ||
      this.folderValues.has(key)
    );
  }

  watch(): Disposable {
    return { dispose: () => {} };
  }
}

describe('Kimi Code subscription preference', () => {
  it('defaults both switches to off', async () => {
    await installPlatform();

    expect(isPreferKimiCodeSubscription()).toBe(false);
    expect(isKimiCodeSubscriptionToolUseOnly()).toBe(false);
  });

  it('writes workspace preference when workspace config already controls it', async () => {
    await installPlatform({
      config: { [KIMI_CODE_PREFER_SUBSCRIPTION_KEY]: false },
    });

    const update = await setPreferKimiCodeSubscription(true);

    expect(update).toEqual({ effective: true, target: 'workspace' });
    expect(isPreferKimiCodeSubscription()).toBe(true);
    expect(
      platform().config.inspect(KIMI_CODE_PREFER_SUBSCRIPTION_KEY),
    ).toMatchObject({
      workspaceValue: true,
      effectiveValue: true,
    });
  });

  it('does not treat folder overrides as writable workspace config', async () => {
    const config = new FolderOverrideConfigProvider(false);
    await installPlatform({}, { config });

    const update = await setPreferKimiCodeSubscription(true);

    expect(update).toEqual({ effective: false, target: 'global' });
    expect(isPreferKimiCodeSubscription()).toBe(false);
    expect(config.inspect(KIMI_CODE_PREFER_SUBSCRIPTION_KEY)).toMatchObject({
      globalValue: true,
      workspaceFolderValue: false,
      effectiveValue: false,
    });
  });
});
