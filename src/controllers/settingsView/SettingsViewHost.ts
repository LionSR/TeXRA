import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type {
  SettingsMessageFor,
  SETTINGS_VIEW_CMD,
} from '@shared/schemas/settingsViewMessages';
import type {
  SettingsRespond,
  SettingsStatePorts,
} from '@shared/settingsView/types';

import {
  createSettingsMemoryController,
  type SettingsMemoryControllerFactoryOptions,
} from './SettingsMemoryControllerFactory';
import {
  buildModelSelectionMessage,
  createModelSelectionController,
  type ModelSelectionExtras,
} from './SettingsModelSelectionControllerFactory';
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
import type { SettingsMemoryController } from './SettingsMemoryController';
import type { SettingsModelSelectionController } from './SettingsModelSelectionController';

type Awaitable<T> = T | PromiseLike<T>;
type MemoryPreviewMessage = SettingsMessageFor<
  typeof SETTINGS_VIEW_CMD.GET_MEMORY_PREVIEW
>;
type MemoryDeleteMessage = SettingsMessageFor<
  typeof SETTINGS_VIEW_CMD.DELETE_MEMORY
>;
type SetModelEnabledInput = Omit<
  SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED>,
  'command'
>;
type SetReasoningLevelInput = Omit<
  SettingsMessageFor<typeof SETTINGS_VIEW_COMMANDS.SET_MODEL_REASONING_LEVEL>,
  'command'
>;
type ApiAccessModeInput = SettingsMessageFor<
  typeof SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE
>['mode'];

interface SettingsViewHostProviderConfigPorts {
  readonly isApiProvider?: (provider: string) => boolean;
  readonly onUnknownProvider?: (provider: string) => Awaitable<void>;
  readonly setProviderStreaming?: (
    provider: string,
    enabled: boolean,
  ) => Awaitable<void>;
  readonly setProviderEndpoint?: (
    provider: string,
    endpoint: string,
  ) => Awaitable<void>;
  readonly setGlobalStreaming?: (enabled: boolean) => Awaitable<void>;
}

export interface SettingsViewHostOptions {
  readonly state: SettingsStatePorts;
  readonly memoryPrompt: SettingsMemoryControllerFactoryOptions['prompt'];
  readonly respond?: SettingsRespond;
  readonly setMemoryEnabled?: SettingsMemoryControllerFactoryOptions['setMemoryEnabled'];
  readonly modelSelectionExtras?: ModelSelectionExtras;
  readonly beforeModelSelectionMessage?: () => Awaitable<void>;
  readonly profile?: SettingsProfileControllerDeps;
  readonly profileKey?: SettingsProfileKeyControllerDeps;
  readonly providerConfig?: SettingsViewHostProviderConfigPorts;
  readonly controllers?: {
    readonly memory?: SettingsMemoryController;
    readonly modelSelection?: SettingsModelSelectionController;
    readonly profile?: SettingsProfileController;
    readonly profileKey?: SettingsProfileKeyController;
  };
}

export interface SettingsViewHostMutationOptions {
  readonly afterUpdate?: () => Awaitable<void>;
  readonly afterPost?: () => Awaitable<void>;
}

interface SettingsViewHostApiAccessModeOptions {
  readonly respond?: SettingsRespond;
  readonly afterPost?: (update: ApiAccessModeUpdate) => Awaitable<void>;
}

export class SettingsViewHost {
  readonly memoryController: SettingsMemoryController;
  readonly modelSelectionController: SettingsModelSelectionController;
  private readonly profileController?: SettingsProfileController;
  private readonly profileKeyController?: SettingsProfileKeyController;

  constructor(private readonly options: SettingsViewHostOptions) {
    this.memoryController =
      options.controllers?.memory ??
      createSettingsMemoryController({
        globalState: options.state.globalState,
        prompt: options.memoryPrompt,
        setMemoryEnabled: options.setMemoryEnabled,
      });
    this.modelSelectionController =
      options.controllers?.modelSelection ??
      createModelSelectionController(
        options.state,
        options.modelSelectionExtras,
      );
    this.profileController =
      options.controllers?.profile ??
      (options.profile
        ? new SettingsProfileController(options.profile)
        : undefined);
    this.profileKeyController =
      options.controllers?.profileKey ??
      (options.profileKey
        ? new SettingsProfileKeyController(options.profileKey)
        : undefined);
  }

