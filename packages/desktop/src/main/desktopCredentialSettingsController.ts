import {
  codexCoordinator,
  loginWithLoopback as loginWithCodexLoopback,
} from '@auth/codex';
import {
  loginWithLoopback as loginWithGrokLoopback,
  xaiAccountLabel,
  xaiCoordinator,
} from '@auth/xai';
import { relayTokenSignOutNotice } from '@auth/relayToken';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { getChatGptAuthStatus } from '@controllers/modelAccess/chatGptAuthStatus';
import { getGrokAuthStatus } from '@controllers/modelAccess/grokAuthStatus';
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
  invalidateModelOptionsCache,
} from '@model/computeModelOptions';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  isApiProvider,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';
import { setPreferXaiSubscription } from '@model/xai/xaiPreference';
import type { ConfigProvider } from '@platform/interfaces';
import type { PlatformSecrets } from '@platform/secrets';
import { MAIN_VIEW_COMMANDS, SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  codingPlanForApiProvider,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import {
  SUBSCRIPTION_USAGE_PROVIDERS,
  type ApiAccessMode,
  type SettingsViewInboundHandlerRegistry,
  type SpendingStatus,
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
  readonly setUseIncludedModelAccess: (enabled: boolean) => Promise<void>;
  readonly refreshSpendingStatus: () => Promise<SpendingStatus | null>;
  readonly subscriptionUsage?: Pick<
    SubscriptionUsageService,
    'getUsage' | 'invalidate'
  >;
  /**
   * Included-Access entitlement readers. Injected rather than imported so the
   * controller stays unit-testable; without them the model list would omit the
   * reasoning cap the entitlement actually enforces.
   */
  readonly modelSelectionExtras: ModelSelectionExtras;
  readonly onCredentialChanged: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

type DesktopProfileHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_IN
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_OUT
  | typeof SETTINGS_VIEW_COMMANDS.SET_API_ACCESS_MODE
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
      globalState: options.globalState,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(options.secrets, API_PROVIDERS),
      getConfig: (key, defaultValue) => options.config.get(key, defaultValue),
      updateConfig: (key, value) => options.config.update(key, value, 'global'),
      setUseIncludedModelAccess: options.setUseIncludedModelAccess,
      refreshSpendingStatus: options.refreshSpendingStatus,
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
      refreshAfterKeyChange: (provider) =>
        this.refreshAfterProviderKeyChange(provider),
    });
    this.profileHandlers = {
      signIn: () => options.auth.signIn(),
      signOut: () => this.signOut(),
      setApiAccessMode: (message) => this.setApiAccessMode(message.mode),
      setProviderKey: (message) =>
        this.setProviderKey(message.provider, message.apiKey),
      removeProviderKey: (message) => this.removeProviderKey(message.provider),
      openProviderKeyUrl: (message) =>
        this.profileKeyController.openProviderKeyUrl(message.provider),
      setProviderSetting: (message) =>
        this.setProviderSetting(message.key, message.value),
      openExternalUrl: (message) =>
        options.externalOpener.openExternal(message.url),
    };
    this.chatGptHandlers = {
      signInChatGpt: () => this.signInChatGpt(),
      signOutChatGpt: () => this.signOutChatGpt(),
      setChatGptPreferSubscription: (message) =>
        this.setChatGptPreferSubscription(message.enabled),
    };
    this.grokHandlers = {
      signInGrok: () => this.signInGrok(),
      signOutGrok: () => this.signOutGrok(),
      setGrokPreferSubscription: (message) =>
        this.setGrokPreferSubscription(message.enabled),
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
    const visibleModels = this.modelSelectionController.getVisibleModels();
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

  private async signInSubscription(options: {
    displayName: string;
    login: (
      openBrowser: (url: string) => Promise<void>,
    ) => Promise<{ email?: string }>;
    accountLabel: (
      session: { email?: string | null } | null | undefined,
    ) => string;
    enablePrefer: () => Promise<unknown>;
    refresh: () => Promise<void>;
  }): Promise<void> {
    try {
      const session = await options.login(async (url) => {
        await this.options.externalOpener.openExternal(url);
        // Informational only — awaiting would block the OAuth callback.
        void Promise.resolve(
          this.options.externalOpener.presentSubscriptionSignInUrl(
            url,
            options.displayName,
          ),
        ).catch(this.options.onError);
      });
      await options.enablePrefer();
      await this.options.notifications.showInfoMessage(
        `Signed in with ${options.displayName} as ${options.accountLabel(session)}.`,
      );
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `${options.displayName} sign-in failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await options.refresh();
    }
  }

  async signInChatGpt(): Promise<void> {
    await this.signInSubscription({
      displayName: 'ChatGPT',
      login: (openBrowser) =>
        loginWithCodexLoopback({
          coordinator: codexCoordinator(),
          openBrowser,
        }),
      accountLabel: codexAccountLabel,
      enablePrefer: () => setPreferCodexSubscription(true),
      refresh: () => this.refreshAfterChatGptAuthChange(),
    });
  }

  async signInGrok(): Promise<void> {
    await this.signInSubscription({
      displayName: 'Grok',
      login: (openBrowser) =>
        loginWithGrokLoopback({
          coordinator: xaiCoordinator(),
          openBrowser,
        }),
      accountLabel: xaiAccountLabel,
      enablePrefer: () => setPreferXaiSubscription(true),
      refresh: () => this.refreshAfterGrokAuthChange(),
    });
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
    const update = await this.profileController.setApiAccessMode(mode);
    await this.postProfileData();
    if (update.kind === 'rejected') {
      await this.options.notifications.showInfoMessage(
        'Included access is unavailable because this month’s quota is exhausted.',
      );
      return;
    }
    await this.postModelSelectionData();
    await this.options.onCredentialChanged();
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
    if (!result.affectsModelAvailability) return;

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
    const relayNotice = relayTokenSignOutNotice();
    if (relayNotice) {
      await this.options.notifications.showInfoMessage(relayNotice);
    }
  }

  private async signOutSubscription(options: {
    displayName: string;
    signOut: () => Promise<void>;
    refresh: () => Promise<void>;
  }): Promise<void> {
    try {
      await options.signOut();
      await this.options.notifications.showInfoMessage(
        `Signed out of ${options.displayName}.`,
      );
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `${options.displayName} sign-out failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await options.refresh();
    }
  }

  private async signOutChatGpt(): Promise<void> {
    await this.signOutSubscription({
      displayName: 'ChatGPT',
      signOut: () => codexCoordinator().signOut(),
      refresh: () => this.refreshAfterChatGptAuthChange(),
    });
  }

  private async signOutGrok(): Promise<void> {
    await this.signOutSubscription({
      displayName: 'Grok',
      signOut: () => xaiCoordinator().signOut(),
      refresh: () => this.refreshAfterGrokAuthChange(),
    });
  }

  private async setSubscriptionPreference(options: {
    displayName: string;
    enabled: boolean;
    setPrefer: (enabled: boolean) => Promise<{ effective: boolean }>;
    refresh: () => Promise<void>;
  }): Promise<void> {
    try {
      const update = await options.setPrefer(options.enabled);
      if (update.effective !== options.enabled) {
        await this.options.notifications.showWarningMessage(
          `A more specific setting still keeps ${options.displayName} subscription ${update.effective ? 'enabled' : 'disabled'}.`,
        );
      }
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        `${options.displayName} subscription preference update failed: ${toErrorMessage(error)}`,
      );
      this.options.onError(error);
    } finally {
      await options.refresh();
    }
  }

  private async setChatGptPreferSubscription(enabled: boolean): Promise<void> {
    await this.setSubscriptionPreference({
      displayName: 'ChatGPT',
      enabled,
      setPrefer: setPreferCodexSubscription,
      refresh: () => this.refreshAfterChatGptAuthChange(),
    });
  }

  private async setGrokPreferSubscription(enabled: boolean): Promise<void> {
    await this.setSubscriptionPreference({
      displayName: 'Grok',
      enabled,
      setPrefer: setPreferXaiSubscription,
      refresh: () => this.refreshAfterGrokAuthChange(),
    });
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
