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
 * commands only it answers (its account sign-in, the Copilot routes, and
 * installing a VS Code extension or writing VS Code's settings), and runs every message it has parsed at its own edge
 * through the body's `handleMessage`. The binding
 * table is `settingsHostBindings.ts`.
 */
import { Cause, Effect } from 'effect';
import {
  API_KEY_PROVIDER_IDS,
  apiProviderOfSecretName,
  loadApiKeyStatusMap,
} from '@texra-ai/llm';

import type { SessionHandle } from '@agent/runtime';
import { withLogChannel } from '@logger/effectLog';
import {
  modelOptionsFrom,
  readModelAvailabilityInputs,
} from '@model/computeModelOptions';
import { discoverCopilotRoutes } from '@model/copilotRouting';
import { type StorageFs, withSessionFs } from '@platform/rootedFs';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { TEXRA_APPROVAL_POLICY_CONFIG_KEY } from '@shared/approvalPolicy';
import type { SubscriptionUsageProvider } from '@shared/schemas';
import { SUBSCRIPTION_AUTH_PROVIDERS } from '@shared/model/subscriptionAuth';
import { CODING_PLAN_BY_API_PROVIDER } from '@shared/schemas';
import { codingPlanForUsageSetting } from '@texra/model/codingPlanSubscriptions';
import { UnsupportedCommandError } from '@texra/shared/utils/dispatcher';
import {
  subscriptionAuthStatus,
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { SubscriptionUsageService } from '@texra/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { settingsAgentCommands } from '@texra/controllers/settingsView/settingsAgentCommands';
import { settingsGitCommands } from '@texra/controllers/settingsView/settingsGitCommands';
import {
  SETTINGS_LOG_CHANNEL,
  settingsPresentation,
  type SettingsHostBindings,
} from '@texra/controllers/settingsView/settingsHostBindings';
import { settingsMemoryCommands } from '@texra/controllers/settingsView/settingsMemoryCommands';
import { SettingsModelSelectionController } from '@texra/controllers/settingsView/SettingsModelSelectionController';
import { settingsPluginCommands } from '@texra/controllers/settingsView/settingsPluginCommands';
import { SettingsProfileController } from '@texra/controllers/settingsView/SettingsProfileController';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';
import { settingsToolCommands } from '@texra/controllers/settingsView/settingsToolCommands';
import {
  settingsViewProgram,
  type SettingsViewInboundHandlerRegistry,
} from '@texra/controllers/settingsView/settingsViewDispatch';
import { buildSettingsSnapshotMessage } from '@texra/shared/settingsView/handlers/settingsSnapshot';
import {
  applyStateSettingUpdate,
  type SettingsSnapshotPosters,
} from '@texra/shared/settingsView/handlers/stateSettingWrite';
import {
  type DerivedSettingsSnapshot,
  type SettingsViewInboundMessage,
  type SettingsViewOutboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import { GITHUB_TOKEN_CREATE_URL } from '@texra/tools/github/githubAuth';
import { allSettledVoid } from '@texra/utils/core/allSettledVoid';
import { getProviderKeyUrl } from '@texra/model/providerPresentation';
import type { ProcessServices } from '@texra-ai/harness';
import type { PlatformSecrets } from '@texra-ai/harness';

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
  readonly session: Pick<SessionHandle, 'roots'>;
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
    stores: roots,
    loadProviderKeyStatuses: loadApiKeyStatusMap(secrets, API_KEY_PROVIDER_IDS),
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
  const toolsPage = settingsToolCommands({ roots, bindings });
  const pluginsPage = settingsPluginCommands({
    roots,
    bindings,
    present,
    // A plugin's skills are listed on the Skills page as `<plugin>:<name>`.
    repaint: Effect.andThen(
      toolsPage.postPlugins,
      Effect.suspend(() => postSkills),
    ),
  });
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
    bindings.post(buildSettingsSnapshotMessage(snapshot, roots));
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
      CODING_PLAN_BY_API_PROVIDER.get(provider)?.usageProvider,
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
    agents: () => postSnapshot('agents'),
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
      if (key === TEXRA_APPROVAL_POLICY_CONFIG_KEY) {
        yield* bindings.refreshCatalogs();
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
        'agents',
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
    toolsPage.postStartup,
  ]);

  const handlers = {
    webviewReady: () => postAll,
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
    updateStateSetting: (message) =>
      updateStateSetting(message.key, message.value),

    // ── Subscriptions ──
    signInSubscription: (message) => signInSubscription(message.provider),
    signOutSubscription: (message) => signOutSubscription(message.provider),
    setSubscriptionPreference: (message) =>
      setPreferSubscription(message.provider, message.enabled),
    getSubscriptionUsage: (message) => postUsage(message.forceRefresh ?? false),

    ...memoryPage.handlers,
    ...gitPage.handlers,
    ...toolsPage.handlers,
    ...pluginsPage.handlers,
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
    /** Settle the program one message the host already parsed selects. */
    handleMessage(
      message: SettingsViewInboundMessage,
      registry: SettingsArms,
    ): Effect.Effect<void, never, ProcessServices> {
      return settle(settingsViewProgram(message, registry).pipe(Effect.asVoid));
    },
    /** Every page's opening data. */
    postAll: withSessionFs(roots, postAll),
    postModelSelection,
    /** The LaTeX page's status, for the host's own LaTeX arms. */
    postLatexStatus: toolsPage.postLatexStatus,
    reported,
    signInSubscription,
    /** Settle a repaint nobody awaits, reported as a message's would be. */
    settle,
    /** The Plugins page following its workspace's availability results,
     *  for the host to hold while the view lives. */
    followToolAvailability: toolsPage.followToolAvailability(settle),
    /**
     * What each app signal this view follows repaints: a run that binds a
     * GitHub subscription, the setup agent's `apply_team`, a provider key
     * written by any writer (the setup agent's `unset_api_key`, another
     * window) and the editor's language models. OAuth tokens and other
     * secrets are not provider keys, so they repaint nothing. The host
     * subscribes (controllers do not import the signal bus) and settles
     * each repaint through {@link settle}.
     */
    repaintOn: {
      githubSubscriptionsChanged: () => gitPage.postSubscriptions,
      workspaceAgentsChanged: () =>
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
