/**
 * The settings view's body, once for both GUI hosts. The extension and the
 * desktop each answered the same commands with the same controllers, the same
 * refresh tails and the same error sentences, drifting apart one arm at a
 * time; the body lives here and a host binds a table of what it performs its
 * own way: how a message reaches its view, how it asks and tells the user,
 * how it opens a file or picks a folder, and how its launchers reload.
 *
 * A host spreads the body's `handlers` into its
 * `SettingsViewInboundHandlerRegistry`, keeps its own entries for the
 * commands only it answers (its account sign-in, the Copilot routes, the
 * Tools and LaTeX pages), and routes every inbound message through the
 * body's `handleMessage`, the one parse and report boundary. The binding
 * table is `settingsHostBindings.ts`.
 */
import { Cause, Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { subscriptionAuthStatus } from '@controllers/modelAccess/subscriptionAuthStatus';
import {
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@controllers/modelAccess/subscriptionProviders';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { SettingsModelSelectionController } from '@controllers/settingsView/SettingsModelSelectionController';
import { SettingsProfileController } from '@controllers/settingsView/SettingsProfileController';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import { settingsAgentCommands } from '@controllers/settingsView/settingsAgentCommands';
import {
  SETTINGS_LOG_CHANNEL,
  settingsPresentation,
  type SettingsHostBindings,
} from '@controllers/settingsView/settingsHostBindings';
import { settingsGitCommands } from '@controllers/settingsView/settingsGitCommands';
import { settingsMemoryCommands } from '@controllers/settingsView/settingsMemoryCommands';
import {
  settingsViewProgram,
  type SettingsViewInboundHandlerRegistry,
} from '@controllers/settingsView/settingsViewDispatch';
import { withLogChannel } from '@logger/effectLog';
import {
  API_PROVIDERS,
  apiProviderOfSecretName,
  loadApiKeyStatusMap,
} from '@model/apiProviders';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import { discoverCopilotRoutes } from '@model/copilotRouting';
import type { ProcessServices } from '@platform/processRuntime';
import { type StorageFs, withSessionFs } from '@platform/rootedFs';
import type { PlatformSecrets } from '@platform/secrets';
import {
  codingPlanForApiProvider,
  codingPlanForUsageSetting,
} from '@shared/codingPlanSubscriptions';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { SubscriptionUsageProvider } from '@shared/schemas';
import { buildSettingsSnapshotMessage } from '@shared/settingsView/handlers/settingsSnapshot';
import {
  applyStateSettingUpdate,
  type SettingsSnapshotPosters,
} from '@shared/settingsView/handlers/stateSettingWrite';
import {
  SettingsViewInboundMessageSchema,
  SUBSCRIPTION_AUTH_PROVIDERS,
  type DerivedSettingsSnapshot,
  type SettingsViewOutboundMessage,
} from '@shared/settingsView/settingsViewMessages';
import { UnsupportedCommandError } from '@shared/utils/dispatcher';
import { GITHUB_TOKEN_CREATE_URL } from '@tools/github/githubAuth';
import { refreshToolAvailability } from '@tools/toolAvailability';
import { getProviderKeyUrl } from '@utils/config/providerConfig';
import { allSettledVoid } from '@utils/core/allSettledVoid';

type HostEffect<A = void> = Effect.Effect<A, Error, ProcessServices>;
type SettingsArms = SettingsViewInboundHandlerRegistry<
  ProcessServices | StorageFs
>;

/**
 * The usage snapshot a subscription's auth change invalidates (ChatGPT
 * only). The host-neutral subscription catalog does not carry it because it
 * also serves the CLI, which has no settings view.
 */
const SUBSCRIPTION_USAGE_PROVIDERS_BY_ID: Readonly<
  Partial<Record<SubscriptionProviderId, SubscriptionUsageProvider>>
> = { chatgpt: 'chatgpt' };

interface SettingsViewBodyPorts {
  readonly host: 'vscode' | 'desktop';
  readonly session: Pick<SessionHandle, 'roots' | 'setApprovalPolicy'>;
  readonly secrets: PlatformSecrets;
  /** The packaged resources root; the agent templates live under it. */
  readonly resourcesPath: string;
  readonly bindings: SettingsHostBindings;
  /** The skills the Skills page lists, from the skills subsystem, which
   *  controllers take from their host rather than import. */
  readonly skillDisplay: HostEffect<
    Omit<
      Extract<SettingsViewOutboundMessage, { command: 'updateSkillsList' }>,
      'command'
    >
  >;
  /** The account copy (`src/ui`), which controllers likewise take from
   *  their host. */
  readonly accountCopy: {
    signedOut(providerDisplayName: string): string;
    signOutFailed(providerDisplayName: string): string;
  };
}

/** Build the settings body over one host's bindings. */
export function createSettingsViewBody(ports: SettingsViewBodyPorts) {
  const { bindings, secrets } = ports;
  const { roots } = ports.session;

  const present = settingsPresentation(bindings);
  const { notice, report, reported } = present;

  // ── Controllers ──

  const profile = new SettingsProfileController({
    host: ports.host,
    stores: roots,
    loadProviderKeyStatuses: loadApiKeyStatusMap(secrets, API_PROVIDERS),
  });
  const modelSelection = new SettingsModelSelectionController({
    stores: roots,
    secrets,
    resolveModelOptions: (stores, models) =>
      Effect.map(readModelAvailabilityInputs(stores, models), modelOptionsFrom),
    copilotRoutes: discoverCopilotRoutes(),
  });
  const usage = new SubscriptionUsageService({ secrets, stores: roots });
  const memoryPage = settingsMemoryCommands({ bindings, present });
  const gitPage = settingsGitCommands({ bindings, present, secrets });
  const agents = settingsAgentCommands({
    roots,
    resourcesPath: ports.resourcesPath,
    bindings,
    present,
  });

  // ── Posts ──

  const postProfile = bindings.post(profile.buildProfileMessage());
  const postModelSelection = bindings.post(
    modelSelection.buildModelSelectionMessage(),
  );
  const postSnapshot = (snapshot: DerivedSettingsSnapshot) =>
    bindings.post(buildSettingsSnapshotMessage(snapshot, roots, ports.host));
  const postSkills = bindings.post(
    Effect.map(ports.skillDisplay, (result) => ({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_SKILLS_LIST,
      ...result,
    })),
  );
  const postUsage = (forceRefresh: boolean) =>
    bindings.post(
      Effect.map(usage.getAllUsage({ forceRefresh }), (snapshots) => ({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_USAGE,
        snapshots,
      })),
    );
  const postAuthStatus = (providerId: SubscriptionProviderId) =>
    bindings.post(
      Effect.map(
        subscriptionAuthStatus(providerId, roots, secrets),
        (status) => ({
          command: SETTINGS_VIEW_COMMANDS.UPDATE_SUBSCRIPTION_AUTH_STATUS,
          status,
        }),
      ),
    );
  // ── Refresh tails ──

  /**
   * Every surface a credential feeds: the probes outside this view first,
   * since model availability reads the key state they settle, then the
   * launchers' catalogs, the profile, the Models page and, when the
   * credential is a coding plan's, its usage.
   */
  const refreshAfterCredentialChange = (
    usageProvider?: SubscriptionUsageProvider,
  ): HostEffect =>
    Effect.gen(function* () {
      if (usageProvider) usage.invalidate(usageProvider);
      yield* bindings.refreshCredentialStatus;
      yield* allSettledVoid<Error, ProcessServices>([
        bindings.refreshCatalogs(),
        postProfile,
        postModelSelection,
        ...(usageProvider ? [postUsage(false)] : []),
      ]);
    });
  const refreshAfterProviderKeyChange = (provider: string) =>
    refreshAfterCredentialChange(
      codingPlanForApiProvider(provider)?.usageProvider,
    );
  /** Run a subscription mutation, report its failure, and repaint what the
   *  subscription feeds whatever the mutation did. */
  const subscriptionChange = <E>(
    providerId: SubscriptionProviderId,
    failure: string,
    work: Effect.Effect<void, E, ProcessServices>,
  ) =>
    Effect.andThen(
      reported(failure, work),
      allSettledVoid<Error, ProcessServices>([
        postAuthStatus(providerId),
        refreshAfterCredentialChange(
          SUBSCRIPTION_USAGE_PROVIDERS_BY_ID[providerId],
        ),
      ]),
    );
  const signInSubscription = (providerId: SubscriptionProviderId) =>
    subscriptionChange(
      providerId,
      `${subscriptionProvider(providerId).displayName} sign-in failed`,
      bindings.signInSubscription(providerId),
    );
  const signOutSubscription = (providerId: SubscriptionProviderId) => {
    const provider = subscriptionProvider(providerId);
    return subscriptionChange(
      providerId,
      ports.accountCopy.signOutFailed(provider.displayName),
      Effect.andThen(
        provider.signOut(secrets),
        notice(ports.accountCopy.signedOut(provider.displayName)),
      ),
    );
  };
  const setPreferSubscription = (
    providerId: SubscriptionProviderId,
    enabled: boolean,
  ) => {
    const provider = subscriptionProvider(providerId);
    return subscriptionChange(
      providerId,
      `Could not update the ${provider.displayName} subscription preference`,
      provider.setPreferSubscription(roots, enabled),
    );
  };

  // ── Catalog-backed settings rows ──

  const stateSnapshotPosters: SettingsSnapshotPosters<HostEffect> = {
    approval: () => postSnapshot('approval'),
    'git-author': () => postSnapshot('git-author'),
    latex: () => postSnapshot('latex'),
    memory: () => postSnapshot('memory'),
    models: () => postModelSelection,
    'multi-agent': () => postSnapshot('multi-agent'),
    profile: () => postProfile,
    skills: () => Effect.andThen(postSnapshot('skills'), postSkills),
    telemetry: () => postSnapshot('telemetry'),
  };
  const updateStateSetting = (key: string, value: unknown) =>
    Effect.gen(function* () {
      const result = yield* applyStateSettingUpdate(key, value, {
        host: ports.host,
        stores: roots,
        requiresOpenWorkspace: bindings.requiresOpenWorkspace,
        onApprovalPolicyChanged: (policy) =>
          ports.session.setApprovalPolicy(policy),
      });
      if (result.kind === 'ignored') return;
      const label = result.entry.title ?? result.entry.key;
      if (result.kind === 'rejected') {
        yield* report(`Invalid value for “${label}”`, result.error);
      } else if (result.kind === 'failed') {
        yield* report(`Failed to update “${label}”`, result.error);
      } else if (result.kind === 'workspace-required') {
        yield* notice(
          `Open a workspace folder before changing the “${label}” setting.`,
        );
      }
      yield* stateSnapshotPosters[result.entry.surfaces.settingsView]();
      if (result.kind !== 'applied') return;
      if (result.entry.onWrite?.invalidatesModelOptions) {
        yield* refreshAfterCredentialChange();
      }
      if (codingPlanForUsageSetting(key) !== undefined) {
        yield* postUsage(false);
      }
      yield* bindings.stateSettingApplied(key);
    });

  const profileKeys = new SettingsProfileKeyController({
    secrets,
    prompt: bindings.prompt,
    externalOpener: bindings.externalOpener,
    getProviderDisplayName: (provider) =>
      profile.getProviderDisplayName(provider),
    getProviderKeyUrl: (provider) => getProviderKeyUrl(roots, provider),
    refreshAfterKeyChange: refreshAfterProviderKeyChange,
  });
  // A failed key write leaves the profile and the Models page showing the
  // key as it was before the attempt. The report is the notice: a repaint
  // that fails after it is logged, not raised as a second dialog.
  const keyAction = (action: ReturnType<typeof profileKeys.setProviderKey>) =>
    action.pipe(
      Effect.catchTag('ProviderKeyActionFailed', (error) =>
        Effect.andThen(
          report(error.message, error.cause),
          Effect.andThen(postProfile, postModelSelection).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                'Could not repaint the profile after a failed key write',
              ).pipe(
                Effect.annotateLogs({ data: cause }),
                withLogChannel(SETTINGS_LOG_CHANNEL),
              ),
            ),
          ),
        ),
      ),
    );

  const postAll = allSettledVoid<Error, ProcessServices | StorageFs>([
    ...(
      [
        'memory',
        'multi-agent',
        'git-author',
        'approval',
        'skills',
        'telemetry',
        'latex',
      ] as const
    ).map(postSnapshot),
    postSkills,
    memoryPage.postMemoryData,
    postProfile,
    postModelSelection,
    agents.postStartup,
    gitPage.postTokenStatus,
    gitPage.postSubscriptions,
    ...SUBSCRIPTION_AUTH_PROVIDERS.map(postAuthStatus),
    bindings.postHostStartup,
  ]);

  const handlers = {
    // Other views share the command and want none of this.
    webviewReady: (message) =>
      message.view == null || message.view === 'settings'
        ? postAll
        : Effect.void,
    ...agents.handlers,
    setProviderKey: (message) =>
      keyAction(profileKeys.setProviderKey(message.provider)),
    removeProviderKey: (message) =>
      keyAction(profileKeys.removeProviderKey(message.provider)),
    openProviderKeyUrl: (message) =>
      profileKeys.openProviderKeyUrl(message.provider),
    openExternalUrl: (message) =>
      bindings.externalOpener.openExternal(message.url),
    openGitHubTokenUrl: () =>
      bindings.externalOpener.openExternal(GITHUB_TOKEN_CREATE_URL),
    openToolInstallUrl: (message) =>
      bindings.externalOpener.openExternal(message.url),
    setModelEnabled: (message) =>
      modelSelection
        .setModelEnabled({
          modelName: message.modelName,
          enabled: message.enabled,
        })
        .pipe(
          Effect.andThen(postModelSelection),
          // The options cache is invalidated by the writer itself.
          Effect.andThen(bindings.refreshCatalogs()),
        ),
    setModelReasoningLevel: (message) =>
      modelSelection
        .setReasoningLevel({
          modelName: message.modelName,
          level: message.level,
        })
        .pipe(Effect.andThen(postModelSelection)),
    // The Tools page repaints on the `toolAvailabilityChanged` signal this
    // re-probe emits.
    recheckToolStatus: () =>
      refreshToolAvailability({
        workspaceRoot: roots.workspace,
        config: roots.config,
      }),
    updateStateSetting: (message) =>
      updateStateSetting(message.key, message.value),

    // ── Subscriptions ──
    signInChatGpt: () => signInSubscription('chatgpt'),
    signOutChatGpt: () => signOutSubscription('chatgpt'),
    setChatGptPreferSubscription: (message) =>
      setPreferSubscription('chatgpt', message.enabled),
    signInGrok: () => signInSubscription('grok'),
    signOutGrok: () => signOutSubscription('grok'),
    setGrokPreferSubscription: (message) =>
      setPreferSubscription('grok', message.enabled),
    getSubscriptionUsage: (message) => postUsage(message.forceRefresh ?? false),

    ...memoryPage.handlers,
    ...gitPage.handlers,
  } satisfies Partial<SettingsArms>;

  // ── The boundary every settings program settles on ──

  const settle = <E>(
    work: Effect.Effect<void, E, ProcessServices | StorageFs>,
  ): Effect.Effect<void, never, ProcessServices> =>
    withSessionFs(roots, work).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.void;
        const error = Cause.squash(cause);
        return error instanceof UnsupportedCommandError
          ? notice(error.reason)
          : report('The settings view could not complete that action', error);
      }),
    );

  return {
    handlers,
    /**
     * Parse one inbound message and settle its program; `undefined` when the
     * message is not a settings command.
     */
    handleMessage(
      message: unknown,
      registry: SettingsArms,
    ): Effect.Effect<void, never, ProcessServices> | undefined {
      const parsed = SettingsViewInboundMessageSchema.safeParse(message);
      if (!parsed.success) return undefined;
      return settle(
        settingsViewProgram(parsed.data, registry).pipe(Effect.asVoid),
      );
    },
    /** Every page's opening data. */
    postAll: withSessionFs(roots, postAll),
    postModelSelection,
    refreshAfterProviderKeyChange,
    signInSubscription,
    /** A TeXRA account change: the profile, the models it unlocks, and the
     *  agent catalog, which the host may be holding for a team sign-in. */
    refreshAfterAuthChange: (
      options: { deferAgentCatalog?: boolean } = {},
    ): HostEffect =>
      Effect.andThen(
        allSettledVoid<Error, ProcessServices>([
          postProfile,
          postModelSelection,
          bindings.refreshCatalogs(),
        ]),
        options.deferAgentCatalog
          ? Effect.void
          : agents.refreshAfterAgentMutation(undefined, true),
      ),
    /** Settle a repaint nobody awaits, reported as a message's would be. */
    settle,
    /**
     * What each app signal this view follows repaints: a run that binds a
     * GitHub subscription, the setup agent's `apply_team`, a provider key
     * written by any writer (the setup agent's `unset_api_key`, another
     * window), and the editor's language models. OAuth tokens and other
     * secrets are not provider keys, so they repaint nothing. The host
     * subscribes (controllers do not import the signal bus) and settles
     * each repaint through {@link settle}.
     */
    repaintOn: {
      githubSubscriptionsChanged: () => gitPage.postSubscriptions,
      agentRosterChanged: () =>
        agents.refreshAfterAgentMutation(undefined, true),
      credentialChanged: ({ key }: { readonly key: string }) => {
        const provider = apiProviderOfSecretName(key);
        return provider === undefined
          ? undefined
          : refreshAfterProviderKeyChange(provider);
      },
      languageModelsChanged: () => postModelSelection,
    },
  };
}
