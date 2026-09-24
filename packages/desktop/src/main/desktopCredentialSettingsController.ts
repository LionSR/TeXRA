// Third-party imports
import { Effect } from 'effect';

// Local imports
import { LoopbackTransportUnavailableError } from '@auth/oauth/loopbackLogin';
import type { SettingsViewInboundHandlerRegistry } from '@controllers/settingsView/settingsViewDispatch';
import { subscriptionAuthStatus } from '@controllers/modelAccess/subscriptionAuthStatus';
import {
  subscriptionProvider,
  type SubscriptionDeviceCodePrompt,
  type SubscriptionProviderId,
  type SubscriptionSignInPresenter,
} from '@controllers/modelAccess/subscriptionProviders';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import {
  SettingsProfileKeyController,
  type ProviderKeyActionFailed,
} from '@controllers/settingsView/SettingsProfileKeyController';
import type { SharedSettingsCommandPorts } from '@controllers/settingsView/sharedSettingsCommands';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import type {
  ExternalOpenFailed,
  ExternalOpener,
  MessageHost,
  PromptHost,
} from '@hosts/uiHosts';
import { API_PROVIDERS, loadApiKeyStatusMap } from '@model/apiProviders';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import { discoveredCopilotRoutes } from '@model/runtimeModelRegistry';
import type { ConfigProvider } from '@platform/interfaces';
import type { LanguageModel } from '@platform/languageModel';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  codingPlanForApiProvider,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import { type SubscriptionUsageProvider } from '@shared/schemas';
import { type UpdateSubscriptionAuthStatusMessage } from '@shared/settingsView/settingsViewMessages';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { allSettledVoid } from '@utils/core/allSettledVoid';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

interface DesktopCredentialSettingsControllerOptions extends SettingsStatePorts {
  readonly config: ConfigProvider;
  readonly secrets: PlatformSecrets;
  /**
   * The project's three setting slots. The availability read resolves this
   * project's routing switches and subscription preferences against them, so a
   * window showing one project never answers with another's values.
   */
  readonly stores: SettingsStores;
  readonly renderer: {
    postToRenderer(message: unknown): void;
  };
  /**
   * The window's dialog surface. `info` is the key-change notice the profile
   * key controller posts; it is bound where the other two are, so the window's
   * dialogs are built in one place.
   */
  readonly prompt: Pick<PromptHost, 'input' | 'confirm' | 'info'>;
  readonly externalOpener: Pick<ExternalOpener, 'openExternal'> & {
    /**
     * Open the loopback consent URL, failing the way {@link ExternalOpener}
     * does. Separate from `openExternal` only because this one must not raise
     * the window's own "could not open" dialog: the sign-in flow reports a
     * missing browser itself, and falls back to a device code instead.
     */
    openSubscriptionSignInUrl(
      url: string,
    ): Effect.Effect<void, ExternalOpenFailed>;
    presentSubscriptionSignInUrl(
      url: string,
      productName: string,
    ): Effect.Effect<void, Error>;
    /**
     * Show the one-time code and verification URL for a device-code sign-in,
     * the fallback when no browser can carry the loopback callback.
     */
    presentSubscriptionDeviceCode(
      prompt: SubscriptionDeviceCodePrompt,
      productName: string,
    ): Effect.Effect<void, Error>;
  };
  readonly notifications: MessageHost;
  readonly auth: {
    signIn(): Effect.Effect<void, Error>;
    signOut(): Promise<void>;
  };
  readonly subscriptionUsage?: Pick<
    SubscriptionUsageService,
    'getAllUsage' | 'invalidate'
  >;
  /** A credential changed: the window's dependent surfaces refresh. A
   *  program like the catalog fan-out below it, so the refresh joins the run
   *  that wrote the credential rather than opening one of its own. */
  readonly onCredentialChanged: () => Effect.Effect<
    void,
    Error,
    ProcessServices
  >;
  /** The model catalog changed: every open paper's `host` snapshot reloads
   *  it (PRD 8.1). */
  readonly onModelOptionsChanged: () => Effect.Effect<
    void,
    never,
    ProcessServices
  >;
  readonly onError: (error: unknown) => void;
  /** The process runtime the composition root built; this controller's
   *  Effect-typed provider calls settle on it. */
  readonly runtime: ProcessRuntime;
}

type DesktopProfileHandlers = Pick<
  SettingsViewInboundHandlerRegistry,
  typeof SETTINGS_VIEW_COMMANDS.SIGN_IN | typeof SETTINGS_VIEW_COMMANDS.SIGN_OUT
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
 * `SUBSCRIPTION_PROVIDERS` catalog deliberately does not carry: the usage
 * snapshot (ChatGPT only) that an auth change invalidates. Kept host-side
 * because the catalog also serves the CLI, which has no settings view.
 */
