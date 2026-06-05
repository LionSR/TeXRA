import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { ModelProvider, type ModelConfig } from 'llm-zoo';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import { getGlobalState } from '@agent/core/stateStore';
import { getConfig } from '@utils/config/configUtils';
import { GlobalStateKey } from '@common/state/stateKeys';
import * as logger from '@logger/logUtils';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { LEVEL_TO_EFFORT } from './reasoningEffort';

const CHANNEL = 'ModelFactory';
logger.initialize(CHANNEL);

type ModelHandlerConstructor = new (
  config: ModelConfig,
) => ModelHandler<ProviderMessage>;

type ProviderHandlerLoader = () => Promise<ModelHandlerConstructor>;
export type ModelHandlerCompatibilityKey =
  | 'ModelHandlerValidation'
  | 'ModelHandlerOpenAIResponse'
  | 'ModelHandlerOpenRouterNative'
  | 'ModelHandlerAnthropic'
  | 'ModelHandlerOpenAI'
  | 'ModelHandlerGoogleGenAI'
  | 'ModelHandlerDeepSeek'
  | 'ModelHandlerXAI'
  | 'ModelHandlerKimi'
  | 'ModelHandlerDashScope'
  | 'ModelHandlerMiniMax'
  | 'ModelHandlerGLM';

interface ProviderHandlerRoute {
  readonly load: ProviderHandlerLoader | null;
  readonly compatibilityKey: ModelHandlerCompatibilityKey | null;
}

const MODEL_HANDLER_COMPATIBILITY_PROPERTY =
  '__texraModelHandlerCompatibilityKey';

type ModelHandlerCompatibilityTagged = object & {
  readonly [MODEL_HANDLER_COMPATIBILITY_PROPERTY]?:
    | ModelHandlerCompatibilityKey
    | undefined;
};

const INCLUDE_INTERNAL_VALIDATION_MODEL_HANDLER =
  process.env.TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL === '1';
const INTERNAL_VALIDATION_MODEL_HANDLER_ENV =
  process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_ENV ?? '';
const INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV =
  process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV ?? '';
const INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_CONTENT =
  process.env.TEXRA_CLI_INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_CONTENT ?? '';

// Record (not Map) so TypeScript enforces exhaustiveness over ModelProvider.
// A new enum value in llm-zoo without an entry here will fail typecheck.
// `null` route fields mark providers that have no direct handler.
const PROVIDER_HANDLER_ROUTES: Record<ModelProvider, ProviderHandlerRoute> = {
  [ModelProvider.ANTHROPIC]: {
    load: async () =>
      (await import('@agent/modelHandlers/anthropic/modelHandlerAnthropic'))
        .ModelHandlerAnthropic,
    compatibilityKey: 'ModelHandlerAnthropic',
  },
  [ModelProvider.OPENAI]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerOpenAI'))
        .ModelHandlerOpenAI,
    compatibilityKey: 'ModelHandlerOpenAI',
  },
  [ModelProvider.GOOGLE]: {
    load: async () =>
      (await import('@agent/modelHandlers/google/modelHandlerGoogleGenAI'))
        .ModelHandlerGoogleGenAI,
    compatibilityKey: 'ModelHandlerGoogleGenAI',
  },
  [ModelProvider.DEEPSEEK]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerDeepSeek'))
        .ModelHandlerDeepSeek,
    compatibilityKey: 'ModelHandlerDeepSeek',
  },
  [ModelProvider.XAI]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerXAI'))
        .ModelHandlerXAI,
    compatibilityKey: 'ModelHandlerXAI',
  },
  [ModelProvider.MOONSHOT]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerKimi'))
        .ModelHandlerKimi,
    compatibilityKey: 'ModelHandlerKimi',
  },
  [ModelProvider.DASHSCOPE]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerDashScope'))
        .ModelHandlerDashScope,
    compatibilityKey: 'ModelHandlerDashScope',
  },
  [ModelProvider.MINIMAX]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerMiniMax'))
        .ModelHandlerMiniMax,
    compatibilityKey: 'ModelHandlerMiniMax',
  },
  [ModelProvider.GLM]: {
    load: async () =>
      (await import('@agent/modelHandlers/openai/modelHandlerGLM'))
        .ModelHandlerGLM,
    compatibilityKey: 'ModelHandlerGLM',
  },
  [ModelProvider.OTHERS]: {
    load: async () =>
      (
        await import('@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative')
      ).ModelHandlerOpenRouterNative,
    compatibilityKey: 'ModelHandlerOpenRouterNative',
  },
  [ModelProvider.COPILOT]: {
    load: null,
    compatibilityKey: null,
  },
};

