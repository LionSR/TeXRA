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
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type { ExternalOpener, MessageHost, PromptHost } from '@hosts/uiHosts';
import {
  API_PROVIDERS,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import type { ConfigProvider } from '@platform/interfaces';
import { effectRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  codingPlanForApiProvider,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import {
  SUBSCRIPTION_USAGE_PROVIDERS,
  type SettingsViewInboundHandlerRegistry,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshots,
  type UpdateChatGptAuthStatusMessage,
  type UpdateGrokAuthStatusMessage,
} from '@shared/schemas';
import { ACCOUNT_OUTCOME } from '@shared/copy/accountAuth';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface DesktopCredentialSettingsControllerOptions extends SettingsStatePorts {
  readonly config: ConfigProvider;
  readonly secrets: PlatformSecrets;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  readonly prompt: Pick<PromptHost, 'input' | 'confirm'>;
  readonly externalOpener: Pick<ExternalOpener, 'openExternal'> & {
    openSubscriptionSignInUrl(url: string): Promise<void>;
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
  readonly notifications: MessageHost;
  readonly auth: {
    signIn(): Promise<void>;
    signOut(): Promise<void>;
  };
  readonly subscriptionUsage?: Pick<
    SubscriptionUsageService,
    'getUsage' | 'invalidate'
  >;
  readonly onCredentialChanged: () => Promise<void>;
  /** The model catalog changed: every open paper's `host` snapshot reloads
   *  it (PRD 8.1). */
  readonly onModelOptionsChanged: () => Promise<void>;
  readonly onError: (error: unknown) => void;
}

type DesktopProfileHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_IN
  | typeof SETTINGS_VIEW_COMMANDS.SIGN_OUT
  | typeof SETTINGS_VIEW_COMMANDS.SET_PROVIDER_KEY
  | typeof SETTINGS_VIEW_COMMANDS.REMOVE_PROVIDER_KEY
  | typeof SETTINGS_VIEW_COMMANDS.OPEN_PROVIDER_KEY_URL
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

/**
 * The settings-view half of a subscription provider, which the host-neutral
 * `SUBSCRIPTION_PROVIDERS` catalog deliberately does not carry: the outbound
 * status message this renderer listens for, and the usage snapshot (ChatGPT
 * only) that an auth change invalidates. Kept host-side because the catalog
 * also serves the CLI, which has no settings view. Adding a third provider is
 * one row here, not another pair of hand-copied methods below.
 */
const SUBSCRIPTION_STATUS_ROWS: Record<
  SubscriptionProviderId,
  {
    readonly buildStatusMessage: () => Promise<unknown>;
    readonly usageProvider?: SubscriptionUsageProvider;
  }
> = {
  chatgpt: {
    buildStatusMessage: async () =>
      ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_CHATGPT_AUTH_STATUS,
        status: await getChatGptAuthStatus(),
      }) satisfies UpdateChatGptAuthStatusMessage,
    usageProvider: 'chatgpt',
  },
  grok: {
    buildStatusMessage: async () =>
      ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GROK_AUTH_STATUS,
        status: await getGrokAuthStatus(),
      }) satisfies UpdateGrokAuthStatusMessage,
  },
};

