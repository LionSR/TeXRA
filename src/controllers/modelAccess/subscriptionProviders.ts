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
 * Lives in `src/controllers/` rather than `src/auth/` because a row binds an
 * auth transport to its model-layer routing preference, and `src/auth/**` is
 * fenced off from `@model` (eslint `AUTH_RESTRICTED_IMPORT_PATTERNS`). This is
 * the same composition `chatGptAuthStatus.ts` / `grokAuthStatus.ts` already do.
 */
import {
  codexCoordinator,
  getCodexStatus,
  loginWithDeviceCode as codexLoginWithDeviceCode,
  loginWithLoopback as codexLoginWithLoopback,
} from '@auth/codex';
import {
  getXaiStatus,
  loginWithDeviceCode as xaiLoginWithDeviceCode,
  loginWithLoopback as xaiLoginWithLoopback,
  xaiAccountLabel,
  xaiCoordinator,
} from '@auth/xai';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { LoopbackTransportUnavailableError } from '@auth/oauth/loopbackLogin';
import type { SubscriptionSessionStatus } from '@auth/oauth/SubscriptionOAuthCoordinator';
import { createLog } from '@logger/logUtils';
import type { SubscriptionPreferenceUpdate } from '@model/subscriptionPreference';
import {
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@model/codex/codexPreference';
import {
  isPreferXaiSubscription,
  setPreferXaiSubscription,
} from '@model/xai/xaiPreference';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('subscriptionProviders');

export type SubscriptionProviderId = 'chatgpt' | 'grok';

/** The device-code prompt a host renders while polling for approval. */
export interface SubscriptionDeviceCodePrompt {
  readonly userCode: string;
  readonly verificationUrl: string;
  /** Prefilled verification URL when the provider supplies one (xAI). */
  readonly verificationUrlComplete?: string;
}

/**
 * The only host-specific half of a subscription sign-in: how this host shows
 * the user the two things an OAuth flow can ask of them.
 */
export interface SubscriptionSignInPresenter {
  /**
   * Show the one-time code and where to enter it. Called once, before the
   * poll loop starts; hosts that present asynchronously own their own error
   * reporting because the flow does not wait for the prompt.
   */
  presentDeviceCode(prompt: SubscriptionDeviceCodePrompt): void;
  /**
   * Show (and normally open) the loopback consent URL. Awaited before the
   * callback wait begins, so a host may block on a browser-choice dialog.
   * Throw to cancel the sign-in; throw {@link LoopbackTransportUnavailableError}
   * when no browser could be reached at all, which is what lets `'auto'` fall
   * back to the device-code transport.
   */
  presentSignInUrl(url: string): void | Promise<void>;
}

/** A signed-in (or known-signed-out) subscription account, host-neutral. */
export interface SubscriptionAccount extends SubscriptionSessionStatus {
  /** Provider-worded label: the email, the account id, or a generic fallback. */
  readonly label: string;
}

/**
 * `'loopback'` and `'device'` pick a transport outright. `'auto'` prefers
 * loopback and falls back to device-code when the loopback route cannot be
 * established at all (callback port unbindable, or no reachable browser).
 */
type SubscriptionTransport = 'loopback' | 'device' | 'auto';

interface SubscriptionSignInOptions {
  readonly transport: SubscriptionTransport;
  readonly present: SubscriptionSignInPresenter;
  readonly signal?: AbortSignal;
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
  signIn(options: SubscriptionSignInOptions): Promise<SubscriptionAccount>;
  signOut(): Promise<void>;
  getStatus(): Promise<SubscriptionAccount>;
  isPreferSubscription(): boolean;
  setPreferSubscription(
    enabled: boolean,
  ): Promise<SubscriptionPreferenceUpdate>;
}

/** Fields the flow reads off a provider session; providers carry more. */
interface SubscriptionSessionFields {
  readonly email?: string;
  readonly accountId?: string;
}

interface SubscriptionProviderBindings<Coordinator, Session> {
  readonly id: SubscriptionProviderId;
  readonly displayName: string;
  readonly sessionName: string;
  readonly copyTarget: string;
  readonly modelFamily: string;
  readonly coordinator: () => Coordinator & {
    signOut(): Promise<void>;
  };
  readonly getStatus: () => Promise<SubscriptionSessionStatus>;
  readonly loginWithDeviceCode: (options: {
    coordinator: Coordinator;
    onPrompt: (prompt: SubscriptionDeviceCodePrompt) => void;
    signal?: AbortSignal;
  }) => Promise<Session>;
  readonly loginWithLoopback: (options: {
    coordinator: Coordinator;
    openBrowser: (url: string) => void | Promise<void>;
    signal?: AbortSignal;
  }) => Promise<Session>;
  readonly accountLabel: (
    account:
      | { readonly email?: string | null; readonly accountId?: string | null }
      | null
      | undefined,
  ) => string;
  readonly isPrefer: () => boolean;
  readonly setPrefer: (
    enabled: boolean,
  ) => Promise<SubscriptionPreferenceUpdate>;
}

/**
 * Bind one provider's transports to the shared sign-in flow. Two callers (the
 * catalog rows below); the flow it closes over is the whole point.
 */
function defineSubscriptionProvider<
  Coordinator,
  Session extends SubscriptionSessionFields,
>(
  bindings: SubscriptionProviderBindings<Coordinator, Session>,
): SubscriptionProvider {
  function deviceCodeLogin(
    coordinator: Coordinator,
    options: SubscriptionSignInOptions,
  ): Promise<Session> {
    return bindings.loginWithDeviceCode({
      coordinator,
      onPrompt: (prompt) => options.present.presentDeviceCode(prompt),
      signal: options.signal,
    });
  }

  async function runSignIn(
    options: SubscriptionSignInOptions,
  ): Promise<Session> {
    const coordinator = bindings.coordinator();
    if (options.transport === 'device') {
      return deviceCodeLogin(coordinator, options);
    }
    try {
      return await bindings.loginWithLoopback({
        coordinator,
        openBrowser: (url) => options.present.presentSignInUrl(url),
        signal: options.signal,
      });
    } catch (error: unknown) {
      if (
        options.transport !== 'auto' ||
        !(error instanceof LoopbackTransportUnavailableError)
      ) {
        throw error;
      }
      log.warn(
        `${bindings.displayName} browser sign-in is unavailable, falling back to a one-time device code: ${toErrorMessage(error)}`,
      );
      return deviceCodeLogin(coordinator, options);
    }
  }

  return Object.freeze({
    id: bindings.id,
    displayName: bindings.displayName,
    sessionName: bindings.sessionName,
    copyTarget: bindings.copyTarget,
    modelFamily: bindings.modelFamily,
    async signIn(options: SubscriptionSignInOptions) {
      const session = await runSignIn(options);
      return {
        signedIn: true,
        email: session.email,
        accountId: session.accountId,
        label: bindings.accountLabel(session),
      };
    },
    signOut: () => bindings.coordinator().signOut(),
    async getStatus() {
      const status = await bindings.getStatus();
      return { ...status, label: bindings.accountLabel(status) };
    },
    isPreferSubscription: bindings.isPrefer,
    setPreferSubscription: bindings.setPrefer,
  });
}

/**
 * Experimental "Sign in with ChatGPT": Codex-eligible models then run on the
 * user's ChatGPT Plus/Pro/Team subscription instead of an OpenAI API key.
 */
const CHATGPT_PROVIDER = defineSubscriptionProvider({
  id: 'chatgpt',
  displayName: 'ChatGPT',
  sessionName: 'ChatGPT',
  copyTarget: 'ChatGPT',
  modelFamily: 'Codex models',
  coordinator: codexCoordinator,
  getStatus: getCodexStatus,
  loginWithDeviceCode: codexLoginWithDeviceCode,
  loginWithLoopback: codexLoginWithLoopback,
  accountLabel: codexAccountLabel,
  isPrefer: isPreferCodexSubscription,
  setPrefer: setPreferCodexSubscription,
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
  coordinator: xaiCoordinator,
  getStatus: getXaiStatus,
  loginWithDeviceCode: xaiLoginWithDeviceCode,
  loginWithLoopback: xaiLoginWithLoopback,
  accountLabel: xaiAccountLabel,
  isPrefer: isPreferXaiSubscription,
  setPrefer: setPreferXaiSubscription,
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
