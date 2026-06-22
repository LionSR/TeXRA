/**
 * Host-neutral setup-assistant launch helpers (PRD: agent-native onboarding).
 *
 * The VS Code host owns a richer launch path (`setupAssistantCommand.ts`) with
 * interactive credential/routing prompts. Hosts without a quick-pick UI (the
 * Electron desktop shell) need a smaller, prompt-free path: resolve a model the
 * user's current credentials can actually call and build the execute request the
 * shared agent-run path consumes. This module keeps that resolution truth in one
 * agnostic place so desktop does not re-derive setup routing.
 */

import { platform } from '@platform/platform';
import { isCodexSubscriptionActive } from '@auth/codex';
import { getServerSideKeyService } from '@auth/serverKeys';
import { lookupApiKey, API_PROVIDERS } from '@model/apiProviders';
import {
  CHATGPT_SETUP_MODEL,
  SETUP_MODEL_BY_PROVIDER,
} from '@model/setupModelDefaults';
import { DEFAULT_AGENT_MODEL } from '@shared/constants/providers';
import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { isNonEmptyString } from '@utils/core';
import { getUseOpenRouter } from '@utils/config/providerConfig';

import type { MainViewExecuteMessage } from '@controllers/mainView/MainViewExecutionMessageController';

/** Instruction handed to the setup agent on auto-kickoff (mirrors the extension). */
export const SETUP_INSTRUCTION =
  'Please help me finish installing TeXRA. Probe my environment, install anything missing, and get me a working credential.';

/**
 * Pick a model the setup agent can actually call given the user's current
 * credentials and the global `useOpenRouter` routing flag. Returns `null` when
 * no credential resolves to a runnable model (the caller refuses launch rather
 * than starting a run that fails at runtime). Mirrors the extension's
 * `resolveLaunchModel`, minus the OpenRouter-flag flip (desktop has no
 * interactive routing prompt, so it only uses OpenRouter when the flag is
 * already on or an OpenRouter key is the only credential).
 */
export async function resolveDesktopSetupModel(): Promise<string | null> {
  // Global OR routing re-routes every call through OpenRouter regardless of
  // provider, so a direct/server pick would be misrouted — short-circuit to the
  // OR-routed default.
  if (getUseOpenRouter()) {
    return SETUP_MODEL_BY_PROVIDER.openRouter;
  }

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

  const secrets = platform().secrets;
  for (const provider of API_PROVIDERS) {
    if (provider === 'openRouter') continue;
    const model = SETUP_MODEL_BY_PROVIDER[provider];
    if (!model) continue;
    if (isNonEmptyString(await lookupApiKey(secrets, provider))) {
      return model;
    }
  }

  if (isNonEmptyString(await lookupApiKey(secrets, 'openRouter'))) {
    return SETUP_MODEL_BY_PROVIDER.openRouter;
  }

  return null;
}

/**
 * Build the execute message that auto-starts the setup conversation, or `null`
 * when no credential resolves to a runnable model. The message rides the same
 * `handleExecute` path the renderer's execute button uses.
 */
export async function buildDesktopSetupExecuteMessage(): Promise<MainViewExecuteMessage | null> {
  const model = await resolveDesktopSetupModel();
  if (!model) return null;
  return {
    agent: SETUP_AGENT_NAME,
    model,
    instruction: SETUP_INSTRUCTION,
    isToolUseAgent: true,
  };
}
