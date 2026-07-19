// Third-party imports
import {
  DEFAULT_MODEL_CAPABILITIES,
  type ModelCapabilities,
  type ModelConfig,
  ModelProvider,
} from 'llm-zoo';

type TestModelConfig = Partial<Omit<ModelConfig, 'capabilities'>> & {
  capabilities?: Partial<ModelCapabilities>;
};

/** Build a complete model config while keeping each test's meaningful overrides visible. */
export function buildTestModelConfig(
  config: TestModelConfig = {},
  overrides: TestModelConfig = {},
): ModelConfig {
  const { capabilities, ...configFields } = config;
  const { capabilities: capabilityOverrides, ...overrideFields } = overrides;

  return {
    name: 'test-model',
    label: 'Test Model',
    fullName: 'test-model',
    shortName: 'test-model',
    provider: ModelProvider.OPENAI,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 200_000,
    openRouterOnly: false,
    ...configFields,
    ...overrideFields,
    capabilities: {
      ...DEFAULT_MODEL_CAPABILITIES,
      ...capabilities,
      ...capabilityOverrides,
    },
  };
}
