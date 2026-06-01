const { writeOutput } = require('./github-output.cjs');

const REVIEW_PROVIDER_CONFIGS = [
  {
    provider: 'deepseek',
    keyEnv: 'DEEPSEEK_API_KEY',
    modelEnv: 'TEXRA_REVIEW_DEEPSEEK_MODEL',
    defaultModel: 'deepseekproT',
  },
  {
    provider: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'TEXRA_REVIEW_ANTHROPIC_MODEL',
    defaultModel: 'opus48T',
  },
  {
    provider: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'TEXRA_REVIEW_OPENAI_MODEL',
    defaultModel: 'gpt55',
  },
  {
    provider: 'google',
    keyEnv: 'GOOGLE_API_KEY',
    modelEnv: 'TEXRA_REVIEW_GOOGLE_MODEL',
    defaultModel: 'gemini31p',
  },
  {
    provider: 'openRouter',
    keyEnv: 'OPENROUTER_API_KEY',
    modelEnv: 'TEXRA_REVIEW_OPENROUTER_MODEL',
    defaultModel: 'gptoss',
  },
  {
    provider: 'xai',
    keyEnv: 'XAI_API_KEY',
    modelEnv: 'TEXRA_REVIEW_XAI_MODEL',
    defaultModel: 'grok4',
  },
];

const DEFAULT_REVIEW_MODEL_BY_PROVIDER = Object.fromEntries(
  REVIEW_PROVIDER_CONFIGS.map(({ provider, defaultModel }) => [
    provider,
    defaultModel,
  ]),
);

const REVIEW_MODEL_PROVIDER_ORDER = REVIEW_PROVIDER_CONFIGS.map(
  ({ provider }) => provider,
);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function resolveReviewModel({
  configuredModel,
  providerKeys = {},
  providerModels = {},
} = {}) {
  const explicitModel = nonEmpty(configuredModel);
  if (explicitModel) return { model: explicitModel, source: 'configured' };

  for (const provider of REVIEW_MODEL_PROVIDER_ORDER) {
    if (!nonEmpty(providerKeys[provider])) continue;
    return {
      model:
        nonEmpty(providerModels[provider]) ||
        DEFAULT_REVIEW_MODEL_BY_PROVIDER[provider],
      source: provider,
    };
  }

  return {
    model: DEFAULT_REVIEW_MODEL_BY_PROVIDER.deepseek,
    source: 'default',
  };
}

function resolveReviewModelFromEnv(env = process.env) {
  return resolveReviewModel({
    configuredModel: env.TEXRA_REVIEW_MODEL,
    providerKeys: Object.fromEntries(
      REVIEW_PROVIDER_CONFIGS.map(({ provider, keyEnv }) => [
        provider,
        env[keyEnv],
      ]),
    ),
    providerModels: Object.fromEntries(
      REVIEW_PROVIDER_CONFIGS.map(({ provider, modelEnv }) => [
        provider,
        env[modelEnv],
      ]),
    ),
  });
}

function main() {
  const { model, source } = resolveReviewModelFromEnv();
  writeOutput('model', model);
  writeOutput('source', source);
  console.log(`Resolved TeXRA review model ${model} from ${source}.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_REVIEW_MODEL_BY_PROVIDER,
  REVIEW_PROVIDER_CONFIGS,
  REVIEW_MODEL_PROVIDER_ORDER,
  resolveReviewModel,
  resolveReviewModelFromEnv,
};
