// Local imports - shared settings controllers

// Local imports - authentication and models

// Local imports - shared schemas and messages
import {
  codexCoordinator,
  getChatGptAuthStatus,
  loginWithLoopback,
  setCodexSubscriptionToolUseOnly,
  setPreferCodexSubscription,
} from '@auth/codex';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import {
  buildModelSelectionMessage,
  createModelSelectionController,
} from '@controllers/settingsView/SettingsModelSelectionControllerFactory';
import type { SettingsViewCommandActions } from '@controllers/settingsView/SettingsViewCommandHandlers';
import type { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type { ExternalOpener, PromptHost } from '@hosts/uiHosts';
import {
  computeModelOptionsData,
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  isApiProvider,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import type { ConfigProvider } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';
import { AgentCategory } from '@shared/schemas/agent';
import type { ApiAccessMode } from '@shared/schemas/profileViewMessages';
import { buildChatGptAuthStatusMessage } from '@shared/settingsView/handlers/chatGptHandlers';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { unsupported } from '@shared/utils/dispatcher';

// Local imports - platform and host ports
import {
  getProviderDisplayName,
  getProviderEndpoint,
  getProviderKeyUrl,
  getProviderStreaming,
  setGlobalStreaming,
  setProviderEndpoint,
  setProviderStreaming,
  supportsCustomEndpoint,
} from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

// Local imports - utilities

interface DesktopCredentialRendererPort {
  postToRenderer(message: unknown): void;
}

interface DesktopCredentialNotificationPort {
  showInfoMessage(message: string): Promise<void>;
  showErrorMessage(message: string): Promise<void>;
}

interface DesktopCredentialAuthPort {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

interface DesktopCredentialSettingsControllerOptions extends SettingsStatePorts {
  readonly config: ConfigProvider;
  readonly secrets: PlatformSecrets;
  readonly renderer: DesktopCredentialRendererPort;
  readonly prompt: Pick<PromptHost, 'input' | 'confirm'>;
  readonly externalOpener: Pick<ExternalOpener, 'openExternal'> & {
    presentChatGptSignInUrl(url: string): void | Promise<void>;
  };
  readonly notifications: DesktopCredentialNotificationPort;
  readonly auth: DesktopCredentialAuthPort;
  readonly setUseIncludedModelAccess: (enabled: boolean) => Promise<void>;
  readonly modelListRefresh: PromiseLike<void>;
  readonly onCredentialChanged: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

export interface DesktopCredentialSettingsController {
  readonly profileActions: SettingsViewCommandActions['profile'];
  readonly chatGptActions: SettingsViewCommandActions['chatGpt'];
  readonly modelSelectionController: SettingsModelSelectionController;
  prepareModelSelectionData(): Promise<void>;
  postMainModelOptionsData(): Promise<void>;
  postStartupData(): Promise<void>;
  refreshAuthDependentData(): Promise<void>;
  signInChatGpt(options?: { enableSubscription?: boolean }): Promise<void>;
}

/** Owns desktop credential mutation, authentication, and dependent refreshes. */
export class DefaultDesktopCredentialSettingsController implements DesktopCredentialSettingsController {
  readonly profileActions: SettingsViewCommandActions['profile'];
  readonly chatGptActions: SettingsViewCommandActions['chatGpt'];
  readonly modelSelectionController: SettingsModelSelectionController;

  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;

  constructor(
    private readonly options: DesktopCredentialSettingsControllerOptions,
  ) {
    this.modelSelectionController = createModelSelectionController(options);
    this.profileController = new SettingsProfileController({
      globalState: options.globalState,
      providerIds: API_PROVIDERS,
      providerVscodeSettings: {},
      providerDisplayNames: PROVIDER_DISPLAY_NAMES,
      providerKeyUrls: PROVIDER_URLS,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(options.secrets, API_PROVIDERS),
      getProviderDisplayName,
      getProviderKeyUrl,
      getProviderStreaming,
      getProviderEndpoint,
      supportsCustomEndpoint,
      getConfig: (key, defaultValue) => options.config.get(key, defaultValue),
      updateConfig: (key, value) => options.config.update(key, value, 'global'),
      setUseIncludedModelAccess: options.setUseIncludedModelAccess,
      invalidateModelOptionsCache,
    });
    this.profileKeyController = new SettingsProfileKeyController({
      prompt: {
        input: options.prompt.input,
        confirm: options.prompt.confirm,
        info: async (message) => {
          await options.notifications.showInfoMessage(message);
          return undefined;
        },
      },
      externalOpener: options.externalOpener,
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        this.profileController.getProviderKeyUrl(provider),
      getApiKeySecretName: (provider) => {
        if (!isApiProvider(provider)) {
          throw new Error(`Unknown API provider: ${provider}`);
        }
        return apiKeySecretName(provider);
      },
      setSecret: (key, value) => options.secrets.set(key, value),
      deleteSecret: (key) => options.secrets.delete(key),
      refreshAfterKeyChange: () => this.refreshAfterProviderKeyChange(),
    });
    this.profileActions = {
      signIn: () => options.auth.signIn(),
      signOut: () => options.auth.signOut(),
      setApiAccessMode: (mode) => this.setApiAccessMode(mode),
      setProviderKey: (provider, apiKey) =>
        this.setProviderKey(provider, apiKey),
      removeProviderKey: (provider) => this.removeProviderKey(provider),
      openProviderKeyUrl: (provider) =>
        this.profileKeyController.openProviderKeyUrl(provider),
      setProviderStreaming: (provider, enabled) =>
        this.setProviderStreaming(provider, enabled),
      setProviderEndpoint: (provider, endpoint) =>
        this.setProviderEndpoint(provider, endpoint),
      setGlobalStreaming: (enabled) => this.setGlobalStreaming(enabled),
      setProviderVscodeSetting: unsupported(
        'VS Code provider settings are not applicable in the desktop app.',
      ),
      openExternalUrl: (url) => options.externalOpener.openExternal(url),
    };
    this.chatGptActions = {
      signIn: () => this.signInChatGpt(),
      signOut: () => this.signOutChatGpt(),
      setPreferSubscription: (enabled) =>
        this.setChatGptPreferSubscription(enabled),
      setSubscriptionToolUseOnly: (enabled) =>
        this.setChatGptSubscriptionToolUseOnly(enabled),
    };
  }

  async prepareModelSelectionData(): Promise<void> {
    await this.options.modelListRefresh;
  }

  async postStartupData(): Promise<void> {
    await Promise.all([this.postProfileData(), this.postChatGptAuthStatus()]);
  }

  async postMainModelOptionsData(): Promise<void> {
    const visibleModels = this.modelSelectionController.getVisibleModels();
    const [workflowModelOptions, toolUseModelOptions] = await Promise.all([
      computeModelOptionsData(visibleModels, undefined, {
        agentCategory: AgentCategory.Workflow,
      }),
      computeModelOptionsData(visibleModels, undefined, {
        agentCategory: AgentCategory.ToolUse,
      }),
    ]);
    this.options.renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsData: workflowModelOptions,
      optionsDataByCategory: {
        workflow: workflowModelOptions,
        toolUse: toolUseModelOptions,
      },
    });
  }

  async refreshAuthDependentData(): Promise<void> {
    invalidateModelOptionsCache();
    await this.postModelSelectionData();
    await this.postMainModelOptionsData();
    await this.postProfileData();
  }

  async signInChatGpt(signInOptions?: {
    enableSubscription?: boolean;
  }): Promise<void> {
    try {
      const session = await loginWithLoopback({
        coordinator: codexCoordinator(),
        openBrowser: async (url) => {
          await this.options.externalOpener.openExternal(url);
          // This dialog is informational. Awaiting it would delay the OAuth
          // callback until the user dismisses the dialog.
          void Promise.resolve(
            this.options.externalOpener.presentChatGptSignInUrl(url),
          ).catch(this.options.onError);
        },
      });
      if (signInOptions?.enableSubscription) {
        await setPreferCodexSubscription(true);
      }
      await this.options.notifications.showInfoMessage(
        `Signed in with ChatGPT as ${session.email ?? session.accountId ?? 'your account'}.`,
      );
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `ChatGPT sign-in failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await this.refreshAfterChatGptAuthChange();
    }
  }

  private async acceptKnownProvider(provider: string): Promise<boolean> {
    if (isApiProvider(provider)) return true;
    await this.options.notifications.showErrorMessage(
      `Unknown API provider: ${provider}`,
    );
    return false;
  }

  private async setProviderKey(
    provider: string,
    submittedApiKey?: string,
  ): Promise<void> {
    if (!(await this.acceptKnownProvider(provider))) return;
    if (submittedApiKey != null) {
      await this.profileKeyController.commitProviderKey(
        provider,
        submittedApiKey,
      );
      return;
    }
    await this.profileKeyController.setProviderKey(provider);
  }

  private async removeProviderKey(provider: string): Promise<void> {
    if (!(await this.acceptKnownProvider(provider))) return;
    await this.profileKeyController.removeProviderKey(provider);
  }

  private async setApiAccessMode(mode: ApiAccessMode): Promise<void> {
    await this.profileController.setApiAccessMode(mode);
    await this.postProfileData();
    await this.postModelSelectionData();
    await this.options.onCredentialChanged();
  }

  private async setProviderStreaming(
    provider: string,
    enabled: boolean,
  ): Promise<void> {
    if (!(await this.acceptKnownProvider(provider))) return;
    await setProviderStreaming(provider, enabled);
    await this.postProfileData();
  }

  private async setProviderEndpoint(
    provider: string,
    endpoint: string,
  ): Promise<void> {
    if (!(await this.acceptKnownProvider(provider))) return;
    await setProviderEndpoint(provider, endpoint);
    await this.postProfileData();
  }

  private async setGlobalStreaming(enabled: boolean): Promise<void> {
    await setGlobalStreaming(enabled);
    await this.postProfileData();
  }

  private async refreshAfterProviderKeyChange(): Promise<void> {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    await this.postProfileData();
    await this.postModelSelectionData();
    await this.postMainModelOptionsData();
    await this.options.onCredentialChanged();
  }

  private async refreshAfterChatGptAuthChange(): Promise<void> {
    invalidateModelOptionsCache();
    await Promise.all([
      this.postChatGptAuthStatus(),
      this.postModelSelectionData(),
      this.postMainModelOptionsData(),
    ]);
    await this.options.onCredentialChanged();
  }

  private async signOutChatGpt(): Promise<void> {
    try {
      await codexCoordinator().signOut();
      await this.options.notifications.showInfoMessage(
        'Signed out of ChatGPT.',
      );
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `ChatGPT sign-out failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await this.refreshAfterChatGptAuthChange();
    }
  }

  private async setChatGptPreferSubscription(enabled: boolean): Promise<void> {
    try {
      const update = await setPreferCodexSubscription(enabled);
      if (update.effective !== enabled) {
        await this.options.notifications.showInfoMessage(
          `A more specific setting still keeps ChatGPT subscription ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `ChatGPT subscription preference update failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await this.refreshAfterChatGptAuthChange();
    }
  }

  private async setChatGptSubscriptionToolUseOnly(
    enabled: boolean,
  ): Promise<void> {
    try {
      const update = await setCodexSubscriptionToolUseOnly(enabled);
      if (update.effective !== enabled) {
        await this.options.notifications.showInfoMessage(
          `The effective "subscription for tool-use only" setting remains ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `ChatGPT subscription scope update failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await this.refreshAfterChatGptAuthChange();
    }
  }

  private async postProfileData(): Promise<void> {
    this.options.renderer.postToRenderer(
      await this.profileController.buildProfileMessage(),
    );
  }

  private async postChatGptAuthStatus(): Promise<void> {
    this.options.renderer.postToRenderer(
      await buildChatGptAuthStatusMessage(getChatGptAuthStatus),
    );
  }

  private async postModelSelectionData(): Promise<void> {
    await this.prepareModelSelectionData();
    this.options.renderer.postToRenderer(
      await buildModelSelectionMessage(this.modelSelectionController),
    );
  }
}