  async sendMemoryData(respond?: SettingsRespond): Promise<void> {
    await this.post(
      await this.memoryController.getMemoryDataMessage(),
      respond,
    );
  }

  async sendMemoryPreview(
    data: Pick<MemoryPreviewMessage, 'storagePath'>,
    options: {
      readonly respond?: SettingsRespond;
      readonly onError?: (error: unknown) => Awaitable<void>;
    } = {},
  ): Promise<void> {
    try {
      await this.post(
        await this.memoryController.getMemoryPreviewMessage(data.storagePath),
        options.respond,
      );
    } catch (error) {
      await options.onError?.(error);
      await this.post(
        this.memoryController.getMemoryPreviewErrorMessage(data.storagePath),
        options.respond,
      );
    }
  }

  async sendMemoryEnabled(respond?: SettingsRespond): Promise<void> {
    await this.post(this.memoryController.getMemoryEnabledMessage(), respond);
  }

  async deleteMemory(
    data: Pick<MemoryDeleteMessage, 'displayPath' | 'storagePath'>,
    respond?: SettingsRespond,
  ): Promise<void> {
    await this.postMaybe(
      await this.memoryController.deleteMemory(data),
      respond,
    );
  }

  async setMemoryEnabled(
    enabled: boolean,
    respond?: SettingsRespond,
  ): Promise<void> {
    await this.post(
      await this.memoryController.setMemoryEnabled(enabled),
      respond,
    );
  }

  async setMemoryPinned(
    storagePath: string,
    pinned: boolean,
    respond?: SettingsRespond,
  ): Promise<void> {
    const message = pinned
      ? await this.memoryController.pinMemory(storagePath)
      : await this.memoryController.unpinMemory(storagePath);
    await this.postMaybe(message, respond);
  }

  async sendModelSelectionData(respond?: SettingsRespond): Promise<void> {
    await this.options.beforeModelSelectionMessage?.();
    await this.post(
      await buildModelSelectionMessage(this.modelSelectionController),
      respond,
    );
  }

  async setModelEnabled(
    input: SetModelEnabledInput,
    options?: SettingsViewHostMutationOptions & { respond?: SettingsRespond },
  ): Promise<void> {
    await this.modelSelectionController.setModelEnabled(input);
    await this.postModelSelectionMutation(options);
  }

  async setHelperModel(
    modelName: string,
    options?: SettingsViewHostMutationOptions & { respond?: SettingsRespond },
  ): Promise<void> {
    await this.modelSelectionController.setHelperModel(modelName);
    await this.postModelSelectionMutation(options);
  }

  async setReasoningLevel(
    input: SetReasoningLevelInput,
    options?: SettingsViewHostMutationOptions & { respond?: SettingsRespond },
  ): Promise<void> {
    await this.modelSelectionController.setReasoningLevel(input);
    await this.postModelSelectionMutation(options);
  }

  async setPreferShortModelNames(
    enabled: boolean,
    options?: SettingsViewHostMutationOptions & { respond?: SettingsRespond },
  ): Promise<void> {
    await this.modelSelectionController.setPreferShortModelNames(enabled);
    await this.postModelSelectionMutation(options);
  }

  async sendProfileData(respond?: SettingsRespond): Promise<void> {
    await this.post(
      await this.requireProfileController().buildProfileMessage(),
      respond,
    );
  }

  async setProviderKey(provider: string, apiKey?: string): Promise<void> {
    if (!(await this.acceptKnownProvider(provider))) return;
    const controller = this.requireProfileKeyController();
    if (apiKey != null) {
      await controller.commitProviderKey(provider, apiKey);
      return;
    }
    await controller.setProviderKey(provider);
  }