export interface DesktopCredentialSettingsController {
  readonly profileHandlers: DesktopProfileHandlers;
  readonly chatGptHandlers: DesktopChatGptHandlers;
  readonly grokHandlers: DesktopGrokHandlers;
  readonly modelSelectionController: SettingsModelSelectionController;
  /** The enabled-model set or a credential changed the model catalog. */
  refreshModelOptions(): Promise<void>;
  /** Re-posts the profile snapshot after a catalog-routed credential write. */
  postProfileData(): Promise<void>;
  postStartupData(): Promise<void>;
  postSubscriptionUsage(forceRefresh?: boolean): Promise<void>;
  refreshAfterProviderSettingChange(key: string): Promise<void>;
  refreshAuthDependentData(): Promise<void>;
  signInChatGpt(): Promise<void>;
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
      globalState: options.globalState,
    });
    this.profileController = new SettingsProfileController({
      host: 'desktop',
      globalState: options.globalState,
      loadProviderKeyStatuses: () =>
        loadApiKeyStatusMap(options.secrets, API_PROVIDERS),
      getConfig: (key, defaultValue) => options.config.get(key, defaultValue),
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
      getProviderKeyUrl,
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
      signOut: () => options.auth.signOut(),
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
      openExternalUrl: (message) =>
        options.externalOpener.openExternal(message.url),
    };
    this.chatGptHandlers = {
      signInChatGpt: () => this.signInChatGpt(),
      signOutChatGpt: () => this.signOutSubscription('chatgpt'),
      setChatGptPreferSubscription: (message) =>
        this.setSubscriptionPreference('chatgpt', message.enabled),
    };
    this.grokHandlers = {
      signInGrok: () => this.signInSubscription('grok'),
      signOutGrok: () => this.signOutSubscription('grok'),
      setGrokPreferSubscription: (message) =>
        this.setSubscriptionPreference('grok', message.enabled),
    };
  }

  async postStartupData(): Promise<void> {
    await Promise.all([
      this.postProfileData(),
      this.postAuthStatus('chatgpt'),
      this.postAuthStatus('grok'),
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

  refreshModelOptions(): Promise<void> {
    return this.options.onModelOptionsChanged();
  }

  async refreshAuthDependentData(): Promise<void> {
    await this.postModelSelectionData();
    await this.refreshModelOptions();
    await this.postProfileData();
  }

  /**
   * Desktop presentation for a subscription sign-in. The loopback browser is
   * the normal route; failing to reach one is reported as a transport
   * failure so the shared flow can retry with a device code, which this host
   * shows in its own dialog.
   */
  private reportSignInPresentationFailure(
    displayName: string,
    error: unknown,
  ): void {
    this.options.onError(error);
    void Promise.resolve(
      this.options.notifications.showErrorMessage(
        `Failed to display ${displayName} sign-in instructions: ${toErrorMessage(error)}`,
      ),
    ).catch(this.options.onError);
  }

  private signInPresenter(displayName: string): SubscriptionSignInPresenter {
    return {
      presentDeviceCode: (prompt) => {
        // Informational only — awaiting would block the approval poll.
        void Promise.resolve(
          this.options.externalOpener.presentSubscriptionDeviceCode(
            prompt,
            displayName,
          ),
        ).catch((error: unknown) =>
          this.reportSignInPresentationFailure(displayName, error),
        );
      },
      presentSignInUrl: async (url) => {
        try {
          await this.options.externalOpener.openSubscriptionSignInUrl(url);
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
        ).catch((error: unknown) =>
          this.reportSignInPresentationFailure(displayName, error),
        );
      },
    };
  }

  /**
   * Runs a subscription-provider mutation, reporting any failure through the
   * shared notify/onError shape and always refreshing auth-dependent data
   * afterward — the one piece of control flow sign-in, sign-out, and the
   * preference toggle all share.
   */
  private async withSubscriptionAuthChange(
    providerId: SubscriptionProviderId,
    buildErrorMessage: (
      provider: ReturnType<typeof subscriptionProvider>,
      error: unknown,
    ) => string,
    work: (provider: ReturnType<typeof subscriptionProvider>) => Promise<void>,
  ): Promise<void> {
    const provider = subscriptionProvider(providerId);
    try {
      await work(provider);
    } catch (error) {
      await this.options.notifications.showErrorMessage(
        buildErrorMessage(provider, error),
      );
      this.options.onError(error);
    } finally {
      await this.refreshAfterSubscriptionAuthChange(providerId);
    }
  }

  private signInSubscription(
    providerId: SubscriptionProviderId,
  ): Promise<void> {
    return this.withSubscriptionAuthChange(
      providerId,
      (provider, error) =>
        `${provider.displayName} sign-in failed: ${toErrorMessage(error)}`,
      async (provider) => {
        const account = await effectRuntime().runPromise(
          provider.signIn({
            transport: 'auto',
            present: this.signInPresenter(provider.displayName),
          }),
        );
        await provider.setPreferSubscription(true);
        await this.options.notifications.showInfoMessage(
          ACCOUNT_OUTCOME.signedInAs(provider.displayName, account.label),
        );
      },
    );
  }

  /** Also driven by the desktop welcome card, not just the Settings view. */
  signInChatGpt(): Promise<void> {
    return this.signInSubscription('chatgpt');
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
    await this.refreshModelOptions();
    await this.options.onCredentialChanged();
  }

  private async refreshAfterProviderKeyChange(provider: string): Promise<void> {
    invalidateApiKeyCache();
    const usageProvider = codingPlanForApiProvider(provider)?.usageProvider;
    if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
    await this.postProfileData();
    await this.postModelSelectionData();
    await this.refreshModelOptions();
    if (usageProvider) await this.postSubscriptionUsage();
    await this.options.onCredentialChanged();
  }

  private async refreshAfterSubscriptionAuthChange(
    providerId: SubscriptionProviderId,
  ): Promise<void> {
    const { usageProvider } = SUBSCRIPTION_STATUS_ROWS[providerId];
    if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
    await Promise.all([
      this.postAuthStatus(providerId),
      this.postModelSelectionData(),
      this.refreshModelOptions(),
      ...(usageProvider ? [this.postSubscriptionUsage()] : []),
    ]);
    await this.options.onCredentialChanged();
  }

  private signOutSubscription(
    providerId: SubscriptionProviderId,
  ): Promise<void> {
    return this.withSubscriptionAuthChange(
      providerId,
      (provider, error) =>
        ACCOUNT_OUTCOME.signOutFailedWithReason(
          provider.displayName,
          toErrorMessage(error),
        ),
      async (provider) => {
        await provider.signOut();
        await this.options.notifications.showInfoMessage(
          ACCOUNT_OUTCOME.signedOut(provider.displayName),
        );
      },
    );
  }

  private setSubscriptionPreference(
    providerId: SubscriptionProviderId,
    enabled: boolean,
  ): Promise<void> {
    return this.withSubscriptionAuthChange(
      providerId,
      (provider, error) =>
        `${provider.displayName} subscription preference update failed: ${toErrorMessage(error)}`,
      async (provider) => {
        const update = await provider.setPreferSubscription(enabled);
        if (update.effective !== enabled) {
          await this.options.notifications.showWarningMessage(
            `A more specific setting still keeps ${provider.displayName} subscription ${update.effective ? 'enabled' : 'disabled'}.`,
          );
        }
      },
    );
  }

  async postProfileData(): Promise<void> {
    this.options.renderer.postToRenderer(
      await this.profileController.buildProfileMessage(),
    );
  }

  private async postAuthStatus(
    providerId: SubscriptionProviderId,
  ): Promise<void> {
    this.options.renderer.postToRenderer(
      await SUBSCRIPTION_STATUS_ROWS[providerId].buildStatusMessage(),
    );
  }

  private async postModelSelectionData(): Promise<void> {
    this.options.renderer.postToRenderer(
      await this.modelSelectionController.buildModelSelectionMessage(),
    );
  }
}
