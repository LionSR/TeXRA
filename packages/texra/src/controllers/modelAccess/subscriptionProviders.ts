/**
 * Canonical catalog of the OAuth subscription providers — "Sign in with
 * ChatGPT" (Codex) and "Sign in with Grok" (xAI).
 *
 * Every host used to restate the same descriptor per provider (coordinator,
 * both login transports, account label, preference setter, display name) and
 * then re-write the same device-code-vs-loopback runner around it. Only the
 * *presentation* actually differs, so that is the one thing a host supplies:
 * a {@link SubscriptionSignInPresenter}. Adding a third provider is one row
 * here, not another descriptor in each host.
 *
 * Lives in `packages/harness/src/controllers/` rather than in `@texra-ai/llm` because a row
 * binds a sign-in flow to its model-layer routing preference, a setting the
 * package never reads; {@link subscriptionAuthStatus} joins the same two
 * facts for the settings views.
 */
import { Effect } from 'effect';

import {
  type AuthPortError,
  codexCoordinator,
  codexLoginWithDeviceCode,
  codexLoginWithLoopback,
  getCodexStatus,
  getXaiStatus,
  LoopbackTransportUnavailableError,
  type SubscriptionDeviceCodePrompt,
  type SubscriptionSessionStatus,
  xaiCoordinator,
  xaiLoginWithDeviceCode,
  xaiLoginWithLoopback,
} from '@texra-ai/llm/node';
import { codexAccountLabel, xaiAccountLabel } from '@texra-ai/llm';
import { Secrets, type PlatformSecrets } from '@texra-ai/harness';
import { withLogChannel } from '@logger/effectLog';
import {
  isPreferSubscription,
  setPreferSubscription,
} from '@model/subscriptionAccess';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type {
  SUBSCRIPTION_AUTH_PROVIDERS,
  SubscriptionAuthStatus,
} from '@shared/model/subscriptionAuth';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ConfigWriteFailed } from '@texra-ai/harness';
import type { HttpClient } from 'effect/http';

const CHANNEL = 'subscriptionProviders';

/**
 * A provider's id, spelled once: the wire vocabulary in
 * `@shared/model/subscriptionAuth` is the same set the catalog keys on.
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
  /** Models the subscription unlocks ('Codex models', 'xAI models'). */
  readonly modelFamily: string;
  /**
   * The sign-in program. A host runs it at its own edge (command, IPC or
   * message handler), where its cancellation signal, if any, becomes fiber
   * interruption. Failures are the transports' own; their `message` is the
   * user-facing text.
   */
  signIn(
    options: SubscriptionSignInOptions,
  ): Effect.Effect<SubscriptionAccount, Error, HttpClient.HttpClient | Secrets>;
  /**
   * The sign-out program. A host runs it at its own edge; a failure is the
   * provider's own auth error or the secret store's rejection.
   */
  signOut(secrets: PlatformSecrets): Effect.Effect<void, AuthPortError>;
  /**
   * The signed-in status. Infallible: an unreadable store reports
   * signed-out, with the cause logged by the probe.
   */
  getStatus(secrets: PlatformSecrets): Effect.Effect<SubscriptionAccount>;
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

/** A row's descriptor fields pass through to the provider unchanged; the
 *  rest bind its transports to the shared flow. */
interface SubscriptionProviderBindings<Coordinator, Session> extends Pick<
  SubscriptionProvider,
  'id' | 'displayName' | 'sessionName' | 'copyTarget' | 'modelFamily'
> {
  readonly coordinator: (secrets: PlatformSecrets) => Coordinator & {
    signOut(): Effect.Effect<void, AuthPortError>;
  };
  readonly getStatus: (
    secrets: PlatformSecrets,
  ) => Effect.Effect<SubscriptionSessionStatus>;
  readonly loginWithDeviceCode: (options: {
    coordinator: Coordinator;
    onPrompt: (prompt: SubscriptionDeviceCodePrompt) => Effect.Effect<void>;
  }) => Effect.Effect<Session, Error, HttpClient.HttpClient>;
  readonly loginWithLoopback: (options: {
    coordinator: Coordinator;
    openBrowser: (url: string) => Effect.Effect<void, Error>;
  }) => Effect.Effect<Session, Error, HttpClient.HttpClient>;
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
function defineSubscriptionProvider<
  Coordinator,
  Session extends SubscriptionSessionFields,
>({
  coordinator: bindCoordinator,
  getStatus,
  loginWithDeviceCode,
  loginWithLoopback,
  accountLabel,
  ...descriptor
}: SubscriptionProviderBindings<Coordinator, Session>): SubscriptionProvider {
  const deviceCodeLogin = (
    coordinator: Coordinator,
    options: SubscriptionSignInOptions,
  ) =>
    loginWithDeviceCode({
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
      const coordinator = bindCoordinator(yield* Secrets);
      const session =
        options.transport === 'device'
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
      isPreferSubscription(descriptor.id, stores),
    setPreferSubscription: (stores: SettingsStores, enabled: boolean) =>
      setPreferSubscription(descriptor.id, stores, enabled),
    signIn,
    signOut: (secrets: PlatformSecrets) => bindCoordinator(secrets).signOut(),
    getStatus: (secrets: PlatformSecrets) =>
      Effect.map(getStatus(secrets), (status) => ({
        ...status,
        label: accountLabel(status),
      })),
  });
}

/**
 * Experimental "Sign in with ChatGPT": Codex-eligible models then run on the
 * user's ChatGPT Plus/Pro/Team subscription instead of an OpenAI API key.
 *
 * Each binding calls through rather than capturing the imported function, so
 * a host suite that swaps `@texra-ai/llm/node` or `@model/subscriptionAccess`
 * still intercepts the row — the catalog is built once at module load.
 */
const CHATGPT_PROVIDER = defineSubscriptionProvider({
  id: 'chatgpt',
  displayName: 'ChatGPT',
  sessionName: 'ChatGPT',
  copyTarget: 'ChatGPT',
  modelFamily: 'Codex models',
  coordinator: (secrets) => codexCoordinator(secrets),
  getStatus: (secrets) => getCodexStatus(secrets),
  loginWithDeviceCode: (options) => codexLoginWithDeviceCode(options),
  loginWithLoopback: (options) => codexLoginWithLoopback(options),
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
  coordinator: (secrets) => xaiCoordinator(secrets),
  getStatus: (secrets) => getXaiStatus(secrets),
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
  secrets: PlatformSecrets,
): Effect.Effect<SubscriptionAuthStatus> {
  const provider = subscriptionProvider(providerId);
  return Effect.map(provider.getStatus(secrets), (status) => ({
    provider: providerId,
    signedIn: status.signedIn,
    email: status.email,
    accountId: status.accountId,
    preferSubscription: provider.isPreferSubscription(stores),
  }));
}
