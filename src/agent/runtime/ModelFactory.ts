import { ModelProvider, type ModelConfig } from 'llm-zoo';
import { ModelHandler } from '@agent/modelHandlers/ModelHandler';

import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import * as logger from '@agent/core/logger';
import { getGlobalState } from '@agent/core/stateStore';
import { getConfig } from '@agent/core/config';
import { GlobalStateKey } from '@common/state/stateKeys';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { LEVEL_TO_EFFORT } from './reasoningEffort';

const CHANNEL = 'ModelFactory';
logger.initialize(CHANNEL);

type ModelHandlerConstructor = new (
  config: ModelConfig,
) => ModelHandler<ProviderMessage>;

type ProviderHandlerLoader = () => Promise<ModelHandlerConstructor>;

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
// `null` marks providers that have no direct handler (routed elsewhere or unsupported).
const PROVIDER_HANDLERS: Record<ModelProvider, ProviderHandlerLoader | null> = {
  [ModelProvider.ANTHROPIC]: async () =>
    (await import('@agent/modelHandlers/modelHandlerAnthropic'))
      .ModelHandlerAnthropic,
  [ModelProvider.OPENAI]: async () =>
    (await import('@agent/modelHandlers/modelHandlerOpenAI'))
      .ModelHandlerOpenAI,
  [ModelProvider.GOOGLE]: async () =>
    (await import('@agent/modelHandlers/modelHandlerGoogleGenAI'))
      .ModelHandlerGoogleGenAI,
  [ModelProvider.DEEPSEEK]: async () =>
    (await import('@agent/modelHandlers/modelHandlerDeepSeek'))
      .ModelHandlerDeepSeek,
  [ModelProvider.XAI]: async () =>
    (await import('@agent/modelHandlers/modelHandlerXAI')).ModelHandlerXAI,
  [ModelProvider.MOONSHOT]: async () =>
    (await import('@agent/modelHandlers/modelHandlerKimi')).ModelHandlerKimi,
  [ModelProvider.DASHSCOPE]: async () =>
    (await import('@agent/modelHandlers/modelHandlerDashScope'))
      .ModelHandlerDashScope,
  [ModelProvider.MINIMAX]: async () =>
    (await import('@agent/modelHandlers/modelHandlerMiniMax'))
      .ModelHandlerMiniMax,
  [ModelProvider.GLM]: async () =>
    (await import('@agent/modelHandlers/modelHandlerGLM')).ModelHandlerGLM,
  [ModelProvider.OTHERS]: async () =>
    (await import('@agent/modelHandlers/modelHandlerOpenRouterNative'))
      .ModelHandlerOpenRouterNative,
  [ModelProvider.COPILOT]: null,
};

/**
 * Apply the user's reasoning level override to a handler, returning it for chaining.
 * Only mutates capabilities when the model supports configurable effort and the
 * user has set an override.
 */
function withReasoningOverride<T extends ModelHandler>(handler: T): T {
  const supportsReasoningOverride =
    handler.capabilities.supportsReasoningEffort ||
    (handler.isDeepSeek && handler.capabilities.supportsReasoning);
  if (!supportsReasoningOverride) return handler;

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

/**
 * Apply the user's "prefer short model names" setting.
 * When enabled, uses the model's shortName (e.g. "gpt-5.5") instead of the
 * date-pinned fullName (e.g. "gpt-5.5-2026-04-15"). Useful for proxies/gateways
 * that only accept unpinned model identifiers.
 */
function withShortModelName(config: ModelConfig): ModelConfig {
  if (
    !getGlobalState().get<boolean>(
      GlobalStateKey.PREFER_SHORT_MODEL_NAMES,
      false,
    )
  ) {
    return config;
  }
  const short = config.shortName;
  if (!short || short === config.fullName) return config;

  logger.debug(
    CHANNEL,
    `Using short model name for ${config.name}: ${config.fullName} → ${short}`,
  );
  return { ...config, fullName: short };
}

async function shouldUseInternalValidationModelHandler(): Promise<boolean> {
  if (process.env[INTERNAL_VALIDATION_MODEL_HANDLER_ENV] !== '1') {
    return false;
  }

  const flagPath = process.env[INTERNAL_VALIDATION_MODEL_HANDLER_FLAG_ENV];
  const [{ readFileSync }, path] = await Promise.all([
    import('node:fs'),
    import('node:path'),
  ]);
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
    (await shouldUseInternalValidationModelHandler())
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
    return new ModelHandlerValidation(config);
  }

  const useOpenRouter = getUseOpenRouter();

  // OpenAI Responses API (required or optional)
  if (shouldUseResponsesAPI(config, useOpenRouter)) {
    logger.debug(CHANNEL, 'Using OpenAI Responses API Handler');
    const { ModelHandlerOpenAIResponse } =
      await import('@agent/modelHandlers/modelHandlerOpenAIResponse');
    return withReasoningOverride(new ModelHandlerOpenAIResponse(config));
  }

  // Route through OpenRouter if configured
  if (config.openRouterOnly || useOpenRouter) {
    const openrouterFullName =
      config.openrouterFullName ?? `${config.provider}/${config.fullName}`;
    const { ModelHandlerOpenRouterNative } =
      await import('@agent/modelHandlers/modelHandlerOpenRouterNative');
    return withReasoningOverride(
      new ModelHandlerOpenRouterNative({ ...config, openrouterFullName }),
    );
  }

  // Direct provider handler
  const loadHandler = PROVIDER_HANDLERS[config.provider];
  if (!loadHandler) {
    throw new Error(`Unsupported model provider: ${config.provider}`);
  }
  const HandlerClass = await loadHandler();
  logger.debug(CHANNEL, `Using Handler: ${HandlerClass.name}`);
  return withReasoningOverride(new HandlerClass(config));
}