const SUBSCRIPTION_USAGE_PROVIDERS_BY_ID: Readonly<
  Partial<Record<SubscriptionProviderId, SubscriptionUsageProvider>>
> = { chatgpt: 'chatgpt' };

export interface DesktopCredentialSettingsController {
  readonly profileHandlers: DesktopProfileHandlers;
  readonly chatGptHandlers: DesktopChatGptHandlers;
  readonly grokHandlers: DesktopGrokHandlers;
  readonly modelSelectionController: SettingsModelSelectionController<LanguageModel>;
  /** The provider-key arms are the shared settings body's; this controller
   *  owns the key policy and the window's report of a failed key write. */
  readonly profileKeyController: SharedSettingsCommandPorts['profileKeys'];
  reportProviderKeyFailure(
    error: ProviderKeyActionFailed,
  ): Effect.Effect<void, Error, ProcessServices>;
  /**
   * The posts and refreshes below are programs, so a key write and the
   * repaint it triggers are one run at the window's IPC, not a chain of them.
   */
  /** The enabled-model set or a credential changed the model catalog. */
  refreshModelOptions(): Effect.Effect<void, Error, ProcessServices>;
  /** Re-posts the profile snapshot after a catalog-routed credential write. */
  postProfileData(): Effect.Effect<void, Error, ProcessServices>;
  postStartupData(): Effect.Effect<void, Error, ProcessServices>;
  postSubscriptionUsage(
    forceRefresh?: boolean,
  ): Effect.Effect<void, Error, ProcessServices>;
  refreshAfterProviderSettingChange(
    key: string,
  ): Effect.Effect<void, Error, ProcessServices>;
  refreshAfterProviderKeyChange(
    provider: string,
  ): Effect.Effect<void, Error, ProcessServices>;
  refreshAuthDependentData(): Effect.Effect<void, Error, ProcessServices>;
  /** Also driven by the desktop welcome card, not just the Settings view. */
  signInChatGpt(): Effect.Effect<void, Error, ProcessServices>;
}

/** Owns desktop credential mutation, authentication, and dependent refreshes. */
export class DefaultDesktopCredentialSettingsController implements DesktopCredentialSettingsController {
  readonly profileHandlers: DesktopProfileHandlers;
  readonly chatGptHandlers: DesktopChatGptHandlers;
  readonly grokHandlers: DesktopGrokHandlers;
  readonly modelSelectionController: SettingsModelSelectionController<LanguageModel>;
  readonly profileKeyController: SettingsProfileKeyController<ProcessServices>;

  private readonly profileController: SettingsProfileController;
  private readonly subscriptionUsage: Pick<
    SubscriptionUsageService,
    'getAllUsage' | 'invalidate'
  >;

