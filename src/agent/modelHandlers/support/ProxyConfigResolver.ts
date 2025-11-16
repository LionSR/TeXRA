/**
 * Provider configuration resolver for handling proxy and base URL configuration.
 * Extracts and centralizes the logic for determining API endpoints based on provider and configuration settings.
 */

import { ModelProvider } from '@model/ModelConfig';
import { getConfig } from '@utils/config';
import { normalizeUrl } from '@utils/urlUtils';

const DEFAULT_PROXY_DOMAIN = 'proxy.texra.ai';

/**
 * Mapping of providers to their proxy paths
 */
const PROXY_PATHS: Partial<Record<ModelProvider, string>> = {
  [ModelProvider.GOOGLE]: 'generativelanguage',
  [ModelProvider.OPENAI]: 'openai/v1',
  [ModelProvider.ANTHROPIC]: 'anthropic',
  [ModelProvider.XAI]: 'xai',
};

/**
 * Mapping of providers to their base URLs
 */
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

/**
 * Configuration for proxy resolution
 */
export interface ProxyConfig {
  provider: ModelProvider;
  openRouterOnly: boolean;
  logger?: {
    debug: (message: string) => void;
  };
}

/**
 * Resolves base URLs for API requests based on provider and configuration.
 */
export class ProxyConfigResolver {
  /**
   * Gets the proxy domain from configuration
   * @param logger Optional logger for debug messages
   * @returns Normalized proxy domain
   */
  private static getProxyDomain(logger?: {
    debug: (message: string) => void;
  }): string {
    const configValue = getConfig<string>(
      'texra.model.improvedConnectionDomain',
      DEFAULT_PROXY_DOMAIN,
    );
    let domain = (configValue || '').trim();

    if (!domain) {
      logger?.debug(`Using default proxy domain: ${DEFAULT_PROXY_DOMAIN}`);
      domain = DEFAULT_PROXY_DOMAIN;
    }

    return normalizeUrl(domain);
  }

  /**
   * Checks if OpenRouter should be used
   * @param openRouterOnly Whether the model requires OpenRouter
   * @returns True if OpenRouter should be used
   */
  private static shouldUseOpenRouter(openRouterOnly: boolean): boolean {
    return (
      openRouterOnly || getConfig<boolean>('texra.model.useOpenRouter', false)
    );
  }

  /**
   * Checks if improved connection (proxy) should be used
   * @returns True if improved connection is enabled
   */
  private static shouldUseImprovedConnection(): boolean {
    return getConfig<boolean>('texra.model.useImprovedConnection', false);
  }

  /**
   * Resolves the base URL for a provider with proxy support
   * @param config Provider and configuration settings
   * @returns Base URL for the provider or null for default URLs
   */
  static resolveBaseUrl(config: ProxyConfig): string | null {
    const useOpenRouter = this.shouldUseOpenRouter(config.openRouterOnly);
    const useImprovedConnection = this.shouldUseImprovedConnection();

    if (useImprovedConnection) {
      const domain = this.getProxyDomain(config.logger);

      if (useOpenRouter) {
        config.logger?.debug(
          `Using proxy for ${config.provider} for OpenRouter`,
        );
        return `https://${domain}/openrouter`;
      }

      const path = PROXY_PATHS[config.provider];
      if (path) {
        config.logger?.debug(
          `Using proxy for ${config.provider}: with ${domain}/${path}`,
        );
        return `https://${domain}/${path}`;
      }

      // Provider not supported by proxy, fall through to regular URLs
    }

    if (useOpenRouter) {
      return 'https://openrouter.ai/api/v1';
    }

    // Handle custom DeepSeek URL
    if (config.provider === ModelProvider.DEEPSEEK) {
      const customUrl = this.getCustomDeepSeekUrl();
      if (customUrl) {
        return customUrl;
      }
    }

    return BASE_URLS[config.provider];
  }

  /**
   * Gets custom DeepSeek URL from configuration
   * @returns Normalized custom URL or null
   */
  private static getCustomDeepSeekUrl(): string | null {
    const customDeepSeekUrl = getConfig<string>(
      'texra.model.baseUrlDeepSeek',
      '',
    );
    if (customDeepSeekUrl) {
      const normalized = normalizeUrl(customDeepSeekUrl);
      return `https://${normalized}`;
    }
    return null;
  }

  /**
   * Checks if a provider is supported by the proxy
   * @param provider The provider to check
   * @returns True if the provider has a proxy path
   */
  static isProviderSupportedByProxy(provider: ModelProvider): boolean {
    return provider in PROXY_PATHS;
  }

  /**
   * Gets the proxy path for a provider
   * @param provider The provider
   * @returns The proxy path or null if not supported
   */
  static getProxyPath(provider: ModelProvider): string | null {
    return PROXY_PATHS[provider] ?? null;
  }
}
