// Local imports - usage types
import type { UsageProvider } from './RunUsageAccumulator';

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';
import { ModelProvider } from '@model/ModelConfig';

export function resolveUsageProvider(
  handler: IModelHandler<any, any, any, any, any>,
): UsageProvider {
  if (handler.isAnthropic) {
    return 'anthropic';
  }
  if (handler.isGoogle) {
    return 'google';
  }
  if (handler.isOpenai || handler.isOpenaiCompatible) {
    return 'openai';
  }
  if (handler.config.provider === ModelProvider.DEEPSEEK) {
    return 'deepseek';
  }
  return 'unknown';
}
