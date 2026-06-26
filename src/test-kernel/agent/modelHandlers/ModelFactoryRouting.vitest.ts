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
import { ModelHandlerGLM } from '@agent/modelHandlers/openai/modelHandlerGLM';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  modelHandlerCompatibilityKey,
  shouldUseResponsesAPI,
} from '@agent/runtime/ModelFactory';
import {
  CODEX_SESSION_SECRET_KEY,
  resetCodexCoordinator,
  type CodexSession,
} from '@auth/codex';

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
    resetCodexCoordinator();
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

  it('uses an unpinned Codex model id even when shortName is absent', async () => {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    const codexSession: CodexSession = {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAtMs: Date.now() + 60_000,
      accountId: 'account-id',
    };
    initPlatform(
      createFakePlatform({
        config: { 'texra.chatgptCodex.preferSubscription': true },
        secrets: {
          [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession),
        },
      }),
    );

    const handler = await createModelHandler({
      ...codexEligibleConfig,
      shortName: '',
    });
    try {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
      expect(handler.config.fullName).toBe('gpt-5.5');
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

describe('Google Interactions API routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const googleConfig = (): ModelConfig => modelConfig(ModelProvider.GOOGLE);

  // Re-import the factory alongside the platform it reads from. An earlier test
  // in this file calls vi.resetModules(), which would otherwise desync the
  // statically-imported factory from a freshly-imported @platform copy.
  async function initWithFlag(
    useInteractions: boolean,
    useOpenRouter = false,
  ): Promise<typeof import('@agent/runtime/ModelFactory')> {
    const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
    ]);
    initPlatform(
      createFakePlatform({
        config: { 'texra.model.useGoogleInteractionsAPI': useInteractions },
        // getUseOpenRouter() reads USE_OPENROUTER from global state first.
        globalState: { 'texra.useOpenRouter': useOpenRouter },
      }),
    );
    return import('@agent/runtime/ModelFactory');
  }

  it('routes Google to Interactions only when the flag is on', async () => {
    let factory = await initWithFlag(true);
    expect(factory.shouldUseGoogleInteractionsAPI(googleConfig(), false)).toBe(
      true,
    );

    factory = await initWithFlag(false);
    expect(factory.shouldUseGoogleInteractionsAPI(googleConfig(), false)).toBe(
      false,
    );
  });

  it('forces the Interactions handler for requiresInteractionsAPI models even with the flag off', async () => {
    const factory = await initWithFlag(false);
    const forced = {
      ...googleConfig(),
      requiresInteractionsAPI: true,
    } as ModelConfig;
    expect(factory.shouldUseGoogleInteractionsAPI(forced, false)).toBe(true);
  });

  it('never routes a flag-enabled (non-required) Google model to Interactions via OpenRouter', async () => {
    const factory = await initWithFlag(true);
    expect(factory.shouldUseGoogleInteractionsAPI(googleConfig(), true)).toBe(
      false,
    );
  });

  it('keeps the routing predicate + key derivation pure (no throw) for Interactions-only under OpenRouter', async () => {
    const factory = await initWithFlag(true);
    const forced = {
      ...googleConfig(),
      requiresInteractionsAPI: true,
    } as ModelConfig;
    // The predicate must not throw — key-derivation callers (history restore,
    // modelSwitchDisabledReason) rely on string|undefined, never an exception.
    expect(factory.shouldUseGoogleInteractionsAPI(forced, true)).toBe(false);
    expect(factory.modelHandlerCompatibilityKey(forced, true, false)).toBe(
      'ModelHandlerOpenRouterNative',
    );
  });

  it('createModelHandler fails loudly for an Interactions-only model under active OpenRouter', async () => {
    // OpenRouter cannot proxy Interactions — the live-routing path must error
    // rather than silently route to OpenRouter (spec §6.3).
    const factory = await initWithFlag(true, /* useOpenRouter */ true);
    const forced = {
      ...googleConfig(),
      requiresInteractionsAPI: true,
    } as ModelConfig;
    await expect(factory.createModelHandler(forced)).rejects.toThrow(
      /OpenRouter/,
    );
  });

  it('exposes the Interactions compatibility key for history-restore parity', async () => {
    let factory = await initWithFlag(true);
    expect(
      factory.modelHandlerCompatibilityKey(googleConfig(), false, false),
    ).toBe('ModelHandlerGoogleInteractions');

    factory = await initWithFlag(false);
    expect(
      factory.modelHandlerCompatibilityKey(googleConfig(), false, false),
    ).toBe('ModelHandlerGoogleGenAI');
  });

  it('creates the Interactions handler tagged with its compatibility key', async () => {
    const factory = await initWithFlag(true);
    const handler = await factory.createModelHandler(googleConfig());
    try {
      expect(factory.activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerGoogleInteractions',
      );
    } finally {
      handler.dispose();
    }
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
  // Formal coverage of `requiresBatchedParallelToolResults` behavior that
  // replaced the inline isGoogle/isDeepSeek/isKimi/isMiniMax gate.
  it('flags batching on reasoning-carrying providers except GLM', () => {
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
      new ModelHandlerGLM(modelConfig(ModelProvider.GLM))
        .requiresBatchedParallelToolResults,
    ).toBe(false);
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

describe('routing precedence: compat-key ↔ createModelHandler invariant', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetCodexCoordinator();
  });

  // The handler-routing precedence is encoded twice: once in the pure
  // `modelHandlerCompatibilityKey` predicate (used exception-free by
  // history-restore and model-switch gating) and once in the live
  // `createModelHandler` dispatch. The two must never drift — otherwise the
  // key a restored session keys on could disagree with the handler actually
  // built. For every registered model the key tagged onto the created handler
  // must equal the predicted key, and a model with no handler route (predicted
  // `undefined`, e.g. Copilot) must make `createModelHandler` reject rather
  // than silently build a mismatched handler. Default routing (no OpenRouter
  // proxy, signed out) is the shared baseline both paths observe, so they are
  // compared under identical inputs.
  it('tags every registered model with its predicted compatibility key', async () => {
    const mismatches: string[] = [];
    for (const [name, config] of Object.entries(MODEL_CONFIGS)) {
      const predicted = modelHandlerCompatibilityKey(config);
      if (predicted === undefined) {
        await expect(
          createModelHandler(config),
          `${name}: no handler route, createModelHandler should reject`,
        ).rejects.toThrow();
        continue;
      }
      const actual = activeModelHandlerCompatibilityKey(
        await createModelHandler(config),
      );
      if (actual !== predicted) {
        mismatches.push(`${name}: predicted ${predicted}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
