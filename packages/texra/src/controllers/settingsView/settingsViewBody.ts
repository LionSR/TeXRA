/**
 * The settings view's body, once for both GUI hosts. The extension and the
 * desktop each answered the same commands with the same controllers, the same
 * refresh tails and the same error sentences, drifting apart one case at a
 * time; the body lives here and a host binds a table of what it performs its
 * own way: how a message reaches its view, how it asks and tells the user,
 * and how it opens a file or picks a folder. The launchers follow the app
 * signals its writes announce.
 *
 * The body answers every command; a host runs each message it has parsed at
 * its own edge through the body's `handleMessage`, and what only some hosts
 * can do (an editor's extensions and settings) is a binding the host fills
 * or leaves out. The binding table is `settingsHostBindings.ts`.
 */
import { Cause, Effect, Stream, SubscriptionRef } from 'effect';
import { apiKeyEntry } from '@texra-ai/llm';

import {
  type PerKeyLane,
  setModelEnabled,
  Skills,
  withPerKeyLane,
  withSessionFs,
} from '@texra-ai/harness/host';
import {
  Settings,
  type StorageFs,
  emitAppSignal,
  type AppSignal,
  type AppSignalPayloads,
} from '@texra-ai/harness/plugins';
import {
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
} from '@texra-ai/harness/schemas';
import { appSignalStream } from '@texra-ai/harness/host';
import type { SubscriptionUsageProvider } from '@texra/shared/model/subscriptionUsage';
import { codingPlanForUsageSetting } from '@texra/model/codingPlanSubscriptions';
import {
  announceSignIn,
  subscriptionAuthStatuses,
  subscriptionProvider,
  type SubscriptionProviderId,
} from '@texra/controllers/modelAccess/subscriptionProviders';
import {
  allSubscriptionUsage,
  invalidateSubscriptionUsage,
} from '@texra/controllers/modelAccess/subscriptionUsage/subscriptionUsage';
import { settingsAgentCommands } from '@texra/controllers/settingsView/settingsAgentCommands';
import { settingsGitCommands } from '@texra/controllers/settingsView/settingsGitCommands';
import {
  hostStatePage,
  settingsPresentation,
  type SettingsHostBindings,
  type SettingsInput,
  type SettingsInputCounts,
  type SettingsPage,
} from '@texra/controllers/settingsView/settingsHostBindings';
import { settingsMemoryCommands } from '@texra/controllers/settingsView/settingsMemoryCommands';
import {
  buildModelSelectionPage,
  setReasoningLevel,
} from '@texra/controllers/settingsView/modelSelection';
import { settingsPluginCommands } from '@texra/controllers/settingsView/settingsPluginCommands';
import { buildProfilePage } from '@texra/controllers/settingsView/profileMessage';
import {
  removeProviderKey,
  setProviderKey,
} from '@texra/controllers/settingsView/providerKeyActions';
import { settingsToolCommands } from '@texra/controllers/settingsView/settingsToolCommands';
import type { SettingsViewInboundHandlerRegistry } from '@texra/controllers/settingsView/settingsViewDispatch';
import { buildSettingsSnapshotMessage } from '@texra/controllers/settingsView/settingsSnapshot';
import { applyStateSettingUpdate } from '@texra/controllers/settingsView/stateSettingWrite';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  DERIVED_SETTINGS_SNAPSHOTS,
  type SettingsViewInboundMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import { GITHUB_TOKEN_CREATE_URL } from '@texra/tools/github/githubAuth';
import { getProviderKeyUrl } from '@texra/model/providerPresentation';
import { CODING_PLAN_BY_API_PROVIDER } from '@texra/shared/model/codingPlans';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type { ProcessServices } from '@texra-ai/harness/host';

type HostEffect<A = void> = Effect.Effect<A, Error, ProcessServices>;
type SettingsHandlers = SettingsViewInboundHandlerRegistry<
  ProcessServices | StorageFs
>;

interface SettingsViewBodyPorts {
  readonly roots: WorkspaceRoots;
  readonly bindings: SettingsHostBindings;
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
    const inputs = yield* SubscriptionRef.make<SettingsInputCounts>({});

    const present = settingsPresentation(bindings, inputs);
    const { notice, alert, report, reported, changed } = present;

    // ── Controllers ──

