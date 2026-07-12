import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import { installPlatform } from '@test/support/setupPlatform';
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
  createModelHandlerForCompatibilityKey,
  modelHandlerCompatibilityKey,
  modelHandlersShareConversationFormat,
  shouldUseResponsesAPI,
} from '@agent/runtime/ModelFactory';
import {
  CODEX_BACKEND_BASE_URL,
  CODEX_SESSION_SECRET_KEY,
  CodexAuthError,
  codexCoordinator,
  resetCodexCoordinator,
  type CodexSession,
} from '@auth/codex';
import { shouldRouteModelThroughOpenRouter } from '@model/openRouterRouting';
import { AgentCategory } from '@shared/schemas/agent';
import type { FakePlatformOptions } from '@test/support/FakePlatform';

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

// installPlatform dynamically imports @platform/platform at call time, so
// this also re-resolves it after this file's vi.resetModules() calls,
// keeping it on the instance the factory reads.
function initFakePlatform(options?: FakePlatformOptions): Promise<void> {
  return installPlatform(options);
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

  it('routes switchable OpenAI models to Responses when the setting is unset', async () => {
    await initFakePlatform();

    expect(
      shouldUseResponsesAPI(modelConfig(ModelProvider.OPENAI), false),
    ).toBe(true);
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

  it('keeps gpt-oss models on Responses even when function calling metadata is disabled', () => {
    expect(
      shouldUseResponsesAPI(
        {
          ...modelConfig(ModelProvider.OPENAI, {
            supportsFunctionCalling: false,
          }),
          fullName: 'gpt-oss-120b',
        },
        false,
      ),
    ).toBe(true);
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

  it('uses short-name routing when computing compatibility keys', async () => {
    await initFakePlatform({
      config: { 'texra.model.useOpenAIResponsesAPI': false },
    });

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
    await initFakePlatform();

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
    ...modelConfig(ModelProvider.OPENAI, {
      reasoningEffort: ReasoningEffort.XHIGH,
    }),
    name: 'gpt55-test',
    // Date-pinned fullName (as llm-zoo really ships) with the unpinned shortName
    // the Codex backend keys on. Codex eligibility itself is derived from the
    // top reasoning-effort tier (see providerCapabilities.ts), independent of
    // this shortName/date-pin pair.
    fullName: 'gpt-5.5-2026-04-23',
    shortName: 'gpt-5.5',
    requiresResponsesAPI: true,
  };

  const signedInCodexSession = (): CodexSession => ({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAtMs: Date.now() + 10 * 60_000,
    accountId: 'account-id',
  });

  const initializePreferredCodexRelay = async (
    extraConfig: Record<string, unknown> = {},
  ): Promise<void> =>
    initFakePlatform({
      config: {
        'texra.chatgptCodex.preferSubscription': true,
        ...extraConfig,
      },
      globalState: { 'texra.useIncludedModelAccess': true },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(signedInCodexSession()),
      },
    });

  const createdHandlerName = async (
    agentCategory?: AgentCategory,
  ): Promise<string> => {
    const handler = await createModelHandler(
      codexEligibleConfig,
      agentCategory,
    );
    try {
      return handler.constructor.name;
    } finally {
      handler.dispose();
    }
  };

  it('keeps Codex-eligible subscription models on the Responses compatibility key', async () => {
    await initFakePlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    });

    expect(
      modelHandlerCompatibilityKey(codexEligibleConfig, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
    // The active OpenRouter proxy disables the subscription path entirely.
    expect(shouldUseResponsesAPI(codexEligibleConfig, true)).toBe(true);
  });

  it('keeps Codex-eligible models on the API-key Responses path when the switch is off', async () => {
    // The model requires Responses independently of the user-facing toggle.
    await initFakePlatform();

    expect(
      modelHandlerCompatibilityKey(codexEligibleConfig, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
  });

  it('falls back to the API-key Responses handler when the subscription switch is on but signed out', async () => {
    await initFakePlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    });

    const handler = await createModelHandler(codexEligibleConfig);
    try {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    } finally {
      handler.dispose();
    }
  });

  it('preserves the API fullName on Codex handler config even when shortName is absent', async () => {
    const codexSession = signedInCodexSession();
    await initFakePlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession),
      },
    });

    const handler = await createModelHandler({
      ...codexEligibleConfig,
      shortName: '',
    });
    try {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
      expect(handler.config.fullName).toBe('gpt-5.5-2026-04-23');
    } finally {
      handler.dispose();
    }
  });

  it('falls back when subscription re-authentication is required', async () => {
    await initializePreferredCodexRelay();
    const coordinator = codexCoordinator();
    vi.spyOn(coordinator, 'getFreshAccessToken').mockImplementation(
      async () => {
        await coordinator.signOut();
        throw new CodexAuthError('revoked', 'fatal', 401);
      },
    );

    expect(await createdHandlerName()).toBe('ModelHandlerOpenAIResponse');
  });

  it('propagates a superseded re-auth failure without falling back', async () => {
    await initializePreferredCodexRelay();
    const error = new CodexAuthError('session changed', 'expired');
    vi.spyOn(codexCoordinator(), 'getFreshAccessToken').mockRejectedValue(
      error,
    );

    await expect(createModelHandler(codexEligibleConfig)).rejects.toMatchObject(
      {
        name: 'AgentError',
        message: expect.stringContaining('Try again in a moment'),
        cause: { kind: 'transient' },
      },
    );
  });

  it('propagates session verification read failures without falling back', async () => {
    await initializePreferredCodexRelay();
    const coordinator = codexCoordinator();
    const readError = new Error('keychain unavailable');
    vi.spyOn(coordinator, 'getFreshAccessToken').mockRejectedValue(
      new CodexAuthError('session changed', 'expired'),
    );
    vi.spyOn(coordinator, 'loadSession').mockRejectedValue(readError);

    await expect(createModelHandler(codexEligibleConfig)).rejects.toMatchObject(
      {
        name: 'AgentError',
        cause: { kind: 'transient', cause: readError },
      },
    );
  });

  it('wraps raw token verification failures as transient auth errors', async () => {
    await initializePreferredCodexRelay();
    const rawError = new Error('keychain unavailable');
    vi.spyOn(codexCoordinator(), 'getFreshAccessToken').mockRejectedValue(
      rawError,
    );

    await expect(createModelHandler(codexEligibleConfig)).rejects.toMatchObject(
      {
        name: 'AgentError',
        cause: { name: 'CodexAuthError', kind: 'transient', cause: rawError },
      },
    );
  });

  it('skips subscription preflight for workflows when subscription is tool-use-only', async () => {
    await initializePreferredCodexRelay({
      'texra.chatgptCodex.subscriptionToolUseOnly': true,
    });
    const refreshSpy = vi
      .spyOn(codexCoordinator(), 'getFreshAccessToken')
      .mockRejectedValue(new CodexAuthError('temporary outage', 'transient'));

    expect(await createdHandlerName(AgentCategory.Workflow)).toBe(
      'ModelHandlerOpenAIResponse',
    );
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('uses the Codex endpoint for a signed-in preferred subscription even when relay access is selected', async () => {
    await initializePreferredCodexRelay();

    const handler = await createModelHandler(codexEligibleConfig);
    try {
      expect(handler.constructor.name).toBe('ModelHandlerCodex');
      expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    } finally {
      handler.dispose();
    }
  });

  it('treats Codex and relay Responses handlers with the shared key as compatible', async () => {
    await initializePreferredCodexRelay();
    const codex = await createModelHandler(codexEligibleConfig);
    await codexCoordinator().signOut();
    const relay = await createModelHandler(codexEligibleConfig);
    try {
      expect(codex.constructor).not.toBe(relay.constructor);
      expect(activeModelHandlerCompatibilityKey(codex)).toBe(
        activeModelHandlerCompatibilityKey(relay),
      );
      expect(modelHandlersShareConversationFormat(codex, relay)).toBe(true);
    } finally {
      codex.dispose();
      relay.dispose();
    }
  });

  it('does not let the Codex subscription override an explicit legacy OpenAI compatibility key', async () => {
    const codexSession = signedInCodexSession();
    await initFakePlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession),
      },
    });

    const handler = await createModelHandlerForCompatibilityKey(
      codexEligibleConfig,
      'ModelHandlerOpenAI',
    );
    try {
      expect(handler.constructor.name).toBe('ModelHandlerOpenAI');
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAI',
      );
    } finally {
      handler.dispose();
    }
  });

  it('keeps Responses-compatible resumes on the Codex endpoint when subscription access is preferred', async () => {
    const codexSession = signedInCodexSession();
    await initFakePlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
      globalState: {
        'texra.useIncludedModelAccess': true,
        'texra.useOpenRouter': true,
      },
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(codexSession),
      },
    });

    const handler = await createModelHandlerForCompatibilityKey(
      codexEligibleConfig,
      'ModelHandlerOpenAIResponse',
    );
    try {
      expect(handler.constructor.name).toBe('ModelHandlerCodex');
      expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
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

describe('Google Interactions API routing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const googleConfig = (): ModelConfig => modelConfig(ModelProvider.GOOGLE);

  // Re-import the factory alongside the platform it reads from. An earlier test
  // in this file calls vi.resetModules(), which would otherwise desync the
  // statically-imported factory from a freshly-imported @platform copy.
  async function initWithFlag(
    useInteractions?: boolean,
    useOpenRouter = false,
  ): Promise<typeof import('@agent/runtime/ModelFactory')> {
    await initFakePlatform({
      config:
        useInteractions === undefined
          ? {}
          : { 'texra.model.useGoogleInteractionsAPI': useInteractions },
      // getUseOpenRouter() reads USE_OPENROUTER from global state first.
      globalState: { 'texra.useOpenRouter': useOpenRouter },
    });
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

  it('routes Google to Interactions by default when the setting is unset', async () => {
    const factory = await initWithFlag();
    expect(factory.shouldUseGoogleInteractionsAPI(googleConfig(), false)).toBe(
      true,
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

  it('can explicitly rebuild the legacy Google GenAI handler for resumed sessions', async () => {
    const factory = await initWithFlag();
    const handler = await factory.createModelHandlerForCompatibilityKey(
      googleConfig(),
      'ModelHandlerGoogleGenAI',
    );
    try {
      expect(handler.constructor.name).toBe('ModelHandlerGoogleGenAI');
      expect(factory.activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerGoogleGenAI',
      );
    } finally {
      handler.dispose();
    }
  });

  it('keeps a direct compatibility handler off OpenRouter after the global toggle changes', async () => {
    const factory = await initWithFlag(true, /* useOpenRouter */ true);
    const handler = await factory.createModelHandlerForCompatibilityKey(
      googleConfig(),
      'ModelHandlerGoogleGenAI',
    );
    try {
      expect(handler.constructor.name).toBe('ModelHandlerGoogleGenAI');
      const routedConfig = (
        handler as unknown as {
          config: ModelConfig & { forceDirectProvider?: boolean };
        }
      ).config;
      expect(routedConfig.forceDirectProvider).toBe(true);
      expect(shouldRouteModelThroughOpenRouter(routedConfig, true)).toBe(false);
    } finally {
      handler.dispose();
    }
  });

  it('keeps an OpenRouter compatibility handler on OpenRouter after the global toggle changes', async () => {
    const factory = await initWithFlag(true, /* useOpenRouter */ false);
    const handler = await factory.createModelHandlerForCompatibilityKey(
      googleConfig(),
      'ModelHandlerOpenRouterNative',
    );
    try {
      expect(handler.constructor.name).toBe('ModelHandlerOpenRouterNative');
      const routedConfig = (handler as unknown as { config: ModelConfig })
        .config;
      expect(routedConfig.openRouterOnly).toBe(true);
      expect(shouldRouteModelThroughOpenRouter(routedConfig, false)).toBe(true);
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
  // `createModelHandler` dispatch. The two must never drift on the *key* they
  // produce — otherwise the key a restored session keys on could disagree with
  // the handler actually built. For every registered model the key tagged onto
  // the created handler must equal the predicted key, and a model with no
  // handler route (predicted `undefined`, e.g. Copilot) must make
  // `createModelHandler` reject rather than silently build a mismatched
  // handler. Default routing (no OpenRouter proxy) is the shared baseline both
  // paths observe. The Codex-subscription override in `createModelHandler` is
  // intentionally absent from the predicate, but it is key-neutral: a signed-in
  // run still tags `ModelHandlerCodex` with `ModelHandlerOpenAIResponse` (only
  // the class differs, not the key), so this signed-out sweep guards the key
  // invariant for both states.
  it('tags every registered model with its predicted compatibility key', async () => {
    // Re-import the factory alongside a freshly-initialized platform. An
    // earlier test in this file calls vi.resetModules(), which would otherwise
    // desync the statically-imported factory from the platform it reads; this
    // also makes the block robust to isolated `--grep` runs rather than
    // free-riding on a prior test's initPlatform.
    await initFakePlatform();
    const {
      modelHandlerCompatibilityKey: compatKey,
      createModelHandler: create,
      activeModelHandlerCompatibilityKey: activeKey,
    } = await import('@agent/runtime/ModelFactory');

    const mismatches: string[] = [];
    for (const [name, config] of Object.entries(MODEL_CONFIGS)) {
      const predicted = compatKey(config);
      if (predicted === undefined) {
        await expect(
          create(config),
          `${name}: no handler route, createModelHandler should reject`,
        ).rejects.toThrow();
        continue;
      }
      const handler = await create(config);
      try {
        const actual = activeKey(handler);
        if (actual !== predicted) {
          mismatches.push(`${name}: predicted ${predicted}, got ${actual}`);
        }
      } finally {
        handler.dispose();
      }
    }
    expect(mismatches).toEqual([]);
  });
});
