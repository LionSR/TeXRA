/**
 * Canonical catalog of the OAuth subscription providers: "Sign in with
 * ChatGPT" (OpenAI's token sharing) and "Sign in with Grok" (xAI). A row
 * holds everything but the presentation, which the host supplies as a
 * {@link SubscriptionSignInPresenter}; a third provider is one row here.
 *
 * Lives in the app rather than in `@texra-ai/llm` because a row binds a
 * sign-in flow to its model-layer routing preference, a setting the llm
 * package never reads; {@link subscriptionAuthStatus} joins the same two
 * facts for the settings views.
 */
import { Effect, Schema } from 'effect';

import {
  LoopbackTransportUnavailableError,
  SubscriptionAccounts,
  type SubscriptionDeviceCodePrompt,
  type SubscriptionOAuthError,
  type SubscriptionSessionStatus,
} from '@texra-ai/llm/node';
import { SubscriptionPreference } from '@texra-ai/harness/host';
import {
  Cancelled,
  SUBSCRIPTION_ROUTES,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import type { HostFailed } from '@texra/hosts/uiHosts';
import {
  codexAccountLabel,
  type SubscriptionAccountNames,
  type SubscriptionAuthStatus,
  xaiAccountLabel,
} from '@texra/shared/model/subscriptionAuthStatus';
import type { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/harness/schemas';
import type { SecretsFailed } from '@texra-ai/llm';
import type { HttpClient } from 'effect/http';
import { ACCOUNT_OUTCOME } from '@ui/copy/accountAuth';
import {
  emitAppSignal,
  withLogChannel,
  type AppSignals,
  type SettingsStores,
  ConfigWriteFailed,
} from '@texra-ai/harness/plugins';

const CHANNEL = 'subscriptionProviders';

/** Why a subscription's status could not be read: the store, or a stored
 *  session that does not parse. */
type SubscriptionStatusError = SecretsFailed | SubscriptionOAuthError;

/**
 * A provider's id, spelled once: the wire vocabulary in
 * `SUBSCRIPTION_AUTH_PROVIDERS` is the same set the catalog keys on.
 */
export type SubscriptionProviderId =
  (typeof SUBSCRIPTION_AUTH_PROVIDERS)[number];

/**
 * The only host-specific half of a subscription sign-in: how this host shows
 * the user the two things an OAuth flow can ask of them.
 */
export interface SubscriptionSignInPresenter {
  /**
   * Show the one-time code and where to enter it. Runs once, on a child fiber
   * beside the poll loop: the flow does not wait for it and interrupts it when
   * the sign-in ends. A host reports its own failure, so the channel is empty.
   */
  presentDeviceCode(prompt: SubscriptionDeviceCodePrompt): Effect.Effect<void>;
  /**
   * Show (and normally open) the loopback consent URL. The program runs to
   * completion before the callback wait begins, so a host may block on a
   * browser-choice dialog. Fail with `Cancelled` to cancel the sign-in, and
   * with `HostFailed` when the URL could not be handed to a browser (the
   * open failed, or the copy for another browser did): the sign-in then
   * goes on with a one-time device code where the provider has one. The
   * host only reports; the sign-in decides what follows.
   */
  presentSignInUrl(url: string): Effect.Effect<void, Cancelled | HostFailed>;
}

/** A signed-in (or known-signed-out) subscription account, host-neutral. */
export interface SubscriptionAccount extends SubscriptionSessionStatus {
  /** Provider-worded label: the email, the account id, or a generic fallback. */
  readonly label: string;
}

/**
 * `'device'` picks the device-code transport outright. `'auto'` prefers
 * loopback and falls back to device-code when the loopback route cannot be
 * established at all (callback port unbindable, or no reachable browser).
 */
type SubscriptionTransport = 'device' | 'auto';

interface SubscriptionSignInOptions {
  readonly transport: SubscriptionTransport;
  readonly present: SubscriptionSignInPresenter;
  /** Where the sign-in turns on the provider's subscription preference. */
  readonly stores: SettingsStores;
}

/** One OAuth subscription provider, as every host consumes it. */
export interface SubscriptionProvider {
  readonly id: SubscriptionProviderId;
  /** Name used verbatim in prompts, titles, and errors. */
  readonly displayName: string;
  /** Account the browser session belongs to ('ChatGPT', 'xAI'). */
  readonly sessionName: string;
  /** Copy-link toast target ('ChatGPT', 'Grok / xAI'). */
  readonly copyTarget: string;
  /** Models the subscription unlocks ('OpenAI models', 'xAI models'). */
  readonly modelFamily: string;
  /**
   * The sign-in program: the OAuth flow, then the provider's subscription
   * preference turned on, so its models route to the account that was just
   * signed in. A host runs it at its own edge (command, IPC or message
   * handler), where its cancellation signal, if any, becomes fiber
   * interruption. Failures are the transports' own, or the preference
   * write's after a sign-in that succeeded; their `message` is the
   * user-facing text.
   */
  signIn(
    options: SubscriptionSignInOptions,
  ): Effect.Effect<
    SubscriptionAccount,
    Error,
    HttpClient.HttpClient | SubscriptionAccounts | AppSignals
  >;
  /**
   * The sign-out program, the mirror of `signIn`: the account signed out,
   * then the provider's subscription preference turned off, so its models
   * stop routing to an account that is gone, and `modelAccessChanged`
   * announced however the sign-out ends. A host runs it at its own
   * edge; a failure is the provider's own auth error or the secret store's
   * rejection. A preference write that fails after the sign-out succeeded
   * is reported in the result, since the account is already signed out.
   */
  signOut(
    stores: SettingsStores,
  ): Effect.Effect<
    SubscriptionSignOutResult,
    SubscriptionStatusError,
    SubscriptionAccounts | HttpClient.HttpClient | AppSignals
  >;
  /**
   * The signed-in status. A store that cannot be read, or a stored session
   * that does not parse, fails rather than reading as signed out.
   */
  getStatus(): Effect.Effect<
    SubscriptionAccount,
    SubscriptionStatusError,
    SubscriptionAccounts
  >;
  isPreferSubscription(stores: SettingsStores): boolean;
  /**
   * Persist the preference and announce `modelAccessChanged`, as a sign-in
   * and a sign-out do for the preference they write. An `Effect`, like
   * every other write of a catalog-backed setting, so a host runs it at its own
   * edge and owns the failure.
   */
  setPreferSubscription(
    stores: SettingsStores,
    enabled: boolean,
  ): Effect.Effect<void, ConfigWriteFailed | Error, AppSignals>;
}

/** What a sign-out reports beside the sign-out itself: why the provider's
 *  subscription preference could not be turned off, when it could not. */
export interface SubscriptionSignOutResult {
  readonly preferenceError?: string;
}

/** The account a provider's session is held in, named by its route. */
type AccountOf<Id extends SubscriptionProviderId> =
  SubscriptionAccounts['Service'][(typeof SUBSCRIPTION_ROUTES)[Id]];

/** A row's descriptor fields pass through to the provider unchanged; its
 *  account runs the sign-in itself. */
interface SubscriptionProviderBindings<
  Id extends SubscriptionProviderId,
> extends Pick<
  SubscriptionProvider,
  'displayName' | 'sessionName' | 'copyTarget' | 'modelFamily'
> {
  readonly id: Id;
  readonly accountLabel: (account: SubscriptionAccountNames) => string;
}

/** A sign-in that could not finish: no transport this machine can use, or
 *  an account signed in whose subscription could not be turned on. The
 *  message is the user-facing text. */
class SubscriptionSignInFailed extends Schema.TaggedError<SubscriptionSignInFailed>()(
  'SubscriptionSignInFailed',
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Bind one provider's account to the shared sign-in flow. Two callers (the
 * catalog rows below); the flow it closes over is the whole point.
 */
function defineSubscriptionProvider<Id extends SubscriptionProviderId>({
  accountLabel,
  ...descriptor
}: SubscriptionProviderBindings<Id>): SubscriptionProvider {
  const account: Effect.Effect<
    AccountOf<Id>,
    never,
    SubscriptionAccounts
  > = Effect.map(
    SubscriptionAccounts,
    (accounts) => accounts[SUBSCRIPTION_ROUTES[descriptor.id]],
  );
  const deviceCodeLogin = (
    signIn: AccountOf<Id>['signInWithDeviceCode'],
    options: SubscriptionSignInOptions,
  ) =>
    signIn === undefined
      ? Effect.fail(
          new SubscriptionSignInFailed({
            message: `${descriptor.displayName} sign-in has no device code: it returns to a browser on this machine (127.0.0.1). Sign in where TeXRA runs, or forward port 1455 from your browser's machine to this one.`,
          }),
        )
      : // The prompt is shown beside the poll, not before it: the poll waits
        // on the user, who may be reading (or dismissing) exactly this
        // prompt. A child fiber, so cancelling the sign-in closes it with
        // the flow.
        signIn((prompt) =>
          Effect.asVoid(
            Effect.forkChild(options.present.presentDeviceCode(prompt)),
          ),
        );

  /** Write the preference and say model access changed, so every launcher
   *  and status bar that shows a route reads it again. */
  const setPreference = (stores: SettingsStores, enabled: boolean) =>
    SubscriptionPreference.set(descriptor.id, stores, enabled).pipe(
      Effect.andThen(emitAppSignal('modelAccessChanged', undefined)),
    );

  const signIn = Effect.fn(`subscriptionProviders.${descriptor.id}.signIn`)(
    function* (options: SubscriptionSignInOptions) {
      const subscription = yield* account;
      const { signInWithDeviceCode } = subscription;
      // A provider without a device code signs in through the browser even
      // when the host asked for one: on a remote host whose callback port is
      // forwarded, that still completes.
      const session: Pick<SubscriptionSessionStatus, 'email' | 'accountId'> =
        options.transport === 'device' && signInWithDeviceCode !== undefined
          ? yield* deviceCodeLogin(signInWithDeviceCode, options)
          : yield* subscription
              .signInWithBrowser((url) =>
                // A browser the host could not reach is the loopback route
                // failing before anything was asked of the user, the same as
                // a callback port that could not be bound. Worded from the
                // capability's name alone: a host's message may hold the
                // URL, which can carry a code.
                options.present.presentSignInUrl(url).pipe(
                  Effect.catchTag('HostFailed', (failure) =>
                    Effect.fail(
                      new LoopbackTransportUnavailableError({
                        message: `Could not open a browser for ${descriptor.displayName} sign-in (${failure.member} failed).`,
                      }),
                    ),
                  ),
                ),
              )
              .pipe(
                Effect.catchIf(
                  (error): error is LoopbackTransportUnavailableError =>
                    error instanceof LoopbackTransportUnavailableError,
                  (error) => {
                    const causeMessage =
                      error.cause === undefined
                        ? ''
                        : ` Cause: ${toErrorMessage(error.cause)}`;
                    return Effect.logWarning(
                      `${descriptor.displayName} browser sign-in is unavailable, falling back to a one-time device code: ${toErrorMessage(error)}${causeMessage}`,
                    ).pipe(
                      Effect.annotateLogs({ data: error }),
                      withLogChannel(CHANNEL),
                      Effect.andThen(
                        deviceCodeLogin(signInWithDeviceCode, options),
                      ),
                    );
                  },
                ),
              );
      // The session is stored by now, so the change is announced whether
      // or not the preference write follows it, as the sign-out's is.
      yield* SubscriptionPreference.set(
        descriptor.id,
        options.stores,
        true,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SubscriptionSignInFailed({
              message: `Signed in with ${descriptor.displayName}, but its subscription could not be turned on: ${toErrorMessage(cause)}`,
              cause,
            }),
        ),
        Effect.ensuring(emitAppSignal('modelAccessChanged', undefined)),
      );
      return {
        signedIn: true,
        email: session.email,
        accountId: session.accountId,
        label: accountLabel(session),
      } satisfies SubscriptionAccount;
    },
  );

  return Object.freeze({
    ...descriptor,
    isPreferSubscription: (stores: SettingsStores) =>
      SubscriptionPreference.get(descriptor.id, stores),
    setPreferSubscription: setPreference,
    signIn,
    signOut: (stores: SettingsStores) =>
      Effect.flatMap(account, (coordinator) => coordinator.signOut()).pipe(
        Effect.andThen(
          SubscriptionPreference.set(descriptor.id, stores, false).pipe(
            Effect.match({
              onFailure: (error): SubscriptionSignOutResult => ({
                preferenceError: toErrorMessage(error),
              }),
              onSuccess: (): SubscriptionSignOutResult => ({}),
            }),
          ),
        ),
        // The local session is deleted even when ending it at the provider
        // fails, so the change is announced however the sign-out ends.
        Effect.ensuring(emitAppSignal('modelAccessChanged', undefined)),
      ),
    getStatus: () =>
      Effect.flatMap(account, (coordinator) =>
        Effect.map(coordinator.getStatus(), (status) => ({
          ...status,
          label: accountLabel(status),
        })),
      ),
  });
}

/**
 * "Sign in with ChatGPT": Codex-eligible models then run on the user's
 * ChatGPT plan instead of an OpenAI API key, through OpenAI's token sharing.
 * The sign-in is browser-only: OpenAI's flow has no device code.
 */
const CHATGPT_PROVIDER = defineSubscriptionProvider({
  id: 'chatgpt',
  displayName: 'ChatGPT',
  sessionName: 'ChatGPT',
  copyTarget: 'ChatGPT',
  modelFamily: 'OpenAI models',
  accountLabel: (account) => codexAccountLabel(account),
});

/**
 * Experimental "Sign in with Grok": xAI models then run on the user's
 * SuperGrok / xAI account OAuth token instead of an xAI API key.
 */
const GROK_PROVIDER = defineSubscriptionProvider({
  id: 'grok',
  displayName: 'Grok',
  sessionName: 'xAI',
  copyTarget: 'Grok / xAI',
  modelFamily: 'xAI models',
  accountLabel: (account) => xaiAccountLabel(account),
});

/** Canonical catalog of OAuth subscription providers, shared by every host. */
const SUBSCRIPTION_PROVIDERS: Readonly<
  Record<SubscriptionProviderId, SubscriptionProvider>
> = Object.freeze({
  chatgpt: CHATGPT_PROVIDER,
  grok: GROK_PROVIDER,
});

/** Resolve a provider row by id. */
export function subscriptionProvider(
  id: SubscriptionProviderId,
): SubscriptionProvider {
  return SUBSCRIPTION_PROVIDERS[id];
}

/**
 * Run a subscription sign-in and tell the user how it ended, in the words
 * every surface uses: `notice` shows the signed-in sentence, and a user who
 * backed out of the host's prompt is told nothing, since nothing failed.
 * Any other failure is the caller's to show, under
 * `ACCOUNT_OUTCOME.signInFailed`.
 */
export function announceSignIn<E, R, R2>(
  providerId: SubscriptionProviderId,
  signIn: Effect.Effect<{ readonly label: string }, E, R>,
  notice: (message: string) => Effect.Effect<unknown, never, R2>,
): Effect.Effect<void, E, R | R2> {
  const { displayName, modelFamily } = subscriptionProvider(providerId);
  return signIn.pipe(
    Effect.flatMap((account) =>
      notice(
        ACCOUNT_OUTCOME.signedInEnabled(
          displayName,
          account.label,
          modelFamily,
        ),
      ),
    ),
    Effect.asVoid,
    Effect.catchIf(
      (error) => error instanceof Cancelled,
      () => Effect.void,
    ),
  );
}

/**
 * The subscription sign-in status as the settings views consume it: the
 * session status plus the current routing preference, tagged with the provider
 * it belongs to. One composer so the extension and desktop hosts post the
 * identical payload (the wire shape is validated by
 * `SubscriptionAuthStatusSchema` at each host's boundary).
 */
export function subscriptionAuthStatus(
  providerId: SubscriptionProviderId,
  stores: SettingsStores,
): Effect.Effect<
  SubscriptionAuthStatus,
  SubscriptionStatusError,
  SubscriptionAccounts
> {
  const provider = subscriptionProvider(providerId);
  return Effect.map(provider.getStatus(), (status) => ({
    provider: providerId,
    signedIn: status.signedIn,
    email: status.email,
    accountId: status.accountId,
    preferSubscription: provider.isPreferSubscription(stores),
  }));
}

/**
 * Every subscription's {@link subscriptionAuthStatus}, keyed by its
 * provider: the record the settings views and the terminal's account
 * surfaces read. One field per provider, so a provider added to the wire
 * set without a status here fails to compile.
 */
export function subscriptionAuthStatuses(
  stores: SettingsStores,
): Effect.Effect<
  Readonly<Record<SubscriptionProviderId, SubscriptionAuthStatus>>,
  SubscriptionStatusError,
  SubscriptionAccounts
> {
  return Effect.all(
    {
      chatgpt: subscriptionAuthStatus('chatgpt', stores),
      grok: subscriptionAuthStatus('grok', stores),
    },
    { concurrency: 'unbounded' },
  );
}
