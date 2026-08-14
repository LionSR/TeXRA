import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import { ModelHandlerOpenRouterNative } from '@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative';
import { ModelHandlerOpenAI } from '@agent/modelHandlers/openai/modelHandlerOpenAI';
import { ModelHandlerGoogleInteractions } from '@agent/modelHandlers/google/modelHandlerGoogleInteractions';
import { ModelHandlerDeepSeek } from '@agent/modelHandlers/openai/modelHandlerDeepSeek';
import { ModelHandlerKimi } from '@agent/modelHandlers/openai/modelHandlerKimi';
import { ModelHandlerMiniMax } from '@agent/modelHandlers/openai/modelHandlerMiniMax';
import { ModelHandlerGLM } from '@agent/modelHandlers/openai/modelHandlerGLM';
import {
  activeModelHandlerCompatibilityKey,
  createModelHandler,
  createModelHandlerForCompatibilityKey,
  resolveModelHandlerCompatibilityKey,
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
import {
  invalidateRuntimeModelRegistry,
  refreshRuntimeModelRegistry,
} from '@model/runtimeModelRegistry';
import {
  LANGUAGE_MODEL_PORT_ERROR_CODE,
  type LanguageModelPort,
} from '@platform/languageModel';
import { installPlatform } from '@test/support/setupPlatform';
import { buildTestModelConfig } from '@test/support/modelConfigTestUtils';

// This file calls vi.resetModules(), which desyncs the statically-imported
// factory from a freshly-imported @platform copy. Blocks that must agree with
// the platform therefore re-import '@agent/runtime/ModelFactory' right after
// installPlatform, which itself dynamically imports @platform/platform at call
// time and so always lands on the instance the re-imported factory reads.

function modelConfig(
  provider: ModelProvider,
  caps: Partial<ModelConfig['capabilities']> = {},
): ModelConfig {
  return buildTestModelConfig({
    name: `test-${provider}`,
    label: `Test ${provider}`,
    fullName: `${provider}-test`,
    shortName: `${provider}-test`,
    provider,
    maxOutputTokens: 1024,
    inputPrice: 0,
    outputPrice: 0,
    contextWindow: 128000,
    capabilities: caps,
    openRouterOnly: false,
  });
}

const AVAILABLE_LANGUAGE_MODEL_PORT: LanguageModelPort = {
  isAvailable: () => true,
  selectModels: async () => [],
  onDidChangeModels: () => ({ dispose() {} }),
  sendRequest: () => (async function* () {})(),
  countTokens: async () => 0,
  onDidChangeAccess: () => ({ dispose() {} }),
};

/** Run `inspect` against a created handler, always disposing it afterwards. */
async function inspectHandler<T>(
  handlerPromise: Promise<ModelHandler>,
  inspect: (handler: ModelHandler) => T,
): Promise<T> {
  const handler = await handlerPromise;
  try {
    return inspect(handler);
  } finally {
    handler.dispose();
  }
}

describe('Copilot model handler routing', () => {
  const copilotConfig = modelConfig(ModelProvider.COPILOT, {
    supportsFunctionCalling: true,
  });

  it('takes precedence over the global OpenRouter route', () => {
    expect(
      resolveModelHandlerCompatibilityKey(copilotConfig, true, false),
    ).toBe('ModelHandlerVscodeLm');
  });

  it('fails clearly when the host language-model port is unavailable', async () => {
    await installPlatform();

    await expect(createModelHandler(copilotConfig)).rejects.toMatchObject({
      name: 'LanguageModelPortError',
      code: LANGUAGE_MODEL_PORT_ERROR_CODE.HOST_UNAVAILABLE,
    });
  });

  it('constructs the VS Code handler even when OpenRouter is enabled', async () => {
    await installPlatform(
      { globalState: { 'texra.useOpenRouter': true } },
      { languageModel: AVAILABLE_LANGUAGE_MODEL_PORT },
    );

    await inspectHandler(createModelHandler(copilotConfig), (handler) => {
      expect(handler.constructor.name).toBe('ModelHandlerVscodeLm');
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerVscodeLm',
      );
    });
  });
});

