import { platform } from '@platform/platform';
import {
  getCodexStatus,
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@auth/codex';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  chatGptAccountLabel,
  shouldUseChatGptDeviceCode,
  signInCliChatGpt,
} from './chatgptLogin';
import {
  effectiveCliApiMode,
  setCliApiMode,
  type CliApiMode,
} from './apiAccessMode';
import type { CliContext } from './cliContext';
import type {
  CliModelAccessRoute,
  CliModelAccessStatus,
} from './modelAccessRoute';

export interface CliModelAccessSelectionResult {
  /** API fallback retained beneath subscription-based access. */
  readonly apiMode: CliApiMode;
  readonly message: string;
}

/** Apply a launcher access choice to the context used by the selected session. */
export function contextForCliModelAccess(
  context: CliContext,
  apiMode: CliApiMode | undefined,
): CliContext {
  return apiMode ? { ...context, apiMode } : context;
}

export async function readCliModelAccessStatus(
  apiMode: CliApiMode,
): Promise<CliModelAccessStatus> {
  const chatGpt = await getCodexStatus();
  return {
    active:
      chatGpt.signedIn && isPreferCodexSubscription() ? 'chatgpt' : apiMode,
    chatGptSignedIn: chatGpt.signedIn,
    chatGptAccountLabel: chatGpt.email ?? chatGpt.accountId,
  };
}

export async function selectCliModelAccessRoute(
  context: CliContext,
  route: CliModelAccessRoute,
  options: { readonly writeProgress: (message: string) => void },
): Promise<CliModelAccessSelectionResult> {
  if (route !== 'chatgpt') {
    const update = await setPreferCodexSubscription(false);
    await setCliApiMode(route);
    return {
      apiMode: route,
      message: update.effective
        ? `Model access remains on ChatGPT subscription because a more specific setting overrides ${update.target} config.`
        : `Model access set to ${route === 'included' ? 'included TeXRA access' : 'personal API keys'}.`,
    };
  }

  const status = await getCodexStatus();
  if (status.signedIn && isPreferCodexSubscription()) {
    const update = await setPreferCodexSubscription(false);
    invalidateModelOptionsCache();
    return {
      apiMode: effectiveCliApiMode(context),
      message: update.effective
        ? `Prefer ChatGPT subscription remains enabled because a more specific setting overrides ${update.target} config.`
        : 'Prefer ChatGPT subscription disabled for Codex models.',
    };
  }

  let accountLabel = status.email ?? status.accountId ?? 'your account';
  if (!status.signedIn) {
    const init = { device: false, noBrowser: false };
    const session = await signInCliChatGpt(
      {
        ...init,
        device: shouldUseChatGptDeviceCode(context, init),
      },
      options,
    );
    accountLabel = chatGptAccountLabel(session);
  }

  const update = await setPreferCodexSubscription(true);
  await platform().globalState.update(GlobalStateKey.USE_OPENROUTER, false);
  invalidateModelOptionsCache();
  return {
    apiMode: effectiveCliApiMode(context),
    message: update.effective
      ? `Prefer ChatGPT subscription enabled for Codex models (${accountLabel}).`
      : 'ChatGPT sign-in succeeded, but a more specific setting keeps subscription access disabled.',
  };
}