  constructor(
    private readonly options: DesktopCredentialSettingsControllerOptions,
  ) {
    this.subscriptionUsage =
      options.subscriptionUsage ??
      new SubscriptionUsageService({
        secrets: options.secrets,
        stores: options.stores,
      });
    this.modelSelectionController = new SettingsModelSelectionController({
      stores: options.stores,
      secrets: options.secrets,
      resolveModelOptions: (stores, models) =>
        Effect.map(
          readModelAvailabilityInputs(stores, models),
          modelOptionsFrom,
        ),
      copilotRoutes: discoveredCopilotRoutes(),
    });
    this.profileController = new SettingsProfileController({
      host: 'desktop',
      // The Models-tab toggles resolve through the catalog's own slots, so the
      // controller takes the project's three stores rather than one store and
      // a config reader.
      stores: {
        config: options.config,
        workspaceState: options.workspaceState,
        globalState: options.globalState,
      },
      loadProviderKeyStatuses: loadApiKeyStatusMap(
        options.secrets,
        API_PROVIDERS,
      ),
    });
    this.profileKeyController = new SettingsProfileKeyController({
      secrets: options.secrets,
      prompt: options.prompt,
      externalOpener: options.externalOpener,
      getProviderDisplayName: (provider) =>
        this.profileController.getProviderDisplayName(provider),
      getProviderKeyUrl: (provider) =>
        getProviderKeyUrl(options.stores, provider),
      refreshAfterKeyChange: (provider) =>
        this.refreshAfterProviderKeyChange(provider),
    });
    this.profileHandlers = {
      // The settings view's Sign in button is a host entry, so the sign-in
      // program settles here.
      signIn: () => options.auth.signIn(),
      signOut: () =>
        Effect.tryPromise({
          try: () => options.auth.signOut(),
          catch: ensureError,
        }),
    };
    // Each arm is a settings-view message, so the subscription programs settle
    // here exactly as the profile arms above do.
    this.chatGptHandlers = {
      signInChatGpt: () => this.signInSubscription('chatgpt'),
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

  reportProviderKeyFailure(error: ProviderKeyActionFailed) {
    return Effect.gen({ self: this }, function* () {
      yield* this.options.notifications.showErrorMessage(
        `${error.message}: ${toErrorMessage(error.cause)}`,
      );
      this.options.onError(error.cause);
      yield* this.postProfileData();
    });
  }

  postStartupData() {
    return allSettledVoid([
      this.postProfileData(),
      this.postAuthStatus('chatgpt'),
      this.postAuthStatus('grok'),
    ]);
  }

  postSubscriptionUsage(forceRefresh = false) {
    return Effect.map(
      this.subscriptionUsage.getAllUsage({ forceRefresh }),
      (snapshots) => {
        this.options.renderer.postToRenderer({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
          snapshots,
        });
      },
    );
  }

  /** Every open paper reloads the model catalog: the window's own fan-out. */
  refreshModelOptions() {
    return this.options.onModelOptionsChanged();
  }

  refreshAuthDependentData() {
    return this.postModelSelectionData().pipe(
      Effect.andThen(this.refreshModelOptions()),
      Effect.andThen(this.postProfileData()),
    );
  }

  /**
   * Show one informational part of a sign-in without waiting for it, and
   * report a failure the way an awaited presentation would: the cause goes to
   * `onError`, then the dialog says which presentation could not be shown. A
   * dialog that itself fails is reported through the same `onError`. Failing
   * to *show* a notice never aborts the sign-in the notice merely describes.
   */
  private presentInBackground(
    displayName: string,
    present: Effect.Effect<void, Error>,
  ): void {
    const options = this.options;
    options.runtime.runFork(
      present.pipe(
        Effect.catch((failure) =>
          Effect.gen(function* () {
            options.onError(failure);
            yield* options.notifications
              .showErrorMessage(
                `Failed to display ${displayName} sign-in instructions: ${toErrorMessage(failure)}`,
              )
              .pipe(
                Effect.catchTag('NotificationFailed', (notice) =>
                  Effect.sync(() => {
                    options.onError(notice.cause);
                  }),
                ),
              );
          }),
        ),
      ),
    );
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
        // Informational only — awaiting would block the approval poll, and a
        // presenter failure is contained rather than failing the poll.
        this.presentInBackground(
          displayName,
          this.options.externalOpener.presentSubscriptionDeviceCode(
            prompt,
            displayName,
          ),
        );
      },
      // The loopback flow runs this to completion before it starts the
      // callback wait, so a window that cannot reach a browser fails the
      // transport here rather than waiting for a callback nobody can deliver.
      presentSignInUrl: (url) =>
        this.options.externalOpener.openSubscriptionSignInUrl(url).pipe(
          Effect.mapError(
            (failure) =>
              new LoopbackTransportUnavailableError(
                `Could not open a browser for ${displayName} sign-in.`,
                { cause: failure.cause },
              ),
          ),
          Effect.andThen(
            Effect.sync(() => {
              // Informational only — awaiting would block the OAuth callback,
              // and a presenter failure is contained rather than failing the
              // callback wait.
              this.presentInBackground(
                displayName,
                this.options.externalOpener.presentSubscriptionSignInUrl(
                  url,
                  displayName,
                ),
              );
            }),
          ),
        ),
    };
  }

  /**
   * Runs a subscription-provider mutation, reporting any failure through the
   * shared notify/onError shape and always refreshing auth-dependent data
   * afterward — the one piece of control flow sign-in, sign-out, and the
   * preference toggle all share.
   */
  private withSubscriptionAuthChange(
    providerId: SubscriptionProviderId,
    buildErrorMessage: (
      provider: ReturnType<typeof subscriptionProvider>,
      error: unknown,
    ) => string,
    work: (
      provider: ReturnType<typeof subscriptionProvider>,
    ) => Effect.Effect<void, Error, ProcessServices>,
  ) {
    const provider = subscriptionProvider(providerId);
    const options = this.options;
    const refresh = this.refreshAfterSubscriptionAuthChange(providerId);
    const attempt = work(provider).pipe(
      Effect.catch((error) =>
        options.notifications
          .showErrorMessage(buildErrorMessage(provider, error))
          .pipe(Effect.andThen(Effect.sync(() => options.onError(error)))),
      ),
    );
    return Effect.gen(function* () {
      // The refresh is the old `finally`: it runs on every path, and its own
      // failure replaces whatever the attempt left behind.
      const attempted = yield* Effect.exit(attempt);
      yield* refresh;
      return yield* attempted;
    });
  }

