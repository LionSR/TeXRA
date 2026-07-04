import { platform } from '@platform/platform';
import { isCodexSubscriptionActive } from '@auth/codex';
import { getServerSideKeyService } from '@auth/serverKeys';
import { lookupApiKey, API_PROVIDERS } from '@model/apiProviders';
import { decideRunModel } from '@model/runModelDecision';
import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';
import type { MainViewExecuteMessage } from '@shared/mainView';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { isNonEmptyString } from '@utils/core';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import type { PlatformSecrets } from '@platform/secrets';

/** Instruction handed to the setup agent when launched (mirrors the extension). */
export const SETUP_INSTRUCTION =
  'Please help me finish installing TeXRA. Probe my environment, install anything missing, and get me a working credential.';

/**
 * Scan non-OpenRouter setup credentials in host-shared priority order:
 * ChatGPT/Codex subscription, server-side default, server-side provider setup
 * model, then direct provider key.
 */
export async function selectSetupCredentialModelExcludingOpenRouter(
  secrets: PlatformSecrets,
): Promise<string | null> {
  if (await isCodexSubscriptionActive(CHATGPT_SETUP_MODEL)) {
    return CHATGPT_SETUP_MODEL;
  }

  const serverKeys = getServerSideKeyService();
  if (await serverKeys.canUseServerSideKeysForModel(DEFAULT_AGENT_MODEL)) {
    return DEFAULT_AGENT_MODEL;
  }
  if (await serverKeys.canUseServerSideKeys()) {
    for (const [provider, model] of Object.entries(SETUP_MODEL_BY_PROVIDER)) {
      if (provider === 'openRouter') continue;
      if (serverKeys.canUseModelSync(model)) return model;
    }
  }

  for (const provider of API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    const model = SETUP_MODEL_BY_PROVIDER[provider];
    if (!model) continue;
    if (isNonEmptyString(await lookupApiKey(secrets, provider))) {
      return model;
    }
  }

  return null;
}

/**
 * Desktop has no routing prompt, so OpenRouter is chosen only when the flag is
 * already on and an OpenRouter key exists.
 */
export async function selectDesktopSetupModel(): Promise<string | null> {
  const secrets = platform().secrets;
  const useOpenRouter = getUseOpenRouter();

  const routerModel =
    useOpenRouter && isNonEmptyString(await lookupApiKey(secrets, 'openRouter'))
      ? SETUP_MODEL_BY_PROVIDER.openRouter
      : null;
  if (useOpenRouter && !routerModel) {
    return null;
  }

  return (
    decideRunModel([
      {
        model: routerModel,
        reason: 'router-config',
      },
      {
        model: useOpenRouter
          ? null
          : await selectSetupCredentialModelExcludingOpenRouter(secrets),
        reason: 'credential',
      },
    ])?.model ?? null
  );
}

/**
 * Build the execute message that launches the setup conversation, or `null`
 * when no credential resolves to a runnable model. The message rides the same
 * `handleExecute` path the renderer's execute button uses.
 */
export async function buildDesktopSetupExecuteMessage(): Promise<MainViewExecuteMessage | null> {
  const model = await selectDesktopSetupModel();
  if (!model) return null;
  return {
    agent: SETUP_AGENT_NAME,
    model,
    instruction: SETUP_INSTRUCTION,
    isToolUseAgent: true,
  };
}
