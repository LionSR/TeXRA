/**
 * The run's model binding: one runtime `ModelConfig` plus the route the
 * factory already decides, resolved to the llm package `Model` the loop
 * calls, the durable `ModelOrigin` every ledger row names, and the runtime
 * facts the package deliberately does not own (price, context window, the
 * credential route keys the retry gate coordinates on).
 *
 * Credentials are resolved when the binding is made, under the recorded
 * route; the secret reaches the package's transport and never a row. The
 * `credentialScope` on the origin is a non-secret name of the route.
 */
import { createHash } from 'node:crypto';

import { Context, Effect, Option, type Scope } from 'effect';
import { ModelProvider, type ModelConfig } from 'llm-zoo';

import {
  resolveModelHandlerCompatibilityKey,
  resolveRouteCredential,
  type RouteCredential,
} from '@agent/runtime/ModelFactory';
import { anthropicMessagesModel } from '@llm/anthropicMessages';
import { googleInteractionsModel } from '@llm/googleInteractions';
import { openaiChatModel } from '@llm/openaiChat';
import { openaiResponsesModel } from '@llm/openaiResponses';
import { openrouterChatModel } from '@llm/openrouterChat';
import {
  type Model,
  type ModelConfiguration,
  type ModelError,
  type ModelOrigin,
  type VscodeLanguageModelConfiguration,
} from '@llm/turn';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { CopilotRouteOverride } from '@model/copilotRouting';
import { copilotRouteForModel } from '@model/runtimeModelRegistry';
import {
  kimiCodeEffectiveConfig,
  resolveKimiCodeRoutingFacts,
} from '@model/kimiCodeSubscriptionRouting';
import {
  AgentCategory,
  type ModelHandlerCompatibilityKey,
  type UsageProviderSchema,
  type UsageRoute,
} from '@shared/schemas';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { ensureError } from '@utils/errors/errorMessage';
import { validationModel } from './validationModel';
import type { z } from 'zod';

type UsageProvider = z.infer<typeof UsageProviderSchema>;

/** Tool-use runs keep output headroom for context growth, as the handler did. */
const TOOL_USE_MAX_OUTPUT_FACTOR = 0.5;

/**
 * The host's editor language models (R2). An extension host that reaches the
 * editor's language-model API provides one at its process root and the run
 * layer binds `vscode-lm` models through it; a host without an editor
 * provides none, and binding such a model there fails with that fact. The
 * package keeps only the protocol; the acquired model lives in the scope it
 * is acquired into (the run's).
 */
export class EditorModel extends Context.Service<
  EditorModel,
  {
    readonly acquire: (
      configuration: VscodeLanguageModelConfiguration,
    ) => Effect.Effect<Model, ModelError, Scope.Scope>;
  }
>()('@texra/agent/EditorModel') {}