describe('Copilot route preference on a canonical base model', () => {
  // The discovered-editor-model fixture must track an llm-zoo base model that
  // is active (neither deprecated nor retired) and Copilot-documented (carries
  // `copilotFullName`): route resolution filters deprecated/retired configs and
  // matches the editor id against the registry's Copilot name. gemini36f
  // satisfies both in llm-zoo 1.25.0 (the sonnet46 pin deprecated there).
  const GEMINI_FLASH_DISCOVERY = {
    id: 'gemini-3.6-flash',
    name: 'Gemini 3.6 Flash',
    family: 'gemini-3.6-flash',
    vendor: 'copilot',
    version: '2026-07',
    maxInputTokens: 160_000,
    access: 'allowed' as const,
  };

  async function installCopilotRoute(
    globalState: Record<string, unknown> = {},
  ): Promise<void> {
    invalidateRuntimeModelRegistry();
    await installPlatform(
      { globalState },
      {
        languageModel: {
          ...AVAILABLE_LANGUAGE_MODEL_PORT,
          selectModels: async () => [GEMINI_FLASH_DISCOVERY],
        },
      },
    );
    await refreshRuntimeModelRegistry();
  }

  afterEach(() => {
    invalidateRuntimeModelRegistry();
  });

  it('routes the base model through Copilot when the preference and access align', async () => {
    await installCopilotRoute({
      'texra.copilotRouteModels': ['gemini36f'],
      'texra.useOpenRouter': true,
    });

    const config = MODEL_CONFIGS.gemini36f;
    expect(resolveModelHandlerCompatibilityKey(config, true, false)).toBe(
      'ModelHandlerVscodeLm',
    );

    await inspectHandler(createModelHandler(config), (handler) => {
      expect(handler.constructor.name).toBe('ModelHandlerVscodeLm');
      expect(handler.config.name).toBe('gemini36f');
    });
  });

  it('keeps the ordinary provider route without the preference', async () => {
    await installCopilotRoute();

    expect(
      resolveModelHandlerCompatibilityKey(MODEL_CONFIGS.gemini36f, false),
    ).toBe('ModelHandlerGoogleInteractions');
  });

  it('scopes a direct retry override without changing concurrent route selection', async () => {
    await installCopilotRoute({
      'texra.copilotRouteModels': ['gemini36f'],
    });

    const config = MODEL_CONFIGS.gemini36f;
    expect(
      resolveModelHandlerCompatibilityKey(config, false, false, 'direct'),
    ).toBe('ModelHandlerGoogleInteractions');
    expect(resolveModelHandlerCompatibilityKey(config, false, false)).toBe(
      'ModelHandlerVscodeLm',
    );

    const directHandler = await createModelHandler(config, undefined, 'direct');
    const concurrentHandler = await createModelHandler(config);
    try {
      expect(directHandler.constructor.name).toBe(
        'ModelHandlerGoogleInteractions',
      );
      expect(concurrentHandler.constructor.name).toBe('ModelHandlerVscodeLm');
    } finally {
      directHandler.dispose();
      concurrentHandler.dispose();
    }
  });

  it('rejects a preferred route the editor cannot serve instead of falling through', async () => {
    invalidateRuntimeModelRegistry();
    await installPlatform(
      { globalState: { 'texra.copilotRouteModels': ['gemini36f'] } },
      {
        languageModel: {
          ...AVAILABLE_LANGUAGE_MODEL_PORT,
          selectModels: async () => [
            { ...GEMINI_FLASH_DISCOVERY, access: 'consent-required' as const },
          ],
        },
      },
    );
    await refreshRuntimeModelRegistry();

    // A Copilot preference is a hard route choice (#9635): consent-required
    // must surface as a named failure, never a silent direct-key dispatch.
    expect(() =>
      resolveModelHandlerCompatibilityKey(MODEL_CONFIGS.gemini36f, false),
    ).toThrowError(/needs your approval/);
    await expect(
      createModelHandler(MODEL_CONFIGS.gemini36f),
    ).rejects.toThrowError(/needs your approval/);
  });

  it('reports an undiscovered preferred route as unavailable', async () => {
    await installCopilotRoute({
      'texra.copilotRouteModels': ['gpt55'],
    });

    expect(() =>
      resolveModelHandlerCompatibilityKey(MODEL_CONFIGS.gpt55, false),
    ).toThrowError(/does not currently offer "gpt55"/);
  });

  it('applies the discovered context ceiling and zero-cost subscription overrides', async () => {
    await installCopilotRoute({
      'texra.copilotRouteModels': ['gemini36f'],
      'texra.reasoningLevels': { gemini36f: 'low' },
    });

    await inspectHandler(
      createModelHandler(MODEL_CONFIGS.gemini36f),
      (handler) => {
        expect(handler.config.contextWindow).toBe(160_000);
        expect(handler.config.inputPrice).toBe(0);
        expect(handler.config.outputPrice).toBe(0);
        expect(handler.config.capabilities.supportsReasoningEffort).toBe(false);
        expect(handler.supportsReasoningLevelOverride).toBe(false);
        // The persisted override is intentionally ignored because VS Code's LM
        // request surface has no reasoning-effort parameter.
        expect(handler.config.capabilities.reasoningEffort).toBe(
          MODEL_CONFIGS.gemini36f.capabilities.reasoningEffort,
        );
      },
    );
  });

  it('keeps the Copilot route ahead of the Codex subscription override', async () => {
    // A Copilot-preferred OpenAI model with a routable ChatGPT session must
    // still dispatch through Copilot — the picker says "Via Copilot", so the
    // async Codex override may not win dispatch (#9635).
    const GPT_56_DISCOVERY = {
      id: 'gpt-5.6',
      name: 'GPT-5.6',
      family: 'gpt-5.6',
      vendor: 'copilot',
      version: '2026-07',
      maxInputTokens: 128_000,
      access: 'allowed' as const,
    };
    invalidateRuntimeModelRegistry();
    await installPlatform(
      {
        config: { 'texra.chatgptCodex.preferSubscription': true },
        globalState: { 'texra.copilotRouteModels': ['gpt56'] },
        secrets: {
          [CODEX_SESSION_SECRET_KEY]: JSON.stringify({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            expiresAtMs: Date.now() + 10 * 60_000,
            accountId: 'account-id',
          }),
        },
      },
      {
        languageModel: {
          ...AVAILABLE_LANGUAGE_MODEL_PORT,
          selectModels: async () => [GPT_56_DISCOVERY],
        },
      },
    );
    await refreshRuntimeModelRegistry();

    await inspectHandler(createModelHandler(MODEL_CONFIGS.gpt56), (handler) => {
      expect(handler.constructor.name).toBe('ModelHandlerVscodeLm');
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerVscodeLm',
      );
    });
  });

  it('rebuilds the VS Code handler for a persisted canonical session', async () => {
    await installCopilotRoute();

    await inspectHandler(
      createModelHandlerForCompatibilityKey(
        MODEL_CONFIGS.gemini36f,
        'ModelHandlerVscodeLm',
      ),
      (handler) => {
        expect(handler.constructor.name).toBe('ModelHandlerVscodeLm');
        expect(activeModelHandlerCompatibilityKey(handler)).toBe(
          'ModelHandlerVscodeLm',
        );
      },
    );
  });
});

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
    await installPlatform();

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

  it.each<{
    model: keyof typeof MODEL_CONFIGS;
    useOpenRouter: boolean;
    expected: string;
  }>([
    {
      model: 'gpt54',
      useOpenRouter: false,
      expected: 'ModelHandlerOpenAIResponse',
    },
    {
      model: 'gpt55',
      useOpenRouter: false,
      expected: 'ModelHandlerOpenAIResponse',
    },
    {
      model: 'sonnet5T',
      useOpenRouter: false,
      expected: 'ModelHandlerAnthropic',
    },
    {
      model: 'gpt54',
      useOpenRouter: true,
      expected: 'ModelHandlerOpenRouterNative',
    },
    {
      model: 'deepseekT',
      useOpenRouter: true,
      expected: 'ModelHandlerOpenRouterNative',
    },
    {
      model: 'musespark11',
      useOpenRouter: false,
      expected: 'ModelHandlerMeta',
    },
    {
      model: 'musespark11',
      useOpenRouter: true,
      expected: 'ModelHandlerOpenRouterNative',
    },
  ])(
    'computes the $expected compatibility key for $model (openRouter=$useOpenRouter)',
    ({ model, useOpenRouter, expected }) => {
      // Meta Muse Spark routes to the Meta handler directly and to OpenRouter
      // when proxied; OpenRouter-proxied models always key on the native
      // OpenRouter handler.
      expect(
        resolveModelHandlerCompatibilityKey(
          MODEL_CONFIGS[model],
          useOpenRouter,
          false,
        ),
      ).toBe(expected);
    },
  );

  it('uses short-name routing when computing compatibility keys', async () => {
    await installPlatform({
      config: { 'texra.model.useOpenAIResponsesAPI': false },
    });

    expect(
      resolveModelHandlerCompatibilityKey(
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

  it('preserves the GPT-5.6 Pro wire id when short names are preferred', async () => {
    await installPlatform({
      globalState: { 'texra.preferShortModelNames': true },
    });

    await inspectHandler(
      createModelHandler(MODEL_CONFIGS.gpt56pro),
      (handler) => {
        expect(handler.config.fullName).toBe('gpt-5.6-sol');
        expect(handler.capabilities.reasoningMode).toBe('pro');
      },
    );
  });

  it('rejects GPT-5.6 Pro when OpenRouter routing is enabled', async () => {
    await installPlatform({
      globalState: { 'texra.useOpenRouter': true },
    });

    await expect(createModelHandler(MODEL_CONFIGS.gpt56pro)).rejects.toThrow(
      /reasoning mode pro, which OpenRouter does not support/,
    );
  });

  it('tags created handlers with a minifier-safe compatibility key', async () => {
    await installPlatform();

    await inspectHandler(createModelHandler(MODEL_CONFIGS.gpt54), (handler) => {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    });
  });

  const codexEligibleConfig: ModelConfig = {
    ...modelConfig(ModelProvider.OPENAI, {
      reasoningEffort: ReasoningEffort.XHIGH,
    }),
    name: 'gpt55-test',
    // Date-pinned fullName (as llm-zoo really ships) with the unpinned shortName
    // the Codex backend keys on. Codex eligibility comes from the registry's
    // codexSubscription flag (see providerCapabilities.ts), independent of
    // this shortName/date-pin pair.
    fullName: 'gpt-5.5-2026-04-23',
    shortName: 'gpt-5.5',
    requiresResponsesAPI: true,
    codexSubscription: true,
  };

  function signedInCodexSession(): CodexSession {
    return {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAtMs: Date.now() + 10 * 60_000,
      accountId: 'account-id',
    };
  }

  async function installSignedInCodexPlatform(
    globalState: Record<string, unknown> = {},
  ): Promise<void> {
    await installPlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
      globalState,
      secrets: {
        [CODEX_SESSION_SECRET_KEY]: JSON.stringify(signedInCodexSession()),
      },
    });
  }

  it('keeps Codex-eligible subscription models on the Responses compatibility key', async () => {
    await installPlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    });

    expect(
      resolveModelHandlerCompatibilityKey(codexEligibleConfig, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
    // The active OpenRouter proxy disables the subscription path entirely.
    expect(shouldUseResponsesAPI(codexEligibleConfig, true)).toBe(true);
  });

  it('keeps Codex-eligible models on the API-key Responses path when the switch is off', async () => {
    // The model requires Responses independently of the user-facing toggle.
    await installPlatform();

    expect(
      resolveModelHandlerCompatibilityKey(codexEligibleConfig, false, false),
    ).toBe('ModelHandlerOpenAIResponse');
  });

  it('falls back to the API-key Responses handler when the subscription switch is on but signed out', async () => {
    await installPlatform({
      config: { 'texra.chatgptCodex.preferSubscription': true },
    });

    await inspectHandler(createModelHandler(codexEligibleConfig), (handler) => {
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    });
  });

  it('preserves the API fullName on Codex handler config even when shortName is absent', async () => {
    await installSignedInCodexPlatform();

    await inspectHandler(
      createModelHandler({
        ...codexEligibleConfig,
        shortName: '',
      }),
      (handler) => {
        expect(activeModelHandlerCompatibilityKey(handler)).toBe(
          'ModelHandlerOpenAIResponse',
        );
        expect(handler.config.fullName).toBe('gpt-5.5-2026-04-23');
      },
    );
  });

  it('falls back when subscription re-authentication is required', async () => {
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
    });
    const coordinator = codexCoordinator();
    vi.spyOn(coordinator, 'getFreshAccessToken').mockImplementation(
      async () => {
        await coordinator.signOut();
        throw new CodexAuthError('revoked', 'fatal', 401);
      },
    );

    const handlerName = await inspectHandler(
      createModelHandler(codexEligibleConfig),
      (handler) => handler.constructor.name,
    );
    expect(handlerName).toBe('ModelHandlerOpenAIResponse');
  });

  it('propagates a superseded re-auth failure without falling back', async () => {
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
    });
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
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
    });
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
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
    });
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

  it('uses the Codex endpoint for a signed-in preferred subscription even when relay access is selected', async () => {
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
    });

    await inspectHandler(createModelHandler(codexEligibleConfig), (handler) => {
      expect(handler.constructor.name).toBe('ModelHandlerCodex');
      expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
      expect(activeModelHandlerCompatibilityKey(handler)).toBe(
        'ModelHandlerOpenAIResponse',
      );
    });
  });

  it('treats Codex and relay Responses handlers with the shared key as compatible', async () => {
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
    });
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
    await installSignedInCodexPlatform();

    await inspectHandler(
      createModelHandlerForCompatibilityKey(
        codexEligibleConfig,
        'ModelHandlerOpenAI',
      ),
      (handler) => {
        expect(handler.constructor.name).toBe('ModelHandlerOpenAI');
        expect(activeModelHandlerCompatibilityKey(handler)).toBe(
          'ModelHandlerOpenAI',
        );
      },
    );
  });

  it('keeps Responses-compatible resumes on the Codex endpoint when subscription access is preferred', async () => {
    await installSignedInCodexPlatform({
      'texra.useIncludedModelAccess': true,
      'texra.useOpenRouter': true,
    });

    await inspectHandler(
      createModelHandlerForCompatibilityKey(
        codexEligibleConfig,
        'ModelHandlerOpenAIResponse',
      ),
      (handler) => {
        expect(handler.constructor.name).toBe('ModelHandlerCodex');
        expect(handler.getBaseUrl()).toBe(CODEX_BACKEND_BASE_URL);
        expect(activeModelHandlerCompatibilityKey(handler)).toBe(
          'ModelHandlerOpenAIResponse',
        );
      },
    );
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
    await installPlatform({
      globalState: { 'texra.useOpenRouter': true },
    });
    const passingFactory = await import('@agent/runtime/ModelFactory');
    expect(
      passingFactory.resolveModelHandlerCompatibilityKey(
        MODEL_CONFIGS.gpt54,
        false,
        false,
      ),
    ).toBe('ModelHandlerValidation');

    const validationHandler = passingFactory.createModelHandler({
      ...modelConfig(ModelProvider.GOOGLE),
      requiresInteractionsAPI: true,
    } as ModelConfig);
    await inspectHandler(validationHandler, (handler) => {
      expect(handler.constructor.name).toBe('ModelHandlerValidation');
    });

    vi.stubEnv('TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG', '');
    vi.resetModules();
    const failingFactory = await import('@agent/runtime/ModelFactory');
    expect(() =>
      failingFactory.resolveModelHandlerCompatibilityKey(
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

  function googleConfig(): ModelConfig {
    return modelConfig(ModelProvider.GOOGLE);
  }

  // Re-imports the factory alongside the platform it reads from (see the
  // module-header note on this file's vi.resetModules() calls).
  async function initGoogleRouting(
    useOpenRouter = false,
  ): Promise<typeof import('@agent/runtime/ModelFactory')> {
    await installPlatform({
      // getUseOpenRouter() reads USE_OPENROUTER from global state first.
      globalState: { 'texra.useOpenRouter': useOpenRouter },
    });
    return import('@agent/runtime/ModelFactory');
  }

  it('routes direct Google models to Interactions', async () => {
    const factory = await initGoogleRouting();
    expect(
      factory.resolveModelHandlerCompatibilityKey(googleConfig(), false, false),
    ).toBe('ModelHandlerGoogleInteractions');
  });

  it('creates the Interactions handler tagged with its compatibility key', async () => {
    const factory = await initGoogleRouting();
    await inspectHandler(factory.createModelHandler(googleConfig()), (h) => {
      expect(factory.activeModelHandlerCompatibilityKey(h)).toBe(
        'ModelHandlerGoogleInteractions',
      );
    });
  });

  it('keeps a direct Interactions session off OpenRouter after the global toggle changes', async () => {
    const factory = await initGoogleRouting(true);
    await inspectHandler(
      factory.createModelHandlerForCompatibilityKey(
        googleConfig(),
        'ModelHandlerGoogleInteractions',
      ),
      (handler) => {
        expect(handler.constructor.name).toBe('ModelHandlerGoogleInteractions');
        const routedConfig = (
          handler as unknown as {
            config: ModelConfig & { forceDirectProvider?: boolean };
          }
        ).config;
        expect(routedConfig.forceDirectProvider).toBe(true);
        expect(shouldRouteModelThroughOpenRouter(routedConfig, true)).toBe(
          false,
        );
      },
    );
  });

  it('keeps an OpenRouter compatibility handler on OpenRouter after the global toggle changes', async () => {
    const factory = await initGoogleRouting(false);
    await inspectHandler(
      factory.createModelHandlerForCompatibilityKey(
        googleConfig(),
        'ModelHandlerOpenRouterNative',
      ),
      (handler) => {
        expect(handler.constructor.name).toBe('ModelHandlerOpenRouterNative');
        const routedConfig = (handler as unknown as { config: ModelConfig })
          .config;
        expect(routedConfig.openRouterOnly).toBe(true);
        expect(shouldRouteModelThroughOpenRouter(routedConfig, false)).toBe(
          true,
        );
      },
    );
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

  it('requires batched parallel tool results for proxied Anthropic/Google/DeepSeek/Kimi/MiniMax', () => {
    for (const provider of [
      ModelProvider.ANTHROPIC,
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
    for (const provider of [ModelProvider.OPENAI, ModelProvider.OTHERS]) {
      expect(
        openRouterHandler(provider).requiresBatchedParallelToolResults,
      ).toBe(false);
    }
  });

  it.each([
    { provider: ModelProvider.DEEPSEEK, expected: true },
    { provider: ModelProvider.GOOGLE, expected: false },
  ])(
    'grants a reasoning-level override only to proxied DeepSeek with reasoning but no granular effort ($provider → $expected)',
    ({ provider, expected }) => {
      const handler = openRouterHandler(provider, {
        supportsReasoning: true,
        supportsReasoningEffort: false,
      });
      expect(handler.supportsReasoningLevelOverride).toBe(expected);
    },
  );
});

describe('direct handler capability overrides', () => {
  // Formal coverage of `requiresBatchedParallelToolResults` behavior that
  // replaced the inline isGoogle/isDeepSeek/isKimi/isMiniMax gate.
  it('flags batching on reasoning-carrying providers except GLM', () => {
    expect(
      new ModelHandlerGoogleInteractions(modelConfig(ModelProvider.GOOGLE))
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
  // `resolveModelHandlerCompatibilityKey` predicate (used exception-free by
  // history-restore and model-switch gating) and once in the live
  // `createModelHandler` dispatch. The two must never drift on the *key* they
  // produce — otherwise the key a restored session keys on could disagree with
  // the handler actually built. For every registered model the key tagged onto
  // the created handler must equal the predicted key, and a model with no
  // handler route (predicted `undefined`) must make
  // `createModelHandler` reject rather than silently build a mismatched
  // handler. Default routing (no OpenRouter proxy) is the shared baseline both
  // paths observe. The Codex-subscription override in `createModelHandler` is
  // intentionally absent from the predicate, but it is key-neutral: a signed-in
  // run still tags `ModelHandlerCodex` with `ModelHandlerOpenAIResponse` (only
  // the class differs, not the key), so this signed-out sweep guards the key
  // invariant for both states.
  it('tags every registered model with its predicted compatibility key', async () => {
    // Re-import the factory alongside a freshly-initialized platform (see the
    // module-header note). Initializing here also keeps the block correct
    // under an isolated `--grep` run rather than free-riding on a prior
    // test's initPlatform.
    await installPlatform({}, { languageModel: AVAILABLE_LANGUAGE_MODEL_PORT });
    const {
      resolveModelHandlerCompatibilityKey: compatKey,
      createModelHandler: create,
      activeModelHandlerCompatibilityKey: activeKey,
    } = await import('@agent/runtime/ModelFactory');
    // Stub the relay service on the same fresh module instance the re-imported
    // factory reads.
    const { setServerSideKeyService: setService } =
      await import('@auth/serverKeys');
    setService({
      getUseIncludedModelAccess: () => false,
      canUseServerSideKeys: async () => false,
    } as never);
    const { installTexraModelAccess } =
      await import('@controllers/modelAccess/installTexraModelAccess');
    installTexraModelAccess();

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
      const actual = await inspectHandler(create(config), (handler) =>
        activeKey(handler),
      );
      if (actual !== predicted) {
        mismatches.push(`${name}: predicted ${predicted}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe('Kimi Code reroute under included access', () => {
  const dualBackendKimi = {
    ...modelConfig(ModelProvider.MOONSHOT),
    kimiSubscription: true,
  } as ModelConfig;

  async function createKimiHandler(options: {
    readonly includedAccess: boolean;
  }): Promise<ModelConfig> {
    // Re-import alongside a freshly-initialized platform (see the
    // module-header note).
    await installPlatform({
      globalState: { 'texra.kimiCode.prefer': true },
      secrets: { 'apiKey.kimiCode': 'test-kimi-code-key' },
    });
    const { createModelHandler: create } =
      await import('@agent/runtime/ModelFactory');
    const { setServerSideKeyService: setService } =
      await import('@auth/serverKeys');
    const { invalidateApiKeyCache } = await import('@model/apiProviders');
    setService({
      getUseIncludedModelAccess: () => options.includedAccess,
      canUseServerSideKeys: async () => options.includedAccess,
    } as never);
    const { installTexraModelAccess } =
      await import('@controllers/modelAccess/installTexraModelAccess');
    installTexraModelAccess();
    invalidateApiKeyCache();

    return inspectHandler(create(dualBackendKimi), (handler) => handler.config);
  }

  it('does not reroute dual-backend Kimi models while the relay serves requests', async () => {
    // The rerouted config pins the coding baseUrl, which outranks the relay
    // URL in resolveBaseUrl while the credential layer resolves a relay
    // token — under serving included access the config must stay untouched.
    const config = await createKimiHandler({ includedAccess: true });
    expect(config.baseUrl).toBeUndefined();
    expect(config.fullName).toBe(dualBackendKimi.fullName);
  });

  it('reroutes to the coding endpoint when the relay cannot serve', async () => {
    const config = await createKimiHandler({ includedAccess: false });
    expect(config.baseUrl).toBe('https://api.kimi.com/coding/v1');
  });
});
