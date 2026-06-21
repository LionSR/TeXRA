import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  type ModelConfig,
} from 'llm-zoo';

import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerGoogleGenAI } from '@agent/modelHandlers/google/modelHandlerGoogleGenAI';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/openai/modelHandlerDeepSeek';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { ModelHandlerMiniMax } from '@agent/modelHandlers/openai/modelHandlerMiniMax';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlerCompatibilityKey,
  shouldUseResponsesAPI,
} from '@agent/runtime/ModelFactory';

function modelConfig(
  provider: ModelProvider,
  caps: Partial<ModelConfig['capabilities']> = {},
): ModelConfig {
  return {
    name: `test-${provider}`,
    label: `Test ${provider}`,
    fullName: `${provider}-test`,
    shortName: `${provider}-test`,
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    capabilities: { ...DEFAULT_MODEL_CAPABILITIES, ...caps },
    openRouterOnly: false,
  };
}

describe('OpenAI model handler routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes current GPT reasoning tool-use models to Responses by default', () => {
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt54, false)).toBe(true);
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt55, false)).toBe(true);
  });

  it('skips Responses routing when OpenRouter is the active proxy', () => {
    // OpenRouter proxies gpt-5* on /v1/chat/completions only — sending a
    // Responses-shaped payload would 404 / mis-route.
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt54, true)).toBe(false);
    expect(shouldUseResponsesAPI(MODEL_CONFIGS.gpt55, true)).toBe(false);
  });

  it('keeps OpenRouter-only models outside the Responses handler', () => {
    expect(
      shouldUseResponsesAPI(
        {
          ...MODEL_CONFIGS.gpt54,
          openRouterOnly: true,
        },
        false,
      ),
    ).toBe(false);
  });

  it('skips Responses routing when function calling is explicitly disabled', () => {
    expect(
      shouldUseResponsesAPI(
        {
          ...MODEL_CONFIGS.gpt54,
          capabilities: {
            ...MODEL_CONFIGS.gpt54.capabilities,
            supportsFunctionCalling: false,
          },
        },
        false,
      ),
    ).toBe(false);
  });

  it('exposes the same compatibility key for switchable response models', () => {
    expect(
      modelHandlerCompatibilityKey(MODEL_CONFIGS.gpt54, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
    expect(
      modelHandlerCompatibilityKey(MODEL_CONFIGS.gpt55, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
    expect(
      modelHandlerCompatibilityKey(MODEL_CONFIGS.sonnet46T, false, false),
    ).toBe('ModelHandlerAnthropic');
  });

  it('uses the OpenRouter compatibility key when models are proxied', () => {
    expect(modelHandlerCompatibilityKey(MODEL_CONFIGS.gpt54, true, false)).toBe(
      'ModelHandlerOpenRouterNative',
    );
    expect(
      modelHandlerCompatibilityKey(MODEL_CONFIGS.deepseekT, true, false),
    ).toBe('ModelHandlerOpenRouterNative');
  });

  it('uses short-name routing when computing compatibility keys', () => {
    expect(
      modelHandlerCompatibilityKey(
        {
          ...modelConfig(ModelProvider.OPENAI, {
            supportsFunctionCalling: true,
            supportsReasoningEffort: true,
          }),
          fullName: 'gpt-5-compatible-test',
          shortName: 'legacy-chat-test',
        },
        false,
        true,
      ),
    ).toBe('ModelHandlerOpenAI');
  });

  it('tags created handlers with a minifier-safe compatibility key', async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(createFakePlatform());

    const handler = await createModelHandler(MODEL_CONFIGS.gpt54);
    try {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    } finally {
      handler.dispose();
    }
  });

  const codexEligibleConfig: ModelConfig = {
    ...modelConfig(ModelProvider.OPENAI),
    name: 'gpt55-test',
    // Date-pinned fullName (as llm-zoo really ships) with the unpinned shortName
    // the Codex backend + eligibility key on. Guards the short-name matching.
    fullName: 'gpt-5.5-2026-04-23',
    shortName: 'gpt-5.5',
    requiresResponsesAPI: true,
  };

  it('keeps Codex-eligible subscription models on the Responses compatibility key', async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(
      createFakePlatform({
        config: { 'texra.chatgptCodex.preferSubscription': true },
      }),
    );

    expect(
      modelHandlerCompatibilityKey(codexEligibleConfig, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
    // The active OpenRouter proxy disables the subscription path entirely.
    expect(shouldUseResponsesAPI(codexEligibleConfig, true)).toBe(true);
  });

  it('keeps Codex-eligible models on the API-key Responses path when the switch is off', async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    // No switch set → defaults off.
    initPlatform(createFakePlatform());

    expect(
      modelHandlerCompatibilityKey(codexEligibleConfig, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
  });

  it('falls back to the API-key Responses handler when the subscription switch is on but signed out', async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(
      createFakePlatform({
        config: { 'texra.chatgptCodex.preferSubscription': true },
      }),
    );

    const handler = await createModelHandler(codexEligibleConfig);
    try {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    } finally {
      handler.dispose();
    }
  });

  it('uses the validation compatibility key only after the validation gate passes', async () => {
    const flagRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-validation-handler-'),
    );
    const flagPath = path.join(flagRoot, 'flag');
    await fs.writeFile(flagPath, 'texra-cli-run-validation\n');

    vi.stubEnv('TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL', '1');
    vi.stubEnv(
      'TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_ENV',
      'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER',
    );
    vi.stubEnv(
      'TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV',
      'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG',
    );
    vi.stubEnv(
      'TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_CONTENT',
      'texra-cli-run-validation',
    );
    vi.stubEnv('TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER', '1');
    vi.stubEnv('TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG', flagPath);
    vi.stubEnv('CI', '1');

    vi.resetModules();
    const passingFactory = await import('@agent/runtime/ModelFactory');
    expect(
      passingFactory.modelHandlerCompatibilityKey(
        MODEL_CONFIGS.gpt54,
        false,
        false,
      ),
    ).toBe('ModelHandlerValidation');

    vi.stubEnv('TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG', '');
    vi.resetModules();
    const failingFactory = await import('@agent/runtime/ModelFactory');
    expect(() =>
      failingFactory.modelHandlerCompatibilityKey(
        MODEL_CONFIGS.gpt54,
        false,
        false,
      ),
    ).toThrow(/restricted to package validation/);
  });
});

describe('OpenRouter-proxied provider capabilities', () => {
  // ModelFactory preserves config.provider when routing through OpenRouter
  // (new ModelHandlerOpenRouterNative({ ...config })). The capability getters
  // must therefore reflect the routed-through provider, not the handler class —
  // otherwise parallel-tool batching and DeepSeek reasoning-level overrides
  // silently stop applying on the global OpenRouter path. Regression guard.
  function openRouterHandler(
    provider: ModelProvider,
    caps: Partial<ModelConfig['capabilities']> = {},
  ): ModelHandlerOpenRouterNative {
    return new ModelHandlerOpenRouterNative({
      ...modelConfig(provider, caps),
      openRouterOnly: true,
    });
  }

  it('requires batched parallel tool results for proxied Google/DeepSeek/Kimi/MiniMax', () => {
    for (const provider of [
      ModelProvider.GOOGLE,
      ModelProvider.DEEPSEEK,
      ModelProvider.MOONSHOT,
      ModelProvider.MINIMAX,
    ]) {
      expect(
        openRouterHandler(provider).requiresBatchedParallelToolResults,
      ).toBe(true);
    }
  });

  it('does not batch for proxied providers that never carried cross-call reasoning', () => {
    expect(
      openRouterHandler(ModelProvider.OPENAI)
        .requiresBatchedParallelToolResults,
    ).toBe(false);
    expect(
      openRouterHandler(ModelProvider.OTHERS)
        .requiresBatchedParallelToolResults,
    ).toBe(false);
  });

  it('honors a reasoning-level override for proxied DeepSeek with reasoning but no granular effort', () => {
    const handler = openRouterHandler(ModelProvider.DEEPSEEK, {
      supportsReasoning: true,
      supportsReasoningEffort: false,
    });
    expect(handler.supportsReasoningLevelOverride).toBe(true);
  });

  it('does not grant a reasoning-level override to non-DeepSeek proxied providers lacking configurable effort', () => {
    const handler = openRouterHandler(ModelProvider.GOOGLE, {
      supportsReasoning: true,
      supportsReasoningEffort: false,
    });
    expect(handler.supportsReasoningLevelOverride).toBe(false);
  });
});

describe('direct handler capability overrides', () => {
  // Formal coverage of the per-handler `requiresBatchedParallelToolResults`
  // overrides that replaced the inline isGoogle/isDeepSeek/isKimi/isMiniMax gate.
  it('flags batching on the four reasoning-carrying providers and not on plain OpenAI', () => {
    expect(
      new ModelHandlerGoogleGenAI(modelConfig(ModelProvider.GOOGLE))
        .requiresBatchedParallelToolResults,
    ).toBe(true);
    expect(
      new ModelHandlerDeepSeek(modelConfig(ModelProvider.DEEPSEEK))
        .requiresBatchedParallelToolResults,
    ).toBe(true);
    expect(
      new ModelHandlerKimi(modelConfig(ModelProvider.MOONSHOT))
        .requiresBatchedParallelToolResults,
    ).toBe(true);
    expect(
      new ModelHandlerMiniMax(modelConfig(ModelProvider.MINIMAX))
        .requiresBatchedParallelToolResults,
    ).toBe(true);
    expect(
      new ModelHandlerOpenAI(modelConfig(ModelProvider.OPENAI))
        .requiresBatchedParallelToolResults,
    ).toBe(false);
  });

  it('grants a reasoning-level override to DeepSeek with reasoning but no granular effort', () => {
    expect(
      new ModelHandlerDeepSeek(
        modelConfig(ModelProvider.DEEPSEEK, {
          supportsReasoning: true,
          supportsReasoningEffort: false,
        }),
      ).supportsReasoningLevelOverride,
    ).toBe(true);
    expect(
      new ModelHandlerOpenAI(
        modelConfig(ModelProvider.OPENAI, {
          supportsReasoning: true,
          supportsReasoningEffort: false,
        }),
      ).supportsReasoningLevelOverride,
    ).toBe(false);
  });
});