const LLM_EFFORTS = new Set([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const);
type LlmEffort = typeof LLM_EFFORTS extends Set<infer E> ? E : never;
type RouteEffort = Exclude<LlmEffort, 'none' | 'minimal'>;

function llmEffort(effort: string | undefined): LlmEffort | null {
  return effort !== undefined && (LLM_EFFORTS as Set<string>).has(effort)
    ? (effort as LlmEffort)
    : null;
}

function routeEffort(effort: string | undefined): RouteEffort | null {
  const value = llmEffort(effort);
  return value === null || value === 'none' || value === 'minimal'
    ? null
    : value;
}

function supportedRouteEfforts(config: ModelConfig): readonly RouteEffort[] {
  const listed = config.capabilities.supportedReasoningEfforts ?? [];
  const efforts = listed
    .map((effort) => routeEffort(effort))
    .filter((effort): effort is RouteEffort => effort !== null);
  const configured = routeEffort(config.capabilities.reasoningEffort);
  if (configured !== null && !efforts.includes(configured)) {
    efforts.push(configured);
  }
  return efforts;
}

/** The runtime facts of one bound model that the package does not carry. */
export interface BoundModel {
  /** Registry short name; the run's `modelId` on every snapshot. */
  readonly modelId: string;
  readonly config: ModelConfig;
  readonly compatibilityKey: ModelHandlerCompatibilityKey;
  readonly model: Model;
  readonly origin: ModelOrigin;
  readonly usageProvider: UsageProvider;
  readonly usageRoute: UsageRoute;
  readonly contextWindow: number;
  readonly supportsVision: boolean;
  readonly supportsNativePdf: boolean;
  readonly supportsNativeAudio: boolean;
  readonly supportsReasoning: boolean;
  readonly supportsForcedToolChoice: boolean;
  /** One wire route: provider, credential route, endpoint, key fingerprint. */
  readonly wireRouteKey: string;
  /** The wire route narrowed to one model, for model-scoped limits. */
  readonly modelRetryRouteKey: string;
  /** The failed binding sat on the Kimi Code coding endpoint. */
  readonly routedOnKimiCode: boolean;
  /** The binding can run a turn as background work (submit + observe). */
  readonly backgroundCapable: boolean;
}

export interface BindModelInput {
  readonly config: ModelConfig;
  /** The run's process secret store and global state, from the launch. */
  readonly stores: ModelOptionStores;
  /** A persisted conversation format wins over today's default route. */
  readonly compatibilityKey?: ModelHandlerCompatibilityKey | null;
  readonly copilotRouteOverride?: CopilotRouteOverride;
  readonly agentCategory: AgentCategory;
  /** The route default's temperature; the request may override per turn. */
  readonly temperature: number;
  /** Runs a Promise-tier read inside the launch's async-local frame. */
  readonly inScope: <A>(operation: () => A) => A;
}

type Protocol = ModelConfiguration['protocol'];
/** The protocols the package constructs a model for; the editor's is the host's. */
type HttpProtocol = Exclude<Protocol, 'vscode-lm'>;
type HttpConfiguration = Exclude<ModelConfiguration, { protocol: 'vscode-lm' }>;

const PROTOCOL_BY_KEY: Record<
  ModelHandlerCompatibilityKey,
  Protocol | 'validation'
> = {
  ModelHandlerValidation: 'validation',
  ModelHandlerOpenAIResponse: 'openai-responses',
  ModelHandlerOpenRouterNative: 'openrouter-chat',
  ModelHandlerVscodeLm: 'vscode-lm',
  ModelHandlerAnthropic: 'anthropic-messages',
  ModelHandlerOpenAI: 'openai-chat',
  ModelHandlerGoogleInteractions: 'google-interactions',
  ModelHandlerDeepSeek: 'deepseek-chat',
  ModelHandlerXAI: 'xai-chat',
  ModelHandlerKimi: 'kimi-chat',
  ModelHandlerDashScope: 'dashscope-chat',
  ModelHandlerMiniMax: 'minimax-chat',
  ModelHandlerGLM: 'glm-chat',
  ModelHandlerMeta: 'openai-responses',
};

const USAGE_PROVIDER_BY_MODEL_PROVIDER: Record<ModelProvider, UsageProvider> = {
  [ModelProvider.ANTHROPIC]: 'anthropic',
  [ModelProvider.OPENAI]: 'openai',
  [ModelProvider.GOOGLE]: 'google',
  [ModelProvider.DEEPSEEK]: 'deepseek',
  [ModelProvider.XAI]: 'xai',
  [ModelProvider.MOONSHOT]: 'moonshot',
  [ModelProvider.DASHSCOPE]: 'dashscope',
  [ModelProvider.MINIMAX]: 'minimax',
  [ModelProvider.GLM]: 'glm',
  [ModelProvider.META]: 'meta',
  [ModelProvider.OTHERS]: 'openrouter',
  [ModelProvider.COPILOT]: 'unknown',
};

function usageProviderFor(
  protocol: Protocol | 'validation',
  config: ModelConfig,
): UsageProvider {
  if (protocol === 'openrouter-chat') return 'openrouter';
  if (protocol === 'openai-responses') return 'openai-response';
  return USAGE_PROVIDER_BY_MODEL_PROVIDER[config.provider];
}

function credentialFingerprint(route: string, secret: string): string {
  return createHash('sha256')
    .update(route)
    .update('\0')
    .update(secret)
    .digest('base64url');
}

/** Configuration shared by every HTTP protocol arm. */
function binding(config: ModelConfig, credential: RouteCredential) {
  return {
    requestedModel: config.fullName,
    deployment: {
      endpoint: credential.endpoint,
      credentialScope: `${credential.provider}:${credential.route}`,
    },
  } as const;
}

type AnthropicThinking = Extract<
  ModelConfiguration,
  { protocol: 'anthropic-messages' }
>['defaults']['thinking'];

function anthropicThinking(
  capabilities: ModelConfig['capabilities'],
  maxOutputTokens: number,
): AnthropicThinking {
  if (!capabilities.supportsReasoning) return { mode: 'disabled' };
  if (capabilities.supportsAdaptiveThinking) {
    return { mode: 'adaptive', display: 'summarized' };
  }
  return {
    mode: 'enabled',
    budgetTokens: Math.max(1024, Math.floor(maxOutputTokens / 2)),
    display: 'summarized',
  };
}

function configurationFor(
  protocol: HttpProtocol,
  config: ModelConfig,
  credential: RouteCredential,
  input: BindModelInput,
): HttpConfiguration {
  const { capabilities } = config;
  const maxOutputTokens =
    input.agentCategory === AgentCategory.ToolUse
      ? Math.max(
          1,
          Math.floor(config.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR),
        )
      : config.maxOutputTokens;
  const supportsTemperature = !capabilities.supportsReasoning;
  const effort = routeEffort(capabilities.reasoningEffort);
  const supportedEfforts = supportedRouteEfforts(config);
  const thinkingMode = capabilities.supportsReasoning ? 'enabled' : 'disabled';
  const base = binding(config, credential);
  switch (protocol) {
    case 'anthropic-messages':
      return {
        ...base,
        protocol,
        supportsInputTokenEstimation: capabilities.supportsTokenCounting,
        supportsTemperature,
        supportsForcedToolChoice: true,
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature ? input.temperature : null,
          parallelToolCalls: true,
          thinking: anthropicThinking(capabilities, maxOutputTokens),
          effort: capabilities.supportsReasoningEffort ? effort : null,
          cache: capabilities.supportsPromptCaching ? '5m' : 'disabled',
          stopSequences: [],
        },
      };
    case 'openai-chat':
      return {
        ...base,
        protocol,
        supportsTemperature,
        supportedEfforts: [...supportedEfforts],
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature ? input.temperature : null,
          parallelToolCalls: true,
          effort: capabilities.supportsReasoningEffort
            ? llmEffort(capabilities.reasoningEffort)
            : null,
        },
      };
    case 'openai-responses':
      return {
        ...base,
        protocol,
        background: 'supported',
        supportsInputTokenEstimation: false,
        supportsTemperature,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsResponseChaining: true,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: supportedEfforts.length
          ? [...supportedEfforts]
          : ['low', 'medium', 'high'],
        instructions: { kind: 'optional' },
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature ? input.temperature : null,
          store: false,
          parallelToolCalls: true,
          reasoning: capabilities.supportsReasoning
            ? {
                effort: capabilities.supportsReasoningEffort ? effort : null,
                mode: capabilities.reasoningMode ?? null,
                summary: 'auto',
              }
            : null,
          serviceTier: config.serviceTier ?? null,
        },
      };
    case 'google-interactions':
      return {
        ...base,
        protocol,
        background: 'supported',
        supportsInputTokenEstimation: capabilities.supportsTokenCounting,
        defaults: {
          maxOutputTokens,
          store: false,
          thinkingLevel:
            effort === 'low' || effort === 'medium' || effort === 'high'
              ? effort
              : 'high',
        },
      };
    case 'deepseek-chat':
      return {
        ...base,
        protocol,
        supportedEfforts: [...supportedEfforts],
        supportsForcedToolChoice: true,
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature ? input.temperature : null,
          thinking: { mode: thinkingMode },
          effort: null,
        },
      };
    case 'kimi-chat':
      return {
        ...base,
        protocol,
        supportsImageInput: capabilities.supportsVision,
        supportsInputTokenEstimation: capabilities.supportsTokenCounting,
        thinkingControl: 'toggle',
        supportedEfforts: [...supportedEfforts],
        supportsForcedToolChoice: true,
        temperatureByThinking: { enabled: 1, disabled: input.temperature },
        defaults: {
          maxOutputTokens,
          thinking: { mode: thinkingMode },
          effort: null,
          preserveThinking: true,
        },
      };
    case 'glm-chat':
      return {
        ...base,
        protocol,
        supportsImageInput: capabilities.supportsVision,
        supportsThinkingDisabled: true,
        supportedEfforts: [...supportedEfforts],
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature
            ? Math.min(1, input.temperature)
            : null,
          thinking: { mode: thinkingMode },
          effort: null,
          clearThinking: false,
        },
      };
    case 'xai-chat': {
      const xaiEffort = effort === 'max' ? null : effort;
      return {
        ...base,
        protocol,
        supportsImageInput: capabilities.supportsVision,
        supportedEfforts: supportedEfforts.filter(
          (value): value is Exclude<RouteEffort, 'max'> => value !== 'max',
        ),
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature ? input.temperature : null,
          parallelToolCalls: true,
          effort: capabilities.supportsReasoningEffort ? xaiEffort : null,
        },
      };
    }
    case 'dashscope-chat':
      return {
        ...base,
        protocol,
        defaults: {
          maxOutputTokens,
          temperature: Math.min(1.99, input.temperature),
          parallelToolCalls: true,
          stopSequences: [],
          thinking: { mode: 'disabled' },
        },
      };
    case 'minimax-chat':
      return {
        ...base,
        protocol,
        reasoningSplit: capabilities.supportsReasoning,
        defaults: {
          maxOutputTokens,
          temperature: input.temperature,
          parallelToolCalls: true,
          stopSequences: [],
        },
      };
    case 'openrouter-chat':
      return {
        ...base,
        requestedModel:
          config.openrouterFullName ?? `${config.provider}/${config.fullName}`,
        protocol,
        supportsTemperature,
        supportsForcedToolChoice: true,
        supportsImageInput: capabilities.supportsVision,
        supportsAudioInput: capabilities.supportsNativeAudio,
        supportedEfforts: [...supportedEfforts],
        defaults: {
          maxOutputTokens,
          temperature: supportsTemperature ? input.temperature : null,
          effort: capabilities.supportsReasoningEffort
            ? llmEffort(capabilities.reasoningEffort)
            : null,
          stopSequences: [],
        },
      };
  }
}

