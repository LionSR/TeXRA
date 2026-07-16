import { afterEach, describe, expect, it } from 'vitest';
import { MODEL_CONFIGS } from 'llm-zoo';

import { installPlatform } from '@test/support/setupPlatform';
import {
  CODEX_SESSION_SECRET_KEY,
  resetCodexCoordinator,
  type CodexSession,
} from '@auth/codex';
import { isCodexSubscriptionActive } from '@model/codexSubscriptionActive';
import {
  resolveCodexSubscriptionCapabilities,
  resolveCodexSubscriptionCapabilitiesForAgentCategory,
} from '@model/codexSubscriptionRouting';
import { AgentCategory } from '@shared/schemas/agent';

const signedInSession: CodexSession = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAtMs: Date.now() + 10 * 60_000,
  accountId: 'account-id',
};

async function installSubscriptionPlatform(options?: {
  useOpenRouter?: boolean;
  signedIn?: boolean;
  toolUseOnly?: boolean;
}): Promise<void> {
  await installPlatform({
    config: {
      'texra.chatgptCodex.preferSubscription': true,
      'texra.chatgptCodex.subscriptionToolUseOnly':
        options?.toolUseOnly ?? false,
    },
    globalState: {
      'texra.useOpenRouter': options?.useOpenRouter ?? false,
    },
    secrets:
      options?.signedIn === false
        ? {}
        : { [CODEX_SESSION_SECRET_KEY]: JSON.stringify(signedInSession) },
  });
}

describe('ChatGPT subscription model routing', () => {
  afterEach(() => {
    resetCodexCoordinator();
  });

  it('keeps eligible OpenAI models on the direct API route when the preference is off', async () => {
    await installPlatform();

    expect(
      resolveCodexSubscriptionCapabilities(MODEL_CONFIGS.gpt55, false),
    ).toBeNull();
  });

  it('does not override OpenRouter routing', async () => {
    await installSubscriptionPlatform({ useOpenRouter: true });

    expect(
      resolveCodexSubscriptionCapabilities(MODEL_CONFIGS.gpt55, true),
    ).toBeNull();
    await expect(isCodexSubscriptionActive('gpt55')).resolves.toBe(false);
  });

  it('routes an eligible direct OpenAI model through the preferred subscription', async () => {
    await installSubscriptionPlatform();

    expect(
      resolveCodexSubscriptionCapabilities(MODEL_CONFIGS.gpt55, false),
    ).not.toBeNull();
  });

  it('restricts subscription routing to tool-use agents when configured', async () => {
    await installSubscriptionPlatform({ toolUseOnly: true });

    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        AgentCategory.Workflow,
      ),
    ).toBeNull();
    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        AgentCategory.ToolUse,
      ),
    ).not.toBeNull();
    expect(
      resolveCodexSubscriptionCapabilitiesForAgentCategory(
        MODEL_CONFIGS.gpt55,
        false,
        undefined,
      ),
    ).toBeNull();
    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.Workflow),
    ).resolves.toBe(false);
    await expect(
      isCodexSubscriptionActive('gpt55', AgentCategory.ToolUse),
    ).resolves.toBe(true);
  });

  it('reports eligible models inactive while signed out', async () => {
    await installSubscriptionPlatform({ signedIn: false });

    await expect(isCodexSubscriptionActive('gpt55')).resolves.toBe(false);
  });

  it('reports eligible models active for a signed-in preferred subscription', async () => {
    await installSubscriptionPlatform();

    await expect(isCodexSubscriptionActive('gpt55')).resolves.toBe(true);
  });

  it('reports unknown model identifiers inactive', async () => {
    await installSubscriptionPlatform();

    await expect(
      isCodexSubscriptionActive('unknown-subscription-model'),
    ).resolves.toBe(false);
  });
});
