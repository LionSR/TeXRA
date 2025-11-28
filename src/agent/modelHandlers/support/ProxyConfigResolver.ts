import { ModelProvider } from '@model/ModelConfig';
import { DEFAULT_PROXY_DOMAIN } from '@common/constants';
import { getConfig } from '@utils/config';
import { normalizeUrl } from '@utils/urlUtils';

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
  logger?: { debug: (message: string) => void };
}

export function resolveBaseUrl(config: ProxyConfig): string | null {
  const useOpenRouter =
    config.openRouterOnly ||
    getConfig<boolean>('texra.model.useOpenRouter', false);
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