function constructModel(
  configuration: HttpConfiguration,
  credential: RouteCredential,
): Model {
  switch (configuration.protocol) {
    case 'anthropic-messages':
      return anthropicMessagesModel(configuration, {
        apiKey: credential.apiKey,
      });
    case 'openai-responses':
      return openaiResponsesModel(configuration, {
        authentication: { kind: 'api-key', apiKey: credential.apiKey },
      });
    case 'google-interactions':
      return googleInteractionsModel(configuration, {
        apiKey: credential.apiKey,
      });
    case 'openrouter-chat':
      return openrouterChatModel(configuration, {
        apiKey: credential.apiKey,
      });
    case 'openai-chat':
    case 'deepseek-chat':
    case 'kimi-chat':
    case 'glm-chat':
    case 'xai-chat':
    case 'dashscope-chat':
    case 'minimax-chat':
      return openaiChatModel(configuration, { apiKey: credential.apiKey });
  }
}

/** Whether a binding's configuration admits background work. */
function backgroundCapable(configuration: HttpConfiguration): boolean {
  switch (configuration.protocol) {
    case 'openai-responses':
      return configuration.background === 'supported';
    case 'google-interactions':
      // Google retrieves a background result through server-side state.
      return (
        configuration.background === 'supported' && configuration.defaults.store
      );
    default:
      return false;
  }
}

