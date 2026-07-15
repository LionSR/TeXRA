import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SettingsMessageFor } from '@shared/schemas/settingsViewMessages';
import type { SettingsRespond } from '@shared/settingsView/types';

import {
  SettingsProfileController,
  type ApiAccessModeUpdate,
  type ProviderVscodeSettingUpdateResult,
  type SettingsProfileConfigValue,
  type SettingsProfileControllerDeps,
} from './SettingsProfileController';
import {
  SettingsProfileKeyController,
  type SettingsProfileKeyControllerDeps,
} from './SettingsProfileKeyController';
import {
  SettingsViewHost,
  type SettingsViewHostOptions,
} from './SettingsViewHost';

type Awaitable<T> = T | PromiseLike<T>;
type ApiAccessModeInput = SettingsMessageFor<
  typeof SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE
>['mode'];

interface SettingsProfileProviderPorts {
  readonly setProviderStreaming: (
    provider: string,
    enabled: boolean,
  ) => Awaitable<void>;
  readonly setProviderEndpoint: (
    provider: string,
    endpoint: string,
  ) => Awaitable<void>;
  readonly setGlobalStreaming: (enabled: boolean) => Awaitable<void>;
}

interface SettingsProfileHostOptions extends SettingsViewHostOptions {
  readonly profile: SettingsProfileControllerDeps;
  readonly profileKey: SettingsProfileKeyControllerDeps;
  readonly providerConfig: SettingsProfileProviderPorts;
}

interface SettingsProfileHostApiAccessModeOptions {
  readonly respond?: SettingsRespond;
  readonly afterPost?: (update: ApiAccessModeUpdate) => Awaitable<void>;
}

/**
 * Settings-view host with the extension's complete profile capability.
 * Construction requires every profile port, so profile operations cannot fail
 * later because a partially configured common host exposed an invalid method.
 */
export class SettingsProfileHost extends SettingsViewHost {
  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;
  private readonly providerConfig: SettingsProfileProviderPorts;

  constructor(options: SettingsProfileHostOptions) {
    super(options);
    this.profileController = new SettingsProfileController(options.profile);
    this.profileKeyController = new SettingsProfileKeyController(
      options.profileKey,
    );
    this.providerConfig = options.providerConfig;
  }

  async sendProfileData(respond?: SettingsRespond): Promise<void> {
    await this.post(
      await this.profileController.buildProfileMessage(),
      respond,
    );
  }

  async setProviderKey(provider: string, apiKey?: string): Promise<void> {
    if (apiKey != null) {
      await this.profileKeyController.commitProviderKey(provider, apiKey);
      return;
    }
    await this.profileKeyController.setProviderKey(provider);
  }

  async removeProviderKey(provider: string): Promise<void> {
    await this.profileKeyController.removeProviderKey(provider);
  }

  async openProviderKeyUrl(provider: string): Promise<void> {
    await this.profileKeyController.openProviderKeyUrl(provider);
  }

  async setProviderStreaming(
    provider: string,
    enabled: boolean,
    respond?: SettingsRespond,
  ): Promise<void> {
    await this.providerConfig.setProviderStreaming(provider, enabled);
    await this.sendProfileData(respond);
  }

  async setProviderEndpoint(
    provider: string,
    endpoint: string,
    respond?: SettingsRespond,
  ): Promise<void> {
    await this.providerConfig.setProviderEndpoint(provider, endpoint);
    await this.sendProfileData(respond);
  }

  async setGlobalStreaming(
    enabled: boolean,
    respond?: SettingsRespond,
  ): Promise<void> {
    await this.providerConfig.setGlobalStreaming(enabled);
    await this.sendProfileData(respond);
  }

  async setApiAccessMode(
    mode: ApiAccessModeInput,
    options?: SettingsProfileHostApiAccessModeOptions,
  ): Promise<ApiAccessModeUpdate> {
    const update = await this.profileController.setApiAccessMode(mode);
    await this.sendProfileData(options?.respond);
    await this.sendModelSelectionData(options?.respond);
    await options?.afterPost?.(update);
    return update;
  }

  getProviderDisplayName(provider: string): string {
    return this.profileController.getProviderDisplayName(provider);
  }

  getReliabilitySettings() {
    return this.profileController.getReliabilitySettings();
  }

  setProviderVscodeSetting(input: {
    key: string;
    value: SettingsProfileConfigValue;
  }): Promise<ProviderVscodeSettingUpdateResult> {
    return this.profileController.setProviderVscodeSetting(input);
  }
}
