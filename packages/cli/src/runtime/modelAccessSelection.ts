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
import {
  formatCliModelAccessRoute,
  type CliModelAccessRoute,
  type CliModelAccessStatus,
} from './modelAccessRoute';
import type { CliContext } from './cliContext';

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

/** Select an API-backed route and stop preferring ChatGPT subscription use. */
export async function selectCliApiModelAccessRoute(
  route: CliApiMode,
): Promise<CliModelAccessSelectionResult> {
  const update = await setPreferCodexSubscription(false);
  await setCliApiMode(route);
  return {
    apiMode: route,
    message: update.effective
      ? `Model access remains on ChatGPT subscription because a more specific setting overrides ${update.target} config.`
      : `Model access: ${formatCliModelAccessRoute(route)}.`,
  };
}

export async function selectCliModelAccessRoute(
  context: CliContext,
  route: CliModelAccessRoute,
  options: { readonly writeProgress: (message: string) => void },
): Promise<CliModelAccessSelectionResult> {
  if (route !== 'chatgpt') {
    return selectCliApiModelAccessRoute(route);
  }

  const status = await getCodexStatus();
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