/**
 * Bind a model the editor serves. The route is the one the registry
 * discovered for the base model (exact id, vendor and version); the editor
 * model itself comes from the host's port, into the caller's scope.
 */
const bindEditorModel = Effect.fn('bindEditorModel')(function* (
  config: ModelConfig,
  compatibilityKey: ModelHandlerCompatibilityKey,
): Effect.fn.Return<BoundModel, Error, Scope.Scope> {
  const editor = yield* Effect.serviceOption(EditorModel);
  if (Option.isNone(editor)) {
    return yield* Effect.fail(
      new Error(
        `Model ${config.name} is served by the editor's language-model API, which this host does not expose.`,
      ),
    );
  }
  const route = copilotRouteForModel(config.name);
  if (route === undefined) {
    return yield* Effect.fail(
      new Error(
        `No editor route is discovered for model ${config.name}; refresh the model list.`,
      ),
    );
  }
  // The discovered route carries the editor's own context ceiling and the
  // subscription's pricing: the config the run accounts against.
  const routed = route.effectiveConfig;
  const requestedModel = route.reference.id;
  const deployment = {
    vendor: route.reference.vendor,
    version: route.version,
  } as const;
  const model = yield* editor.value
    .acquire({
      protocol: 'vscode-lm',
      requestedModel,
      deployment,
      supportsImageInput: routed.capabilities.supportsVision,
      supportsToolCalling: routed.capabilities.supportsFunctionCalling,
      defaults: { justification: 'Run the selected TeXRA agent.' },
    })
    .pipe(Effect.mapError(ensureError));
  return {
    modelId: config.name,
    config: routed,
    compatibilityKey,
    model,
    origin: {
      protocol: 'vscode-lm',
      codecVersion: 1,
      requestedModel,
      deployment,
    },
    usageProvider: usageProviderFor('vscode-lm', routed),
    usageRoute: 'api-key',
    contextWindow: routed.contextWindow,
    supportsVision: routed.capabilities.supportsVision,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsReasoning: routed.capabilities.supportsReasoning,
    supportsForcedToolChoice: false,
    wireRouteKey: JSON.stringify([
      'vscode-lm',
      deployment.vendor,
      deployment.version,
    ]),
    modelRetryRouteKey: JSON.stringify([
      'vscode-lm',
      deployment.vendor,
      deployment.version,
      requestedModel,
    ]),
    routedOnKimiCode: false,
    backgroundCapable: false,
  };
});

