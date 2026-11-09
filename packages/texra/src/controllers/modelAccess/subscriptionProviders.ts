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
import { Effect } from 'effect';

import {
  chatgptLoginWithLoopback,
  LoopbackTransportUnavailableError,
  SubscriptionAccounts,
  type SubscriptionDeviceCodePrompt,
  type SubscriptionOAuthError,
  type SubscriptionSessionStatus,
  xaiLoginWithDeviceCode,
  xaiLoginWithLoopback,
} from '@texra-ai/llm/node';
import {
  ConfigWriteFailed,
  SubscriptionPreference,
} from '@texra-ai/harness/host';
import { SUBSCRIPTION_ROUTES, toErrorMessage } from '@texra-ai/harness/schemas';
import {
  codexAccountLabel,
  type SubscriptionAuthStatus,
  xaiAccountLabel,
} from '@texra/shared/model/subscriptionAuthStatus';
import type { SUBSCRIPTION_AUTH_PROVIDERS } from '@texra-ai/harness/schemas';
import type { SecretsFailed } from '@texra-ai/llm';
import type { HttpClient } from 'effect/http';
import { withLogChannel, type SettingsStores } from '@texra-ai/harness/plugins';

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
   * browser-choice dialog. Fail to cancel the sign-in; fail with
   * {@link LoopbackTransportUnavailableError} when no browser could be
   * reached at all, which is what lets `'auto'` fall back to the device-code
   * transport.
   */
  presentSignInUrl(url: string): Effect.Effect<void, Error>;
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
   * The sign-in program. A host runs it at its own edge (command, IPC or
   * message handler), where its cancellation signal, if any, becomes fiber
   * interruption. Failures are the transports' own; their `message` is the
   * user-facing text.
   */
  signIn(
    options: SubscriptionSignInOptions,
  ): Effect.Effect<
    SubscriptionAccount,
    Error,
    HttpClient.HttpClient | SubscriptionAccounts
  >;
  /**
   * The sign-out program. A host runs it at its own edge; a failure is the
   * provider's own auth error or the secret store's rejection.
   */
  signOut(): Effect.Effect<
    void,
    SubscriptionStatusError,
    SubscriptionAccounts | HttpClient.HttpClient
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
   * Persist the preference. An `Effect`, like
   * every other write of a catalog-backed setting, so a host runs it at its own
   * edge and owns the failure.
   */
  setPreferSubscription(
    stores: SettingsStores,
    enabled: boolean,
  ): Effect.Effect<void, ConfigWriteFailed | Error>;
}

/** Fields the flow reads off a provider session; providers carry more. */
interface SubscriptionSessionFields {
  readonly email?: string;
  readonly accountId?: string;
}

/** The account a provider's session is held in, named by its route. */
type AccountOf<Id extends SubscriptionProviderId> =
  SubscriptionAccounts['Service'][(typeof SUBSCRIPTION_ROUTES)[Id]];

/** A row's descriptor fields pass through to the provider unchanged; the
 *  rest bind its transports to the shared flow. */
interface SubscriptionProviderBindings<
  Id extends SubscriptionProviderId,
> extends Pick<
  SubscriptionProvider,
  'displayName' | 'sessionName' | 'copyTarget' | 'modelFamily'
> {
  readonly id: Id;
  /** Absent where the provider offers no device-code sign-in. */
  readonly loginWithDeviceCode?: (options: {
    coordinator: AccountOf<Id>;
    onPrompt: (prompt: SubscriptionDeviceCodePrompt) => Effect.Effect<void>;
  }) => Effect.Effect<SubscriptionSessionFields, Error, HttpClient.HttpClient>;
  readonly loginWithLoopback: (options: {
    coordinator: AccountOf<Id>;
    openBrowser: (url: string) => Effect.Effect<void, Error>;
  }) => Effect.Effect<SubscriptionSessionFields, Error, HttpClient.HttpClient>;
  readonly accountLabel: (
    account:
      | { readonly email?: string | null; readonly accountId?: string | null }
      | null
      | undefined,
  ) => string;
}

/**
 * Bind one provider's transports to the shared sign-in flow. Two callers (the
 * catalog rows below); the flow it closes over is the whole point.
 */
function defineSubscriptionProvider<Id extends SubscriptionProviderId>({
  loginWithDeviceCode,
  loginWithLoopback,
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
    coordinator: AccountOf<Id>,
    options: SubscriptionSignInOptions,
  ): Effect.Effect<SubscriptionSessionFields, Error, HttpClient.HttpClient> =>
    loginWithDeviceCode === undefined
      ? Effect.fail(
          new Error(
            `${descriptor.displayName} sign-in has no device code: it returns to a browser on this machine (127.0.0.1). Sign in where TeXRA runs, or forward port 1455 from your browser's machine to this one.`,
          ),
        )
      : loginWithDeviceCode({
          coordinator,
          // The prompt is shown beside the poll, not before it: the poll waits on
          // the user, who may be reading (or dismissing) exactly this prompt. A
          // child fiber, so cancelling the sign-in closes it with the flow.
          onPrompt: (prompt) =>
            Effect.asVoid(
              Effect.forkChild(options.present.presentDeviceCode(prompt)),
            ),
        });

  const signIn = Effect.fn(`subscriptionProviders.${descriptor.id}.signIn`)(
    function* (options: SubscriptionSignInOptions) {
      const coordinator = yield* account;
      // A provider without a device code signs in through the browser even
      // when the host asked for one: on a remote host whose callback port is
      // forwarded, that still completes.
      const session =
        options.transport === 'device' && loginWithDeviceCode !== undefined
          ? yield* deviceCodeLogin(coordinator, options)
          : yield* loginWithLoopback({
              coordinator,
              openBrowser: (url) => options.present.presentSignInUrl(url),
            }).pipe(
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
                    Effect.andThen(deviceCodeLogin(coordinator, options)),
                  );
                },
              ),
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
    setPreferSubscription: (stores: SettingsStores, enabled: boolean) =>
      SubscriptionPreference.set(descriptor.id, stores, enabled),
    signIn,
    signOut: () =>
      Effect.flatMap(account, (coordinator) => coordinator.signOut()),
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
 *
 * Each binding calls through rather than capturing the imported function, so
 * a host suite that swaps `@texra-ai/llm/node` still intercepts the row —
 * the catalog is built once at module load.
 */
const CHATGPT_PROVIDER = defineSubscriptionProvider({
  id: 'chatgpt',
  displayName: 'ChatGPT',
  sessionName: 'ChatGPT',
  copyTarget: 'ChatGPT',
  modelFamily: 'OpenAI models',
  loginWithLoopback: (options) => chatgptLoginWithLoopback(options),
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
  loginWithDeviceCode: (options) => xaiLoginWithDeviceCode(options),
  loginWithLoopback: (options) => xaiLoginWithLoopback(options),
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