/**
 * Apply the user's reasoning level override to a handler, returning it for chaining.
 * Only mutates capabilities when the handler reports `supportsReasoningLevelOverride`
 * (configurable effort, or DeepSeek-style reasoning without a granular effort flag)
 * and the user has set an override.
 */
function withReasoningOverride<T extends ModelHandler>(handler: T): T {
  if (!handler.supportsReasoningLevelOverride) return handler;

  const level = getGlobalState().get<Record<string, string>>(
    GlobalStateKey.REASONING_LEVELS,
    {},
  )[handler.config.name];
  const effort = level ? LEVEL_TO_EFFORT[level] : undefined;
  if (effort === undefined) return handler;

  logger.debug(
    CHANNEL,
    `Applying reasoning level override for ${handler.config.name}: ${level}`,
  );
  handler.capabilities.reasoningEffort = effort;
  return handler;
}

function requiresOpenAIResponsesAPI(
  config: ModelConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.provider !== ModelProvider.OPENAI || config.openRouterOnly) {
    return false;
  }
  if (config.requiresResponsesAPI) return true;

  // The gpt-5 reasoning + function-calling heuristic only applies when we are
  // talking to OpenAI directly. OpenRouter proxies these models on
  // /v1/chat/completions and rejects Responses-shaped payloads.
  if (useOpenRouter) return false;

  const { capabilities } = config;
  return (
    config.fullName.startsWith('gpt-5') &&
    capabilities.supportsReasoningEffort !== false &&
    capabilities.supportsFunctionCalling !== false
  );
}

/** Check if OpenAI Responses API should be used for this config. */
export function shouldUseResponsesAPI(
  config: ModelConfig,
  useOpenRouter: boolean,
): boolean {
  if (config.provider !== ModelProvider.OPENAI || config.openRouterOnly) {
    return false;
  }
  return (
    requiresOpenAIResponsesAPI(config, useOpenRouter) ||
    (!useOpenRouter &&
      (getConfig<boolean>('texra.model.useOpenAIResponsesAPI', false) ||
        config.fullName.startsWith('gpt-oss')))
  );
}

function applyShortModelNamePreference(
  config: ModelConfig,
  preferShortModelNames: boolean,
): ModelConfig {
  if (!preferShortModelNames) return config;
  const short = config.shortName;
  if (!short || short === config.fullName) return config;
  return { ...config, fullName: short };
}

function shouldUseInternalValidationModelHandler(): boolean {
  if (process.env[INTERNAL_VALIDATION_MODEL_HANDLER_ENV] !== '1') {
    return false;
  }

  const flagPath = process.env[INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV];
  if (process.env.CI !== '1' || !flagPath || !path.isAbsolute(flagPath)) {
    throw new Error(
      `${INTERNAL_VALIDATION_MODEL_HANDLER_ENV}=1 is restricted to package validation with CI=1 and an absolute ${INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV} path.`,
    );
  }

  let flagContent: string;
  try {
    flagContent = readFileSync(flagPath, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `${INTERNAL_VALIDATION_MODEL_HANDLER_ENV}=1 requires a readable validation flag file at ${flagPath}.`,
      { cause: error },
    );
  }

  if (flagContent !== INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_CONTENT) {
    throw new Error(
      `${INTERNAL_VALIDATION_MODEL_HANDLER_ENV}=1 received an invalid validation flag file.`,
    );
  }

  return true;
}

/** Returns the conversation-history format used by the handler for this model. */
export function modelHandlerCompatibilityKey(
  originalConfig: ModelConfig,
  useOpenRouter = getUseOpenRouter(),
  preferShortModelNames = getGlobalState().get<boolean>(
    GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
    false,
  ),
): ModelHandlerCompatibilityKey | undefined {
  if (
    INCLUDE_INTERNAL_VALIDATION_MODEL_HANDLER &&
    shouldUseInternalValidationModelHandler()
  ) {
    return 'ModelHandlerValidation';
  }

  const config = applyShortModelNamePreference(
    originalConfig,
    preferShortModelNames,
  );
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    return 'ModelHandlerOpenAIResponse';
  }
  if (config.openRouterOnly || useOpenRouter) {
    return 'ModelHandlerOpenRouterNative';
  }
  return PROVIDER_HANDLER_ROUTES[config.provider].compatibilityKey ?? undefined;
}