/**
 * Bind one model for a run. The route is the factory's decision, read
 * through the same resolver every other route reader uses; the persisted
 * compatibility key of a resumed conversation wins over today's default.
 */
export const bindModel = Effect.fn('bindModel')(function* (
  input: BindModelInput,
): Effect.fn.Return<BoundModel, Error, Scope.Scope> {
  const useOpenRouter = getUseOpenRouter();
  const compatibilityKey =
    input.compatibilityKey ??
    (yield* Effect.try({
      try: () =>
        resolveModelHandlerCompatibilityKey(
          input.config,
          input.stores.globalState,
          useOpenRouter,
          input.copilotRouteOverride,
        ),
      catch: ensureError,
    }));
  if (compatibilityKey === undefined) {
    return yield* Effect.fail(
      new Error(`Unsupported model provider: ${input.config.provider}`),
    );
  }
  const protocol = PROTOCOL_BY_KEY[compatibilityKey];
  if (protocol === 'vscode-lm') {
    return yield* bindEditorModel(input.config, compatibilityKey);
  }
  const onOpenRouter = compatibilityKey === 'ModelHandlerOpenRouterNative';
  let config = input.config;
  if (
    compatibilityKey === 'ModelHandlerKimi' &&
    isKimiSubscriptionEligible(config)
  ) {
    config = yield* Effect.tryPromise({
      try: () =>
        input.inScope(async () =>
          kimiCodeEffectiveConfig(
            config,
            await resolveKimiCodeRoutingFacts(
              input.stores.secrets,
              onOpenRouter,
            ),
          ),
        ),
      catch: ensureError,
    });
  }
  if (protocol === 'validation') {
    const bound = validationModel(config);
    return {
      modelId: config.name,
      config,
      compatibilityKey,
      model: bound.model,
      origin: bound.origin,
      usageProvider: usageProviderFor(protocol, config),
      usageRoute: 'api-key',
      contextWindow: config.contextWindow,
      supportsVision: false,
      supportsNativePdf: false,
      supportsNativeAudio: false,
      supportsReasoning: false,
      supportsForcedToolChoice: true,
      wireRouteKey: JSON.stringify([config.provider, 'validation']),
      modelRetryRouteKey: JSON.stringify([
        config.provider,
        'validation',
        config.fullName,
      ]),
      routedOnKimiCode: false,
      backgroundCapable: false,
    };
  }
  const credential = yield* Effect.tryPromise({
    try: () =>
      input.inScope(() =>
        resolveRouteCredential(config, onOpenRouter, input.stores.secrets),
      ),
    catch: ensureError,
  });
  const built = yield* Effect.try({
    try: () => {
      const configuration = configurationFor(
        protocol,
        config,
        credential,
        input,
      );
      return {
        configuration,
        model: constructModel(configuration, credential),
      };
    },
    catch: ensureError,
  });
  const origin: ModelOrigin = {
    protocol: built.configuration.protocol,
    codecVersion: 1,
    requestedModel: built.configuration.requestedModel,
    deployment: built.configuration.deployment,
  } as ModelOrigin;
  const wireRouteKey = JSON.stringify([
    config.provider,
    credential.route,
    credential.endpoint,
    credentialFingerprint(credential.route, credential.apiKey),
  ]);
  return {
    modelId: config.name,
    config,
    compatibilityKey,
    model: built.model,
    origin,
    usageProvider: usageProviderFor(protocol, config),
    usageRoute: credential.usageRoute,
    contextWindow: config.contextWindow,
    supportsVision: config.capabilities.supportsVision,
    supportsNativePdf: config.capabilities.supportsNativePdf,
    supportsNativeAudio: config.capabilities.supportsNativeAudio,
    supportsReasoning: config.capabilities.supportsReasoning,
    supportsForcedToolChoice:
      protocol !== 'google-interactions' ||
      config.capabilities.supportsFunctionCalling,
    wireRouteKey,
    modelRetryRouteKey: JSON.stringify([wireRouteKey, config.fullName]),
    routedOnKimiCode: isKimiCodeExclusiveModel(config),
    backgroundCapable: backgroundCapable(built.configuration),
  };
});
