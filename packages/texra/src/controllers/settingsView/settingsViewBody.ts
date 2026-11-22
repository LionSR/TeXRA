/**
 * The settings view's body, once for both GUI hosts. The extension and the
 * desktop each answered the same commands with the same controllers, the same
 * refresh tails and the same error sentences, drifting apart one case at a
 * time; the body lives here and a host binds a table of what it performs its
 * own way: how a message reaches its view, how it asks and tells the user,
 * and how it opens a file or picks a folder. The launchers follow the app
 * signals its writes announce.
 *
 * The body answers every command; a host hands each message its view sent,
 * unparsed, to the body's `handleMessage`, and what only some hosts
 * can do (an editor's extensions and settings) is a binding the host fills
 * or leaves out. The binding table is `settingsHostBindings.ts`.
 */
import {
  Cause,
  Effect,
  Predicate,
  Result,
  Schema,
  Stream,
  SubscriptionRef,
} from 'effect';
import { apiKeyEntry } from '@texra-ai/llm';

import { setModelEnabled, Skills, withSessionFs } from '@texra-ai/harness/host';
import {
  Settings,
  type StorageFs,
  emitAppSignal,
  type AppSignal,
  type AppSignalPayloads,
  type PerKeyLane,
  withPerKeyLane,
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
import { setModelAccessPreference } from '@texra/controllers/modelAccess/modelAccessPreference';
import { settingsGitCommands } from '@texra/controllers/settingsView/settingsGitCommands';
import {
  hostStatePage,
  settingsPresentation,
  type SettingsHostBindings,
  type SettingsInput,
  type SettingsInputCounts,
  type SettingsPage,
  type SettingsViewInboundHandlerRegistry,
} from '@texra/controllers/settingsView/settingsHostBindings';
import { settingsMemoryCommands } from '@texra/controllers/settingsView/settingsMemoryCommands';
import {
  buildModelSelectionPage,
  setReasoningLevel,
} from '@texra/controllers/settingsView/modelSelection';
import { settingsPluginCommands } from '@texra/controllers/settingsView/settingsPluginCommands';
import {
  buildProfilePage,
  removeProviderKey,
  setProviderKey,
} from '@texra/controllers/settingsView/providerKeyActions';
import { settingsToolCommands } from '@texra/controllers/settingsView/settingsToolCommands';
import {
  applyStateSettingUpdate,
  setSkillEnabled,
  settingWriteFailure,
  type StateSettingUpdateResult,
  type WritableRow,
} from '@texra/controllers/settingsView/stateSettingWrite';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { TEXRA_SETTINGS } from '@texra/shared/settings/texraSettings';
import {
  DERIVED_SETTINGS_SNAPSHOTS,
  type SettingsViewInboundMessage,
  SettingsViewInboundMessageSchema,
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

    // ── Pages ──

    const pages: ReadonlyArray<SettingsPage<ProcessServices | StorageFs>> = [
      // A derived snapshot is the catalog rows tagged for it, each read
      // with its row's default and validation.
      ...DERIVED_SETTINGS_SNAPSHOTS.map((snapshot) => ({
        follows: ['settings'] as const,
        build: Effect.map(
          Effect.forEach(TEXRA_SETTINGS.snapshotEntries(snapshot), (entry) =>
            Effect.map(
              Settings.get(roots, entry),
              (value) => [entry.key, value] as const,
            ),
          ),
          (values) => ({
            command: SETTINGS_VIEW_COMMANDS.UPDATE_SETTINGS_SNAPSHOT,
            snapshot,
            values: Object.fromEntries(values),
          }),
        ),
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
    /** A subscription switched on while signed out is not written: the
     *  window's sign-in follows, which turns it on when it succeeds. */
    const setSubscriptionPreference = (
      providerId: SubscriptionProviderId,
      enabled: boolean,
    ) =>
      subscriptionChange(
        `Could not update the ${subscriptionProvider(providerId).displayName} subscription preference`,
        Effect.flatMap(
          setModelAccessPreference(roots, providerId, enabled),
          (outcome) =>
            outcome === 'needs-sign-in'
              ? signInSubscription(providerId)
              : Effect.void,
        ),
      );

    // ── Catalog-backed settings rows ──

    // Every outcome is sent back, so a rejected edit shows the stored value.
    const settingWritten = Effect.fn('settingWritten')(function* (
      result: StateSettingUpdateResult<WritableRow>,
    ) {
      if (result.kind === 'ignored') return;
      const failure = settingWriteFailure(result);
      if (failure !== undefined)
        yield* result.kind === 'workspace-required' ||
        result.kind === 'needs-key'
          ? notice(failure.message)
          : alert(failure.message);
      yield* changed('settings');
      if (result.kind !== 'applied') return;
      // A row that re-routes models changes what the credentials page says.
      if (result.entry.onWrite?.invalidatesModelOptions) {
        yield* credentialsChanged();
      }
      if (codingPlanForUsageSetting(result.entry.key) !== undefined) {
        yield* changed('usage');
      }
    });

    const updateStateSetting = (key: string, value: unknown) => {
      // The webview names the key: only a row this view renders is written.
      const entry = TEXRA_SETTINGS.settingsViewByKey(key);
      return entry === undefined
        ? Effect.void
        : Effect.flatMap(
            applyStateSettingUpdate(entry, value, roots),
            settingWritten,
          );
    };

    // One read-modify-write at a time per list: two switches handled at once
    // would each read the list without the other's item.
    const skillListLanes = new Map<string, PerKeyLane>();
    const toggleSkill = (
      key: (
        | typeof DISABLED_SKILLS_SETTING
        | typeof DISABLED_SKILL_SOURCES_SETTING
      )['key'],
      item: string,
      enabled: boolean,
    ) =>
      setSkillEnabled(
        key === DISABLED_SKILLS_SETTING.key
          ? DISABLED_SKILLS_SETTING
          : DISABLED_SKILL_SOURCES_SETTING,
        item,
        enabled,
        roots,
      ).pipe(
        Effect.flatMap(settingWritten),
        withPerKeyLane(skillListLanes, key),
      );

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
        toggleSkill(message.key, message.item, message.enabled),

      // ── Subscriptions ──
      signInSubscription: (message) => signInSubscription(message.provider),
      signOutSubscription: (message) => signOutSubscription(message.provider),
      setSubscriptionPreference: (message) =>
        setSubscriptionPreference(message.provider, message.enabled),
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
      /** Finish the program one message from the view selects. One that
       *  does not parse is drift between the view and this body; every click
       *  either runs its command or says why it did not. */
      handleMessage(raw: unknown): Effect.Effect<void, never, ProcessServices> {
        const parsed = Schema.decodeUnknownResult(
          SettingsViewInboundMessageSchema,
        )(raw);
        if (Result.isFailure(parsed)) {
          const command =
            Predicate.hasProperty(raw, 'command') &&
            typeof raw.command === 'string'
              ? raw.command
              : 'unknown';
          return report(
            `Settings could not handle the '${command}' request`,
            parsed.failure,
          );
        }
        const message = parsed.success;
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
          // A run that binds a GitHub subscription and a provider key written by any writer (the setup agent's
          // `unset_api_key`, another window). OAuth tokens and other
          // secrets are not provider keys, so they change nothing here.
          followSignal('githubSubscriptionsChanged', () => changed('github')),
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
