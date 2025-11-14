// Local imports - usage types

// Local imports - model handlers
import type { IModelHandler } from '@agent/modelHandlers';

// Internal imports
import { ModelProvider } from '@model/ModelConfig';

// Type imports
import type { UsageProvider } from './RunUsageAccumulator';

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