export function activeModelHandlerCompatibilityKey(
  handler: object,
): ModelHandlerCompatibilityKey | undefined {
  return (handler as ModelHandlerCompatibilityTagged)[
    MODEL_HANDLER_COMPATIBILITY_PROPERTY
  ];
}

function withModelHandlerCompatibilityKey<T extends ModelHandler>(
  handler: T,
  compatibilityKey: ModelHandlerCompatibilityKey,
): T {
  Object.defineProperty(handler, MODEL_HANDLER_COMPATIBILITY_PROPERTY, {
    value: compatibilityKey,
    enumerable: false,
  });
  return handler;
}

/**
 * Apply the user's "prefer short model names" setting.
 * When enabled, uses the model's shortName (e.g. "gpt-5.5") instead of the
 * date-pinned fullName (e.g. "gpt-5.5-2026-04-15"). Useful for proxies/gateways
 * that only accept unpinned model identifiers.
 */
function withShortModelName(config: ModelConfig): ModelConfig {
  const resolved = applyShortModelNamePreference(
    config,
    getGlobalState().get<boolean>(
      GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
      false,
    ),
  );
  if (resolved === config) return config;

  logger.debug(
    CHANNEL,
    `Using short model name for ${config.name}: ${config.fullName} → ${resolved.fullName}`,
  );
  return resolved;
}

/**
 * Creates a model handler instance based on provider and routing configuration.
 * Applies short model name preference and reasoning level overrides.
 */
export async function createModelHandler(
  originalConfig: ModelConfig,
): Promise<ModelHandler> {
  const config = withShortModelName(originalConfig);

  if (
    INCLUDE_INTERNAL_VALIDATION_MODEL_HANDLER &&
    shouldUseInternalValidationModelHandler()
  ) {
    // Package validation still enters the real CLI and executeAgent path.
    // Only the provider boundary is deterministic, so this must not become
    // a user-facing model selector or an injected command-layer substitute.
    logger.warn(
      CHANNEL,
      `${INTERNAL_VALIDATION_MODEL_HANDLER_ENV}=1 is replacing provider handlers with the internal validation handler.`,
    );
    const { ModelHandlerValidation } =
      await import('@agent/modelHandlers/modelHandlerValidation');
    return withModelHandlerCompatibilityKey(
      new ModelHandlerValidation(config),
      'ModelHandlerValidation',
    );
  }

  const useOpenRouter = getUseOpenRouter();

  // OpenAI Responses API (required or optional)
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
    const { ModelHandlerOpenAIResponse } =
      await import('@agent/modelHandlers/openai/modelHandlerOpenAIResponse');
    return withModelHandlerCompatibilityKey(
      withReasoningOverride(new ModelHandlerOpenAIResponse(config)),
      'ModelHandlerOpenAIResponse',
    );
  }

  // Route through OpenRouter if configured
  if (config.openRouterOnly || useOpenRouter) {
    const openrouterFullName =
      config.openrouterFullName ?? `${config.provider}/${config.fullName}`;
    const { ModelHandlerOpenRouterNative } =
      await import('@agent/modelHandlers/openrouter/modelHandlerOpenRouterNative');
    return withModelHandlerCompatibilityKey(
      withReasoningOverride(
        new ModelHandlerOpenRouterNative({ ...config, openrouterFullName }),
      ),
      'ModelHandlerOpenRouterNative',
    );
  }

  // Direct provider handler
  const route = PROVIDER_HANDLER_ROUTES[config.provider];
  if (!route.load || !route.compatibilityKey) {
    throw new Error(`Unsupported model provider: ${config.provider}`);
  }
  const HandlerClass = await route.load();
  logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
  return withModelHandlerCompatibilityKey(
    withReasoningOverride(new HandlerClass(config)),
    route.compatibilityKey,
  );
}
