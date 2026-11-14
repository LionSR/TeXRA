/**
 * The settings view's body, once for both GUI hosts. The extension and the
 * desktop each answered the same commands with the same controllers, the same
 * refresh tails and the same error sentences, drifting apart one case at a
 * time; the body lives here and a host binds a table of what it performs its
 * own way: how a message reaches its view, how it asks and tells the user,
 * how it opens a file or picks a folder, and how its launchers reload.
 *
 * The body answers every command; a host runs each message it has parsed at
 * its own edge through the body's `handleMessage`, and what only some hosts
 * can do (an editor's extensions and settings) is a binding the host fills
 * or leaves out. The binding table is `settingsHostBindings.ts`.
 */
import { Cause, Effect, PubSub, Stream } from 'effect';
import { apiKeyEntry } from '@texra-ai/llm';

import {
  type PerKeyLane,
  setModelEnabled,
  withPerKeyLane,
  withSessionFs,
} from '@texra-ai/harness/host';
import {
  Settings,
  type StorageFs,
  emitAppSignal,
} from '@texra-ai/harness/plugins';
import {
  APPROVAL_POLICY_SETTING,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
} from '@texra-ai/harness/schemas';
import { appSignalStream } from '@texra-ai/harness/host';
import type { SubscriptionUsageProvider } from '@texra/shared/model/subscriptionUsage';
import { codingPlanForUsageSetting } from '@texra/model/codingPlanSubscriptions';
import {
  subscriptionAuthStatus,
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import { SubscriptionUsageService } from '@texra/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { settingsAgentCommands } from '@texra/controllers/settingsView/settingsAgentCommands';
import { settingsGitCommands } from '@texra/controllers/settingsView/settingsGitCommands';
import {
  hostStatePage,
  settingsPresentation,
  type SettingsHostBindings,
  type SettingsInput,
  type SettingsPage,
} from '@texra/controllers/settingsView/settingsHostBindings';
import { settingsMemoryCommands } from '@texra/controllers/settingsView/settingsMemoryCommands';
import {
  buildModelSelectionPage,
  setReasoningLevel,
} from '@texra/controllers/settingsView/modelSelection';
import { settingsPluginCommands } from '@texra/controllers/settingsView/settingsPluginCommands';
import { buildProfilePage } from '@texra/controllers/settingsView/profileMessage';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';
import { settingsToolCommands } from '@texra/controllers/settingsView/settingsToolCommands';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import { buildSettingsSnapshotMessage } from '@texra/shared/settingsView/handlers/settingsSnapshot';
import { applyStateSettingUpdate } from '@texra/shared/settingsView/handlers/stateSettingWrite';
import {
  DERIVED_SETTINGS_SNAPSHOTS,
  type SettingsHostState,
  type SettingsViewInboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import { GITHUB_TOKEN_CREATE_URL } from '@texra/tools/github/githubAuth';
import { getProviderKeyUrl } from '@texra/model/providerPresentation';
import { CODING_PLAN_BY_API_PROVIDER } from '@texra/shared/model/codingPlans';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type {
  AppSignal,
  AppSignalPayloads,
  ProcessServices,
} from '@texra-ai/harness/host';

type HostEffect<A = void> = Effect.Effect<A, Error, ProcessServices>;
type SettingsArms = SettingsViewInboundHandlerRegistry<
  ProcessServices | StorageFs
>;

interface SettingsViewBodyPorts {
  readonly roots: WorkspaceRoots;
  /** The packaged resources root; the agent templates live under it. */
  readonly resourcesPath: string;
  readonly bindings: SettingsHostBindings;
  /** The skills the Skills page lists, from the skills subsystem, which
   *  controllers take from their host rather than import. */
  readonly skillDisplay: HostEffect<SettingsHostState['skills']>;
  /** The account copy (`src/ui`), which controllers likewise take from
   *  their host. */
  readonly accountCopy: {
    signedOut(providerDisplayName: string): string;
    signOutFailed(providerDisplayName: string): string;
  };
}

/**
 * Build the settings body over one host's bindings. Each page is rebuilt
 * and sent as the inputs it follows change, so a mutation writes and says
 * which input it changed, and the pages' dependencies are spelled once, at
 * the pages.
 */
export const makeSettingsViewBody = Effect.fn('makeSettingsViewBody')(
  function* (ports: SettingsViewBodyPorts) {
    const { bindings, roots } = ports;
    const inputs = yield* PubSub.unbounded<SettingsInput>();

    const present = settingsPresentation(bindings, inputs);
    const { notice, alert, report, reported, changed } = present;

    // ── Controllers ──

    const usage = new SubscriptionUsageService({ stores: roots });
    const memoryPage = settingsMemoryCommands({ bindings, present });
    const gitPage = settingsGitCommands({ bindings, present });
    const toolsPage = settingsToolCommands({ roots, bindings, present });
    const pluginsPage = settingsPluginCommands({ roots, bindings, present });
    const agents = settingsAgentCommands({
      roots,
      resourcesPath: ports.resourcesPath,
      bindings,
      present,
    });

    // ── Pages ──

    const pages: ReadonlyArray<SettingsPage<ProcessServices | StorageFs>> = [
      ...DERIVED_SETTINGS_SNAPSHOTS.map((snapshot) => ({
        follows: ['settings'] as const,
        build: buildSettingsSnapshotMessage(snapshot, roots),
      })),
      hostStatePage(
        'profile',
        ['settings', 'credentials'],
        buildProfilePage(roots),
      ),
      hostStatePage(
        'models',
        ['settings', 'credentials'],
        buildModelSelectionPage(roots),
      ),
      // A plugin's skills are listed on the Skills page as `<plugin>:<name>`.
      hostStatePage('skills', ['settings', 'plugins'], ports.skillDisplay),
      hostStatePage(
        'subscriptionAuth',
        ['subscriptions'],
        // One field per provider, so a provider added to the wire set
        // without a status here fails to compile.
        Effect.all({
          chatgpt: subscriptionAuthStatus('chatgpt', roots),
          grok: subscriptionAuthStatus('grok', roots),
        }),
      ),
      hostStatePage(
        'subscriptionUsage',
        ['usage'],
        Effect.map(usage.getAllUsage(), (snapshots) => ({
          snapshots,
        })),
      ),
      memoryPage.page,
      ...gitPage.pages,
      ...toolsPage.pages,
      ...agents.pages,
    ];

    // ── What a change runs beyond this view ──

    /**
     * A credential changed: the probes outside this view first, since model
     * availability reads the key state they produce, then the launchers'
     * catalogs; this view's pages follow `credentials`, and a coding plan's
     * usage is read again.
     */
    const credentialsChanged: (
      usageProvider?: SubscriptionUsageProvider,
    ) => HostEffect = Effect.fn('credentialsChanged')(function* (
      usageProvider?: SubscriptionUsageProvider,
    ) {
      if (usageProvider) yield* usage.invalidate(usageProvider);
      yield* bindings.refreshCredentialStatus;
      yield* bindings.refreshCatalogs();
      yield* changed('credentials');
      if (usageProvider) yield* changed('usage');
    });
    /** Run a subscription mutation, report its failure, and say the
     *  subscription changed whatever the mutation did. */
    const subscriptionChange = <E>(
      providerId: SubscriptionProviderId,
      failure: string,
      work: Effect.Effect<void, E, ProcessServices>,
    ) =>
      reported(failure, work).pipe(
        Effect.andThen(changed('subscriptions')),
        Effect.andThen(credentialsChanged()),
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
        Effect.flatMap(provider.signOut(roots), ({ preferenceError }) =>
          Effect.andThen(
            notice(ports.accountCopy.signedOut(provider.displayName)),
            preferenceError === undefined
              ? Effect.void
              : alert(
                  `${provider.displayName} subscription could not be turned off: ${preferenceError}`,
                ),
          ),
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

    const updateStateSetting = Effect.fn('updateStateSetting')(function* (
      key: string,
      value: unknown,
    ) {
      const result = yield* applyStateSettingUpdate(key, value, {
        host: 'settingsView',
        stores: roots,
        requiresOpenWorkspace: bindings.requiresOpenWorkspace,
      });
      if (result.kind === 'ignored') return;
      const label = result.entry.title;
      if (result.kind === 'rejected') {
        yield* report(`Invalid value for “${label}”`, result.error);
      } else if (result.kind === 'failed') {
        yield* report(`Failed to update “${label}”`, result.error);
      } else if (result.kind === 'workspace-required') {
        yield* notice(
          `Open a workspace folder before changing the “${label}” setting.`,
        );
      }
      // Every outcome is sent back, so a rejected edit shows the stored value.
      yield* changed('settings');
      if (result.kind !== 'applied') return;
      if (result.entry.onWrite?.invalidatesModelOptions) {
        yield* credentialsChanged();
      }
      if (codingPlanForUsageSetting(key) !== undefined) {
        yield* changed('usage');
      }
      if (key === APPROVAL_POLICY_SETTING.key) {
        yield* bindings.refreshCatalogs();
        yield* emitAppSignal('approvalPolicyChanged', undefined);
      }
    });

    // One read-modify-write at a time per list: two switches handled at once
    // would each read the list without the other's item.
    const skillListLanes = new Map<string, PerKeyLane>();
    const setSkillEnabled = (
      key: (
        | typeof DISABLED_SKILLS_SETTING
        | typeof DISABLED_SKILL_SOURCES_SETTING
      )['key'],
      item: string,
      enabled: boolean,
    ) =>
      Effect.flatMap(
        Settings.get(
          roots,
          key === DISABLED_SKILLS_SETTING.key
            ? DISABLED_SKILLS_SETTING
            : DISABLED_SKILL_SOURCES_SETTING,
        ),
        (disabled: readonly string[]) =>
          updateStateSetting(
            key,
            enabled
              ? disabled.filter((candidate) => candidate !== item)
              : [...new Set([...disabled, item])],
          ),
      ).pipe(withPerKeyLane(skillListLanes, key));

    const profileKeys = new SettingsProfileKeyController({
      dialogs: bindings.dialogs,
      stores: roots,
    });
    // A failed key write is reported, and the profile and the Models page
    // show the key as it is.
    const keyAction = (action: ReturnType<typeof profileKeys.setProviderKey>) =>
      action.pipe(
        Effect.catchTag('ProviderKeyActionFailed', (error) =>
          Effect.andThen(
            report(error.message, error.cause),
            changed('credentials'),
          ),
        ),
      );

    const handlers = {
      // The view (re)opened: every page is sent, and this workspace's tools
      // are probed again (a follower below), which the Plugins page follows.
      webviewReady: () => changed('view'),
      ...agents.handlers,
      setProviderKey: (message) =>
        keyAction(profileKeys.setProviderKey(message.provider)),
      removeProviderKey: (message) =>
        keyAction(profileKeys.removeProviderKey(message.provider)),
      openProviderKeyUrl: (message) =>
        getProviderKeyUrl(roots, message.provider).pipe(
          Effect.flatMap((url) =>
            url ? bindings.externalOpener.openExternal(url) : Effect.void,
          ),
        ),
      openExternalUrl: (message) =>
        bindings.externalOpener.openExternal(message.url),
      openGitHubTokenUrl: () =>
        bindings.externalOpener.openExternal(GITHUB_TOKEN_CREATE_URL),
      setModelEnabled: (message) =>
        setModelEnabled({
          model: message.modelName,
          enabled: message.enabled,
          stores: roots,
        }).pipe(
          Effect.andThen(changed('settings')),
          // The options cache is invalidated by the writer itself.
          Effect.andThen(bindings.refreshCatalogs()),
        ),
      setModelReasoningLevel: (message) =>
        setReasoningLevel(roots.globalState, {
          modelName: message.modelName,
          level: message.level,
        }).pipe(Effect.andThen(changed('settings'))),
      updateStateSetting: (message) =>
        updateStateSetting(message.key, message.value),
      setSkillEnabled: (message) =>
        setSkillEnabled(message.key, message.item, message.enabled),

      // ── Subscriptions ──
      signInSubscription: (message) => signInSubscription(message.provider),
      signOutSubscription: (message) => signOutSubscription(message.provider),
      setSubscriptionPreference: (message) =>
        setPreferSubscription(message.provider, message.enabled),
      getSubscriptionUsage: (message) =>
        Effect.andThen(
          message.forceRefresh === true ? usage.invalidateAll() : Effect.void,
          changed('usage'),
        ),

      ...memoryPage.handlers,
      ...gitPage.handlers,
      ...toolsPage.handlers,
      ...pluginsPage.handlers,
    } satisfies SettingsArms;

    // ── The boundary every settings program finishes on ──

    const settle = <E>(
      work: Effect.Effect<void, E, ProcessServices | StorageFs>,
    ): Effect.Effect<void, never, ProcessServices> =>
      withSessionFs(roots, work).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.void;
          return report(
            'The settings view could not complete that action',
            Cause.squash(cause),
          );
        }),
      );

    /** Rebuild and send `page` each time an input it follows changes, one
     *  build at a time; inputs that arrive during a build are answered by one
     *  more build. */
    const followPage = (page: SettingsPage<ProcessServices | StorageFs>) =>
      Stream.fromPubSub(inputs).pipe(
        Stream.filter(
          (input) => input === 'view' || page.follows.includes(input),
        ),
        Stream.buffer({ capacity: 1, strategy: 'sliding' }),
        Stream.runForEach(() => settle(bindings.post(page.build))),
      );
    /** Turn each app signal the view follows into the input it changes. */
    const followSignal = <K extends AppSignal>(
      signal: K,
      input: (
        payload: AppSignalPayloads[K],
      ) => Effect.Effect<void, Error, ProcessServices> | undefined,
    ) =>
      Stream.runForEach(appSignalStream(signal), (payload) =>
        settle(input(payload) ?? Effect.void),
      );

    return {
      /** Finish the program one message the host already parsed selects. */
      handleMessage(
        message: SettingsViewInboundMessage,
      ): Effect.Effect<void, never, ProcessServices> {
        return settle(
          Effect.suspend(() => {
            // cast: the discriminant selects exactly this handler's member of
            // the union.
            const run = handlers[message.command] as (
              message: SettingsViewInboundMessage,
            ) => Effect.Effect<unknown, Error, ProcessServices | StorageFs>;
            return run(message);
          }).pipe(Effect.asVoid),
        );
      },
      /** Say an input changed; the host says the view was revealed. */
      changed,
      signInSubscription,
      /**
       * Follow, until interrupted, every page's inputs and what feeds them:
       * this workspace's tool availability (the Plugins page) and the app
       * signals below. Every follower is a child fiber started at once, so it
       * is subscribed by the end of the turn that forks this.
       */
      follow: Effect.forEach(
        [
          ...pages.map(followPage),
          toolsPage.followToolAvailability,
          // The re-probe's network checks (Zotero and others) never hold the
          // view's ready answer, so the host's tab reveal is not kept waiting.
          Stream.fromPubSub(inputs).pipe(
            Stream.filter((input) => input === 'view'),
            Stream.runForEach(() => settle(toolsPage.refresh)),
          ),
          // A run that binds a GitHub subscription, the setup agent's
          // `apply_team`, and a provider key written by any writer (the setup
          // agent's `unset_api_key`, another window). OAuth tokens and other
          // secrets are not provider keys, so they change nothing here.
          followSignal('githubSubscriptionsChanged', () => changed('github')),
          followSignal('workspaceAgentsChanged', () => agents.agentsChanged()),
          followSignal('credentialChanged', ({ key }) => {
            const provider = apiKeyEntry(key);
            return provider === undefined || provider === 'unknown'
              ? undefined
              : credentialsChanged(
                  CODING_PLAN_BY_API_PROVIDER.get(provider)?.usageProvider,
                );
          }),
        ],
        (follower) => Effect.forkChild(follower, { startImmediately: true }),
        { discard: true },
      ).pipe(Effect.andThen(Effect.never)),
    };
  },
);