  async removeProviderKey(provider: string): Promise<void> {
    if (!(await this.acceptKnownProvider(provider))) return;
    await this.requireProfileKeyController().removeProviderKey(provider);
  }

  async openProviderKeyUrl(provider: string): Promise<void> {
    await this.requireProfileKeyController().openProviderKeyUrl(provider);
  }

  async setProviderStreaming(
    provider: string,
    enabled: boolean,
    respond?: SettingsRespond,
  ): Promise<void> {
    const setProviderStreaming =
      this.options.providerConfig?.setProviderStreaming;
    if (!setProviderStreaming) {
      throw new Error('SettingsViewHost has no provider streaming port.');
    }
    await setProviderStreaming(provider, enabled);
    await this.sendProfileData(respond);
  }

  async setProviderEndpoint(
    provider: string,
    endpoint: string,
    respond?: SettingsRespond,
  ): Promise<void> {
    const setProviderEndpoint =
      this.options.providerConfig?.setProviderEndpoint;
    if (!setProviderEndpoint) {
      throw new Error('SettingsViewHost has no provider endpoint port.');
    }
    await setProviderEndpoint(provider, endpoint);
    await this.sendProfileData(respond);
  }

  async setGlobalStreaming(
    enabled: boolean,
    respond?: SettingsRespond,
  ): Promise<void> {
    const setGlobalStreaming = this.options.providerConfig?.setGlobalStreaming;
    if (!setGlobalStreaming) {
      throw new Error('SettingsViewHost has no global streaming port.');
    }
    await setGlobalStreaming(enabled);
    await this.sendProfileData(respond);
  }

  async setApiAccessMode(
    mode: ApiAccessModeInput,
    options?: SettingsViewHostApiAccessModeOptions,
  ): Promise<ApiAccessModeUpdate> {
    const update = await this.requireProfileController().setApiAccessMode(mode);
    await this.sendProfileData(options?.respond);
    await this.sendModelSelectionData(options?.respond);
    await options?.afterPost?.(update);
    return update;
  }

  getProviderDisplayName(provider: string): string {
    return this.requireProfileController().getProviderDisplayName(provider);
  }

  getReliabilitySettings() {
    return this.requireProfileController().getReliabilitySettings();
  }

  setProviderVscodeSetting(input: {
    key: string;
    value: SettingsProfileConfigValue;
  }): Promise<ProviderVscodeSettingUpdateResult> {
    return this.requireProfileController().setProviderVscodeSetting(input);
  }

  getVisibleModels(): string[] {
    return this.modelSelectionController.getVisibleModels();
  }

  private async postModelSelectionMutation(
    options?: SettingsViewHostMutationOptions & { respond?: SettingsRespond },
  ): Promise<void> {
    await options?.afterUpdate?.();
    await this.sendModelSelectionData(options?.respond);
    await options?.afterPost?.();
  }

  private async post(
    message: unknown,
    respond = this.options.respond,
  ): Promise<void> {
    if (!respond) {
      throw new Error('SettingsViewHost has no response target.');
    }
    await respond(message);
  }

  private async postMaybe(
    message: unknown | null | undefined,
    respond?: SettingsRespond,
  ): Promise<void> {
    if (message == null) return;
    await this.post(message, respond);
  }

  private requireProfileController(): SettingsProfileController {
    if (!this.profileController) {
      throw new Error('SettingsViewHost has no profile controller.');
    }
    return this.profileController;
  }

  private requireProfileKeyController(): SettingsProfileKeyController {
    if (!this.profileKeyController) {
      throw new Error('SettingsViewHost has no profile key controller.');
    }
    return this.profileKeyController;
  }

  private async acceptKnownProvider(provider: string): Promise<boolean> {
    const isApiProvider = this.options.providerConfig?.isApiProvider;
    if (!isApiProvider || isApiProvider(provider)) return true;
    await this.options.providerConfig?.onUnknownProvider?.(provider);
    return false;
  }
}

export function createSettingsViewHost(
  options: SettingsViewHostOptions,
): SettingsViewHost {
  return new SettingsViewHost(options);
}
