import { getServerSideKeyService } from '@auth/serverKeys';
import { ModelProvider } from '@model/ModelConfig';
import { getConfig } from '@utils/config';
import { normalizeUrl } from '@utils/core';

const DEFAULT_PROXY_DOMAIN = 'proxy.texra.ai';

const PROXY_PATHS: Partial<Record<ModelProvider, string>> = {
  [ModelProvider.GOOGLE]: 'generativelanguage',
  [ModelProvider.OPENAI]: 'openai/v1',
  [ModelProvider.ANTHROPIC]: 'anthropic',
  [ModelProvider.XAI]: 'xai',
};

const BASE_URLS: Record<ModelProvider, string | null> = {
  [ModelProvider.GOOGLE]: null,
  [ModelProvider.OPENAI]: null,
  [ModelProvider.ANTHROPIC]: null,
  [ModelProvider.DEEPSEEK]: 'https://api.deepseek.com',
  [ModelProvider.XAI]: 'https://api.x.ai/v1',
  [ModelProvider.MOONSHOT]: 'https://api.moonshot.cn/v1',
  [ModelProvider.DASHSCOPE]:
    'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  [ModelProvider.COPILOT]: null,
  [ModelProvider.OTHERS]: null,
};

export interface ProxyConfig {
  provider: ModelProvider;
  openRouterOnly: boolean;
  customBaseUrl?: string; // Per-model custom base URL (overrides provider default)
  requiresResponsesAPI?: boolean; // Models requiring direct API access (bypasses OpenRouter)
  useServerSideKeys?: boolean; // Pre-computed by caller to avoid duplicated checks
  logger?: { debug: (message: string) => void };
}

/**
 * Determines whether OpenRouter should be used for API routing.
 * Models with requiresResponsesAPI bypass OpenRouter even if globally enabled.
 */
export function shouldUseOpenRouter(config: {
  requiresResponsesAPI?: boolean;
  openRouterOnly: boolean;
}): boolean {
  return (
    !config.requiresResponsesAPI &&
    (config.openRouterOnly ||
      getConfig<boolean>('texra.model.useOpenRouter', false))
  );
}

/**
 * Resolves the base URL for API requests.
 *
 * Priority order (mutually exclusive):
 * 1. Custom base URL (per-model override)
 * 2. Server-side keys relay (experimental, for Ultra users)
 * 3. Improved connection proxy (proxy.texra.ai)
 * 4. OpenRouter
 * 5. Provider default URLs
 *
 * Note: Server-side keys and proxy.texra.ai are MUTUALLY EXCLUSIVE.
 * When server-side keys are enabled, the relay handles everything
 * and proxy.texra.ai is not used.
 */
export function resolveBaseUrl(config: ProxyConfig): string | null {
  // Per-model custom base URL takes highest precedence (e.g., temporary endpoints)
  if (config.customBaseUrl) {
    config.logger?.debug(
      `Using custom base URL for model: ${config.customBaseUrl}`,
    );
    return config.customBaseUrl;
  }

  // Server-side keys via relay (experimental feature for Ultra users)
  // IMPORTANT: This path is MUTUALLY EXCLUSIVE with proxy.texra.ai.
  // When server-side keys are enabled, we use the Supabase Edge Function relay
  // which handles everything directly - no intermediate proxy is used.
  //
  // The caller (ModelHandler.shouldUseServerSideKeys) pre-computes this decision
  // to ensure consistency between URL routing and API key retrieval.
  if (config.useServerSideKeys) {
    const relayUrl = getServerSideKeyService().getRelayBaseUrl(config.provider);
    config.logger?.debug(
      `Using server-side keys relay for ${config.provider}: ${relayUrl}`,
    );
    return relayUrl;
  }

  // Below this point: standard routing (proxy.texra.ai, OpenRouter, or direct)
  // These paths are only used when server-side keys are NOT enabled.

  const useOpenRouter = shouldUseOpenRouter(config);
  const useImprovedConnection = getConfig<boolean>(
    'texra.model.useImprovedConnection',
    false,
  );

  if (useImprovedConnection) {
    // Use empty string as default so we can detect when config is not set
    // (using DEFAULT_PROXY_DOMAIN as default would prevent debug logging)
    const configValue = getConfig<string>(
      'texra.model.improvedConnectionDomain',
      '',
    );
    const domain = normalizeUrl(configValue.trim() || DEFAULT_PROXY_DOMAIN);
    if (!configValue.trim()) {
      config.logger?.debug(
        `Using default proxy domain: ${DEFAULT_PROXY_DOMAIN}`,
      );
    }

    if (useOpenRouter) {
      config.logger?.debug(`Using proxy for ${config.provider} for OpenRouter`);
      return `https://${domain}/openrouter`;
    }

    const path = PROXY_PATHS[config.provider];
    if (path) {
      config.logger?.debug(
        `Using proxy for ${config.provider}: with ${domain}/${path}`,
      );
      return `https://${domain}/${path}`;
    }
  }

  if (useOpenRouter) return 'https://openrouter.ai/api/v1';

  if (config.provider === ModelProvider.DEEPSEEK) {
    const customUrl = getConfig<string>('texra.model.baseUrlDeepSeek', '');
    if (customUrl) return `https://${normalizeUrl(customUrl)}`;
  }

  return BASE_URLS[config.provider];
}
