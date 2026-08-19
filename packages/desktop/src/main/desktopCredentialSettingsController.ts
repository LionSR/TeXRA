import { LoopbackTransportUnavailableError } from '@auth/oauth/loopbackLogin';
import { getChatGptAuthStatus } from '@controllers/modelAccess/chatGptAuthStatus';
import { getGrokAuthStatus } from '@controllers/modelAccess/grokAuthStatus';
import {
  subscriptionProvider,
  type SubscriptionDeviceCodePrompt,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
} from '@controllers/modelAccess/subscriptionProviders';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import {
  SettingsModelSelectionController,
  type ModelSelectionExtras,
} from '@controllers/settingsView/SettingsModelSelectionController';
import type { ExternalOpener, PromptHost } from '@hosts/uiHosts';
import {
  computeModelOptionsData,
  getEnabledModels,
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import type { ConfigProvider } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  codingPlanForApiProvider,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import {
  SUBSCRIPTION_USAGE_PROVIDERS,
  type SettingsViewInboundHandlerRegistry,
  type SubscriptionUsageSnapshots,
} from '@shared/schemas';
import { buildAuthStatusMessage } from '@shared/settingsView/handlers/authStatusMessage';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface DesktopCredentialSettingsControllerOptions extends SettingsStatePorts {
  readonly config: ConfigProvider;
  readonly secrets: PlatformSecrets;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  readonly prompt: Pick<PromptHost, 'input' | 'confirm'>;
  readonly externalOpener: Pick<ExternalOpener, 'openExternal'> & {
    presentSubscriptionSignInUrl(
      url: string,
      productName: string,
    ): void | Promise<void>;
    /**
     * Show the one-time code and verification URL for a device-code sign-in,
     * the fallback when no browser can carry the loopback callback.
     */
    presentSubscriptionDeviceCode(
      prompt: SubscriptionDeviceCodePrompt,
      productName: string,
    ): void | Promise<void>;
  };
  readonly notifications: {
    showInfoMessage(message: string): Promise<void>;
    showWarningMessage(message: string): Promise<void>;
    showErrorMessage(message: string): Promise<void>;
  };
  readonly auth: {
    signIn(): Promise<void>;
    signOut(): Promise<void>;
  };
  readonly subscriptionUsage?: Pick<
    SubscriptionUsageService,
    'getUsage' | 'invalidate'
  >;
  readonly modelSelectionExtras?: ModelSelectionExtras;
  readonly onCredentialChanged: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

type DesktopProfileHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_IN
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_OUT
  | typeof SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY
  | typeof SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL
  | typeof SETTINGS_VIEW_COMMANDS.SET_PROVIDER_SETTING
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_EXTERNAL_URL
>;

type DesktopChatGptHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_IN_CHATGPT
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_OUT_CHATGPT
  | typeof SETTINGS_VIEW_COMMANDS.SET_CHATGPT_PREFER_SUBSCRIPTION
>;

type DesktopGrokHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_IN_GROK
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_OUT_GROK
  | typeof SETTINGS_VIEW_COMMANDS.SET_GROK_PREFER_SUBSCRIPTION
>;

export interface DesktopCredentialSettingsController {
  readonly profileHandlers: DesktopProfileHandlers;
  readonly chatGptHandlers: DesktopChatGptHandlers;
  readonly grokHandlers: DesktopGrokHandlers;
  readonly modelSelectionController: SettingsModelSelectionController;
  postMainModelOptionsData(): Promise<void>;
  /** Re-posts the profile snapshot after a catalog-routed credential write. */
  postProfileData(): Promise<void>;
  postStartupData(): Promise<void>;
  postSubscriptionUsage(forceRefresh?: boolean): Promise<void>;
  refreshAfterProviderSettingChange(key: string): Promise<void>;
  refreshAuthDependentData(): Promise<void>;
  signInChatGpt(): Promise<void>;
  signInGrok(): Promise<void>;
}

/** Owns desktop credential mutation, authentication, and dependent refreshes. */
export class DefaultDesktopCredentialSettingsController implements DesktopCredentialSettingsController {
  readonly profileHandlers: DesktopProfileHandlers;
  readonly chatGptHandlers: DesktopChatGptHandlers;
  readonly grokHandlers: DesktopGrokHandlers;
  readonly modelSelectionController: SettingsModelSelectionController;

  private readonly profileController: SettingsProfileController;
  private readonly profileKeyController: SettingsProfileKeyController;
  private readonly subscriptionUsage: Pick<
    SubscriptionUsageService,
    'getUsage' | 'invalidate'
  >;

  constructor(
    private readonly options: DesktopCredentialSettingsControllerOptions,
  ) {
    this.subscriptionUsage =
      options.subscriptionUsage ?? new SubscriptionUsageService();
    this.modelSelectionController = new SettingsModelSelectionController({
      ...options.modelSelectionExtras,
      globalState: options.globalState,
    });
    this.profileController = new SettingsProfileController({
      host: 'desktop',
      globalState: options.globalState,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(options.secrets, API_PROVIDERS),
      getConfig: (key, defaultValue) => options.config.get(key, defaultValue),
      updateConfig: (key, value) => options.config.update(key, value, 'global'),
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
      refreshAfterKeyChange: (provider) =>
        this.refreshAfterProviderKeyChange(provider),
      reportFailure: async (message, error) => {
        await options.notifications.showErrorMessage(
          `${message}: ${toErrorMessage(error)}`,
        );
        options.onError(error);
        await this.postProfileData();
      },
    });
    this.profileHandlers = {
      signIn: () => options.auth.signIn(),
      signOut: () => this.signOut(),
      setProviderKey: (message) =>
        message.apiKey == null
          ? this.profileKeyController.setProviderKey(message.provider)
          : this.profileKeyController.commitProviderKey(
              message.provider,
              message.apiKey,
            ),
      removeProviderKey: (message) =>
        this.profileKeyController.removeProviderKey(message.provider),
      openProviderKeyUrl: (message) =>
        this.profileKeyController.openProviderKeyUrl(message.provider),
      setProviderSetting: (message) =>
        this.setProviderSetting(message.key, message.value),
      openExternalUrl: (message) =>
        options.externalOpener.openExternal(message.url),
    };
    this.chatGptHandlers = {
      signInChatGpt: () => this.signInChatGpt(),
      signOutChatGpt: () =>
        this.signOutSubscription('chatgpt', () =>
          this.refreshAfterChatGptAuthChange(),
        ),
      setChatGptPreferSubscription: (message) =>
        this.setSubscriptionPreference('chatgpt', message.enabled, () =>
          this.refreshAfterChatGptAuthChange(),
        ),
    };
    this.grokHandlers = {
      signInGrok: () => this.signInGrok(),
      signOutGrok: () =>
        this.signOutSubscription('grok', () =>
          this.refreshAfterGrokAuthChange(),
        ),
      setGrokPreferSubscription: (message) =>
        this.setSubscriptionPreference('grok', message.enabled, () =>
          this.refreshAfterGrokAuthChange(),
        ),
    };
  }

  async postStartupData(): Promise<void> {
    await Promise.all([
      this.postProfileData(),
      this.postChatGptAuthStatus(),
      this.postGrokAuthStatus(),
    ]);
  }

  async postSubscriptionUsage(forceRefresh = false): Promise<void> {
    const snapshots = Object.fromEntries(
      await Promise.all(
        SUBSCRIPTION_USAGE_PROVIDERS.map(async (provider) => [
          provider,
          await this.subscriptionUsage.getUsage(provider, { forceRefresh }),
        ]),
      ),
    ) as SubscriptionUsageSnapshots;
    this.options.renderer.postToRenderer({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
      snapshots,
    });
  }

  async postMainModelOptionsData(): Promise<void> {
    const visibleModels = getEnabledModels(this.options.globalState);
    const modelOptions = await computeModelOptionsData(visibleModels);
    this.options.renderer.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS,
      optionsDataByCategory: {
        workflow: modelOptions,
        toolUse: modelOptions,
      },
    });
  }

  async refreshAuthDependentData(): Promise<void> {
    invalidateModelOptionsCache();
    await this.postModelSelectionData();
    await this.postMainModelOptionsData();
    await this.postProfileData();
  }

  /**
   * Desktop presentation for a subscription sign-in. The loopback browser is
   * the normal route; failing to reach one is reported as a transport
   * failure so the shared flow can retry with a device code, which this host
   * shows in its own dialog.
   */
  private signInPresenter(displayName: string): SubscriptionSignInPresenter {
    return {
      presentDeviceCode: (prompt) => {
        // Informational only — awaiting would block the approval poll.
        void Promise.resolve(
          this.options.externalOpener.presentSubscriptionDeviceCode(
            prompt,
            displayName,
          ),
        ).catch(this.options.onError);
      },
      presentSignInUrl: async (url) => {
        try {
          await this.options.externalOpener.openExternal(url);
        } catch (error) {
          throw new LoopbackTransportUnavailableError(
            `Could not open a browser for ${displayName} sign-in.`,
            { cause: error },
          );
        }
        // Informational only — awaiting would block the OAuth callback.
        void Promise.resolve(
          this.options.externalOpener.presentSubscriptionSignInUrl(
            url,
            displayName,
          ),
        ).catch(this.options.onError);
      },
    };
  }

  private async signInSubscription(
    providerId: SubscriptionProviderId,
    refresh: () => Promise<void>,
  ): Promise<void> {
    const provider = subscriptionProvider(providerId);
    try {
      const account = await provider.signIn({
        transport: 'auto',
        present: this.signInPresenter(provider.displayName),
      });
      await provider.setPreferSubscription(true);
      await this.options.notifications.showInfoMessage(
        `Signed in with ${provider.displayName} as ${account.label}.`,
      );
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `${provider.displayName} sign-in failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await refresh();
    }
  }

  async signInChatGpt(): Promise<void> {
    await this.signInSubscription('chatgpt', () =>
      this.refreshAfterChatGptAuthChange(),
    );
  }

  async signInGrok(): Promise<void> {
    await this.signInSubscription('grok', () =>
      this.refreshAfterGrokAuthChange(),
    );
  }

  private async setProviderSetting(
    key: string,
    value: boolean | number,
  ): Promise<void> {
    const result = await this.profileController.setProviderSetting({
      key,
      value,
    });
    if (result.kind === 'rejected') {
      await this.options.notifications.showErrorMessage(
        `Unknown provider setting: ${result.key}`,
      );
      return;
    }

    await this.postProfileData();
    if (codingPlanForUsageSetting(key)) {
      await this.postSubscriptionUsage();
    }
  }

  /**
   * Re-post everything a catalog-backed provider toggle can change. The write
   * itself happens on the shared `UPDATE_STATE_SETTING` path, which owns
   * validation and the row's `onWrite` exclusions; this is the desktop's half
   * of the refresh.
   */
  async refreshAfterProviderSettingChange(key: string): Promise<void> {
    await this.postProfileData();
    if (codingPlanForUsageSetting(key)) {
      await this.postSubscriptionUsage();
    }
    await this.postModelSelectionData();
    await this.postMainModelOptionsData();
    await this.options.onCredentialChanged();
  }

  private async refreshAfterProviderKeyChange(provider: string): Promise<void> {
    invalidateApiKeyCache();
    invalidateModelOptionsCache();
    const usageProvider = codingPlanForApiProvider(provider)?.usageProvider;
    if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
    await this.postProfileData();
    await this.postModelSelectionData();
    await this.postMainModelOptionsData();
    if (usageProvider) await this.postSubscriptionUsage();
    await this.options.onCredentialChanged();
  }

  private async refreshAfterSubscriptionAuthChange(
    postStatus: () => Promise<void>,
    usageProvider?: 'chatgpt',
  ): Promise<void> {
    invalidateModelOptionsCache();
    if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
    await Promise.all([
      postStatus(),
      this.postModelSelectionData(),
      this.postMainModelOptionsData(),
      ...(usageProvider ? [this.postSubscriptionUsage()] : []),
    ]);
    await this.options.onCredentialChanged();
  }

  private refreshAfterChatGptAuthChange(): Promise<void> {
    return this.refreshAfterSubscriptionAuthChange(
      () => this.postChatGptAuthStatus(),
      'chatgpt',
    );
  }

  private refreshAfterGrokAuthChange(): Promise<void> {
    return this.refreshAfterSubscriptionAuthChange(() =>
      this.postGrokAuthStatus(),
    );
  }

  private async signOut(): Promise<void> {
    await this.options.auth.signOut();
  }

  private async signOutSubscription(
    providerId: SubscriptionProviderId,
    refresh: () => Promise<void>,
  ): Promise<void> {
    const provider = subscriptionProvider(providerId);
    try {
      await provider.signOut();
      await this.options.notifications.showInfoMessage(
        `Signed out of ${provider.displayName}.`,
      );
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `${provider.displayName} sign-out failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await refresh();
    }
  }

  private async setSubscriptionPreference(
    providerId: SubscriptionProviderId,
    enabled: boolean,
    refresh: () => Promise<void>,
  ): Promise<void> {
    const provider = subscriptionProvider(providerId);
    try {
      const update = await provider.setPreferSubscription(enabled);
      if (update.effective !== enabled) {
        await this.options.notifications.showWarningMessage(
          `A more specific setting still keeps ${provider.displayName} subscription ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `${provider.displayName} subscription preference update failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await refresh();
    }
  }

  async postProfileData(): Promise<void> {
    this.options.renderer.postToRenderer(
      await this.profileController.buildProfileMessage(),
    );
  }

  private async postChatGptAuthStatus(): Promise<void> {
    this.options.renderer.postToRenderer(
      await buildAuthStatusMessage(
        SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
        getChatGptAuthStatus,
      ),
    );
  }

  private async postGrokAuthStatus(): Promise<void> {
    this.options.renderer.postToRenderer(
      await buildAuthStatusMessage(
        SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS,
        getGrokAuthStatus,
      ),
    );
  }

  private async postModelSelectionData(): Promise<void> {
    this.options.renderer.postToRenderer(
      await this.modelSelectionController.buildModelSelectionMessage(),
    );
  }
}