  private signInSubscription(providerId: SubscriptionProviderId) {
    return this.withSubscriptionAuthChange(
      providerId,
      (provider, error) =>
        `${provider.displayName} sign-in failed: ${toErrorMessage(error)}`,
      (provider) =>
        Effect.gen({ self: this }, function* () {
          const account = yield* provider.signIn({
            transport: 'auto',
            present: this.signInPresenter(provider.displayName),
          });
          yield* provider.setPreferSubscription(this.options.stores, true);
          yield* this.options.notifications.showInfoMessage(
            ACCOUNT_OUTCOME.signedInAs(provider.displayName, account.label),
          );
        }),
    );
  }

  signInChatGpt() {
    return this.signInSubscription('chatgpt');
  }

  /**
   * Re-post everything a catalog-backed provider toggle can change. The write
   * itself happens on the shared `UPDATE_STATE_SETTING` path, which owns
   * validation and the row's `onWrite` exclusions; this is the desktop's half
   * of the refresh.
   */
  refreshAfterProviderSettingChange(key: string) {
    return Effect.gen({ self: this }, function* () {
      yield* this.postProfileData();
      if (codingPlanForUsageSetting(key)) {
        yield* this.postSubscriptionUsage();
      }
      yield* this.postModelSelectionData();
      yield* this.refreshModelOptions();
      yield* this.options.onCredentialChanged();
    });
  }

  /**
   * Repaint what depends on one provider's key. Run by the settings
   * round-trip that wrote the key and by the window's `credentialChanged`
   * subscriber, which covers every other writer (the setup agent's
   * `unset_api_key`, another window).
   */
  refreshAfterProviderKeyChange(provider: string) {
    return Effect.gen({ self: this }, function* () {
      const usageProvider = codingPlanForApiProvider(provider)?.usageProvider;
      if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
      yield* this.postProfileData();
      yield* this.postModelSelectionData();
      yield* this.refreshModelOptions();
      if (usageProvider) yield* this.postSubscriptionUsage();
      yield* this.options.onCredentialChanged();
    });
  }

  private refreshAfterSubscriptionAuthChange(
    providerId: SubscriptionProviderId,
  ) {
    return Effect.gen({ self: this }, function* () {
      const usageProvider = SUBSCRIPTION_USAGE_PROVIDERS_BY_ID[providerId];
      if (usageProvider) this.subscriptionUsage.invalidate(usageProvider);
      const posts: Effect.Effect<void, Error, ProcessServices>[] = [
        this.postAuthStatus(providerId),
        this.postModelSelectionData(),
        this.refreshModelOptions(),
      ];
      if (usageProvider) posts.push(this.postSubscriptionUsage());
      yield* allSettledVoid(posts);
      yield* this.options.onCredentialChanged();
    });
  }

  private signOutSubscription(providerId: SubscriptionProviderId) {
    return this.withSubscriptionAuthChange(
      providerId,
      (provider, error) =>
        ACCOUNT_OUTCOME.signOutFailedWithReason(
          provider.displayName,
          toErrorMessage(error),
        ),
      (provider) =>
        provider
          .signOut(this.options.secrets)
          .pipe(
            Effect.andThen(
              this.options.notifications.showInfoMessage(
                ACCOUNT_OUTCOME.signedOut(provider.displayName),
              ),
            ),
          ),
    );
  }

  private setSubscriptionPreference(
    providerId: SubscriptionProviderId,
    enabled: boolean,
  ) {
    return this.withSubscriptionAuthChange(
      providerId,
      (provider, error) =>
        `${provider.displayName} subscription preference update failed: ${toErrorMessage(error)}`,
      (provider) =>
        provider.setPreferSubscription(this.options.stores, enabled),
    );
  }

  postProfileData() {
    return Effect.map(
      this.profileController.buildProfileMessage(),
      (message) => {
        this.options.renderer.postToRenderer(message);
      },
    );
  }

  private postAuthStatus(providerId: SubscriptionProviderId) {
    return Effect.map(
      subscriptionAuthStatus(
        providerId,
        this.options.stores,
        this.options.secrets,
      ),
      (status) => {
        this.options.renderer.postToRenderer({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_AUTH_STATUS,
          status,
        } satisfies UpdateSubscriptionAuthStatusMessage);
      },
    );
  }

  private postModelSelectionData() {
    return Effect.map(
      this.modelSelectionController.buildModelSelectionMessage(),
      (message) => {
        this.options.renderer.postToRenderer(message);
      },
    );
  }
}
