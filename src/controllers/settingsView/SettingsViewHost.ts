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
export interface SettingsViewHostOptions {
  readonly state: SettingsStatePorts;
  readonly memoryPrompt: SettingsMemoryControllerFactoryOptions['prompt'];
  readonly respond?: SettingsRespond;
  readonly setMemoryEnabled?: SettingsMemoryControllerFactoryOptions['setMemoryEnabled'];
  readonly modelSelectionExtras?: ModelSelectionExtras;
  readonly beforeModelSelectionMessage?: () => Awaitable<void>;
  readonly controllers?: {
    readonly memory?: SettingsMemoryController;
    readonly modelSelection?: SettingsModelSelectionController;
  };
}

export interface SettingsViewHostMutationOptions {
  readonly afterUpdate?: () => Awaitable<void>;
  readonly afterPost?: () => Awaitable<void>;
}

export class SettingsViewHost {
  readonly memoryController: SettingsMemoryController;
  readonly modelSelectionController: SettingsModelSelectionController;

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

  protected async post(
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
}