    const memoryPage = settingsMemoryCommands({ bindings, present });
    const gitPage = settingsGitCommands({ bindings, present });
    const toolsPage = settingsToolCommands({ roots, bindings, present });
    const pluginsPage = settingsPluginCommands({ roots, bindings, present });
    const agents = settingsAgentCommands({ roots, bindings, present });

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
      hostStatePage('skills', ['settings', 'plugins'], Skills.display(roots)),
      hostStatePage(
        'subscriptionAuth',
        ['subscriptions'],
        subscriptionAuthStatuses(roots),
      ),
      hostStatePage(
        'subscriptionUsage',
        ['usage'],
        Effect.map(allSubscriptionUsage(roots), (snapshots) => ({
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
     * A credential changed: this view's pages follow `credentials`, and a
     * coding plan's usage is read again. The launchers follow the store's
     * own `credentialChanged`.
     */
    const credentialsChanged: (
      usageProvider?: SubscriptionUsageProvider,
    ) => HostEffect = Effect.fn('credentialsChanged')(function* (
      usageProvider?: SubscriptionUsageProvider,
    ) {
      if (usageProvider) yield* invalidateSubscriptionUsage(usageProvider);
      yield* changed('credentials');
      if (usageProvider) yield* changed('usage');
    });
    /** Run a subscription mutation, report its failure, and show the pages
     *  the subscription whatever the mutation did. The mutation's own
     *  writes announce the change to every launcher. */
    const subscriptionChange = <E>(
      failure: string,
      work: Effect.Effect<void, E, ProcessServices>,
    ) =>
      reported(failure, work).pipe(
        Effect.andThen(changed('subscriptions')),
        Effect.andThen(credentialsChanged()),
      );
    /** Every sign-in entry point of a window (the Models page, the
     *  onboarding card, a command) ends here, so each tells the user the
     *  same thing and repaints the same pages. */
    const signInSubscription = (providerId: SubscriptionProviderId) =>
      subscriptionChange(
        ACCOUNT_OUTCOME.signInFailed(
          subscriptionProvider(providerId).displayName,
        ),
        announceSignIn(
          providerId,
          bindings.signInSubscription(providerId),
          notice,
        ),
      );
    const signOutSubscription = (providerId: SubscriptionProviderId) => {
      const provider = subscriptionProvider(providerId);
      return subscriptionChange(
        ACCOUNT_OUTCOME.signOutFailed(provider.displayName),
        Effect.flatMap(provider.signOut(roots), ({ preferenceError }) =>
          Effect.andThen(
            notice(ACCOUNT_OUTCOME.signedOut(provider.displayName)),
            preferenceError === undefined
              ? Effect.void
              : alert(
                  ACCOUNT_OUTCOME.subscriptionNotDisabled(
                    provider.displayName,
                    preferenceError,
                  ),
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
        `Could not update the ${provider.displayName} subscription preference`,
        provider.setPreferSubscription(roots, enabled),
      );
    };

    // ── Catalog-backed settings rows ──

    const updateStateSetting = Effect.fn('updateStateSetting')(function* (
      key: string,
      value: unknown,
    ) {
      // The webview names the key: only a row this view renders is written.
      const entry = TEXRA_SETTINGS.settingsViewByKey(key);
      if (!entry) return;
      const result = yield* applyStateSettingUpdate(entry, value, roots);
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
      // A row that re-routes models changes what the credentials page says.
      if (result.entry.onWrite?.invalidatesModelOptions) {
        yield* credentialsChanged();
      }
      if (codingPlanForUsageSetting(key) !== undefined) {
        yield* changed('usage');
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

    // A failed key write is reported, and the profile and the Models page
    // show the key as it is.
    const keyAction = (action: ReturnType<typeof setProviderKey>) =>
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
        keyAction(setProviderKey(bindings.dialogs, roots, message.provider)),
      removeProviderKey: (message) =>
        keyAction(removeProviderKey(bindings.dialogs, roots, message.provider)),
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
          Effect.andThen(emitAppSignal('modelAccessChanged', undefined)),
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
          message.forceRefresh === true
            ? invalidateSubscriptionUsage()
            : Effect.void,
          changed('usage'),
        ),

      ...memoryPage.handlers,
      ...gitPage.handlers,
      ...toolsPage.handlers,
      ...pluginsPage.handlers,
    } satisfies SettingsHandlers;

    // ── The boundary every settings program finishes on ──

    const finish = <E>(
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

    /** Each change, after the follower subscribed, to `view` or to an input
     *  of `follows`. The counts the subscription starts from are the
     *  baseline, so a change made before it subscribed is not one. */
    const moved = (follows: readonly SettingsInput[]) =>
      SubscriptionRef.changes(inputs).pipe(
        Stream.map((counts) =>
          ['view' as const, ...follows].map((key) => counts[key] ?? 0).join(),
        ),
        Stream.changes,
        Stream.drop(1),
      );

    /** Rebuild and send `page` each time an input it follows changes, one
     *  build at a time; inputs that arrive during a build are answered by one
     *  more build. */
    const followPage = (page: SettingsPage<ProcessServices | StorageFs>) =>
      moved(page.follows).pipe(
        Stream.buffer({ capacity: 1, strategy: 'sliding' }),
        Stream.runForEach(() => finish(bindings.post(page.build))),
      );
    /** Turn each app signal the view follows into the input it changes. */
    const followSignal = <K extends AppSignal>(
      signal: K,
      input: (
        payload: AppSignalPayloads[K],
      ) => Effect.Effect<void, Error, ProcessServices> | undefined,
    ) =>
      Stream.runForEach(appSignalStream(signal), (payload) =>
        finish(input(payload) ?? Effect.void),
      );

    return {
      /** Finish the program one message the host already parsed selects. */
      handleMessage(
        message: SettingsViewInboundMessage,
      ): Effect.Effect<void, never, ProcessServices> {
        return finish(
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
          moved([]).pipe(Stream.runForEach(() => finish(toolsPage.refresh))),
          // A run that binds a GitHub subscription, an agent catalog reload,
          // and a provider key written by any writer (the setup agent's
          // `unset_api_key`, another window). OAuth tokens and other
          // secrets are not provider keys, so they change nothing here.
          followSignal('githubSubscriptionsChanged', () => changed('github')),
          followSignal('workspaceAgentsChanged', () => changed('agents')),
          followSignal('credentialChanged', ({ key }) => {
            const provider = apiKeyEntry(key);
            return provider === undefined || provider === 'unknown'
              ? undefined
              : credentialsChanged(
                  CODING_PLAN_BY_API_PROVIDER.get(provider)?.id,
                );
          }),
        ],
        (follower) => Effect.forkChild(follower, { startImmediately: true }),
        { discard: true },
      ).pipe(Effect.andThen(Effect.never)),
    };
  },
);
