/**
 * The run's model binding: one runtime `ModelConfig` plus the route
 * `modelRoutes` resolves, bound to the llm package `Model` the loop
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
import {
  MODEL_CONFIGS,
  ModelProvider,
  ReasoningEffort,
  type ModelConfig,
} from 'llm-zoo';

import {
  resolveModelCompatibilityKey,
  resolveRouteCredential,
  resolveSubscriptionCredential,
  routeBearer,
  withShortModelName,
  type RouteCredential,
} from '@agent/runtime/modelRoutes';
import { OPENAI_DEFAULT_ENDPOINT } from '@agent/runtime/run/routeEndpoint';
import { anthropicMessagesModel } from '@llm/anthropicMessages';
import { googleInteractionsModel } from '@llm/googleInteractions';
import { openaiChatModel } from '@llm/openaiChat';
import {
  openaiResponsesModel,
  openaiResponsesWebSocketModel,
} from '@llm/openaiResponses';
import { openrouterChatModel } from '@llm/openrouterChat';
import {
  type Model,
  type ModelConfiguration,
  type ModelError,
  type ModelOrigin,
  type VscodeLanguageModelConfiguration,
} from '@llm/turn';
import type { ModelOptionStores } from '@model/computeModelOptions';
import {
  reasoningEffortOverrides,
  supportsReasoningLevel,
} from '@model/reasoningLevel';
import { copilotRouteForModel } from '@model/runtimeModelRegistry';
import {
  kimiCodeEffectiveConfig,
  resolveKimiCodeRoutingFacts,
} from '@model/kimiCodeSubscriptionRouting';
import { isOpenRouterRoutingUnsupported } from '@model/openRouterRouting';
import type { StateStore } from '@platform/interfaces';
import {
  AgentCategory,
  type DeclinableUsageRoute,
  type ModelCompatibilityKey,
  type UsageRoute,
} from '@shared/schemas';
import {
  isKimiCodeExclusiveModel,
  isKimiSubscriptionEligible,
} from '@shared/model/kimiCodeRetryGate';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { getConfig } from '@utils/config/configUtils';
import { getUseOpenRouter } from '@utils/config/providerConfig';
import { ensureError } from '@utils/errors/errorMessage';
import { validationModel } from './validationModel';

/** Tool-use runs keep output headroom for context growth. */
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

/**
 * The efforts a wire route can be asked for: llm-zoo's vocabulary minus the
 * two that mean "ask for none". The catalog's effort is already llm-zoo's
 * enum, so no re-parse stands between the catalog and the request.
 */
type RouteEffort = Exclude<
  ReasoningEffort,
  ReasoningEffort.NONE | ReasoningEffort.MINIMAL
>;

function routeEffort(effort: ReasoningEffort | undefined): RouteEffort | null {
  return effort === undefined ||
    effort === ReasoningEffort.NONE ||
    effort === ReasoningEffort.MINIMAL
    ? null
    : effort;
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
  readonly compatibilityKey: ModelCompatibilityKey;
  readonly model: Model;
  readonly origin: ModelOrigin;
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
  readonly compatibilityKey?: ModelCompatibilityKey | null;
  /**
   * This launch is the user's own-API-key fallback: they answered a quota
   * prompt with "use my own API key", so the editor's Copilot route is not
   * taken for it either. Seeds {@link BindModelInput.declinedRoutes}.
   */
  readonly ownApiKeyFallback?: boolean;
  /**
   * Subscription routes this run declines. Run-scoped: the route the user
   * turned away from on a retry, carried on the run's ledger state instead
   * of rewritten into their stored preference.
   */
  readonly declinedRoutes?: readonly DeclinableUsageRoute[];
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

const PROTOCOL_BY_KEY: Record<ModelCompatibilityKey, Protocol | 'validation'> =
  {
    Validation: 'validation',
    OpenAIResponse: 'openai-responses',
    OpenRouterNative: 'openrouter-chat',
    VscodeLm: 'vscode-lm',
    Anthropic: 'anthropic-messages',
    OpenAI: 'openai-chat',
    GoogleInteractions: 'google-interactions',
    DeepSeek: 'deepseek-chat',
    XAI: 'xai-chat',
    Kimi: 'kimi-chat',
    DashScope: 'dashscope-chat',
    MiniMax: 'minimax-chat',
    GLM: 'glm-chat',
    Meta: 'openai-responses',
  };

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

/**
 * Moonshot API `fullName`s shared by a reasoning and a non-reasoning registry
 * entry (`kimi26`/`kimi26T` both wire to `kimi-k2.6`), distinguished only by
 * TeXRA's `supportsReasoning`. Moonshot defaults these wire names to thinking
 * on, so both entries send the toggle explicitly; every other Kimi model
 * leaves thinking to the wire default. Computed from the live catalog so a
 * later shared-name family needs no new literal.
 */
const AMBIGUOUS_MOONSHOT_FULL_NAMES: ReadonlySet<string> = (() => {
  const supportsReasoningByFullName = new Map<string, boolean>();
  const ambiguous = new Set<string>();
  for (const config of Object.values(MODEL_CONFIGS)) {
    if (config.provider !== ModelProvider.MOONSHOT) continue;
    const seen = supportsReasoningByFullName.get(config.fullName);
    if (seen !== undefined && seen !== config.capabilities.supportsReasoning) {
      ambiguous.add(config.fullName);
    }
    supportsReasoningByFullName.set(
      config.fullName,
      config.capabilities.supportsReasoning,
    );
  }
  return ambiguous;
})();

type KimiThinkingControl = Extract<
  ModelConfiguration,
  { protocol: 'kimi-chat' }
>['thinkingControl'];

function kimiThinkingControl(config: ModelConfig): KimiThinkingControl {
  if (AMBIGUOUS_MOONSHOT_FULL_NAMES.has(config.fullName)) return 'toggle';
  return config.capabilities.supportsReasoning ? 'always' : 'toggle';
}

/**
 * Sampling Moonshot fixes per wire name, thinking on and off: `null` is a
 * temperature the API requires omitted. Applies to direct requests and to
 * requests forwarded through OpenRouter alike.
 */
const KIMI_FIXED_TEMPERATURES: ReadonlyMap<
  string,
  { readonly enabled: number | null; readonly disabled: number | null }
> = new Map([
  ['kimi-k2.5', { enabled: 1, disabled: 0.6 }],
  ['kimi-k2.7-code', { enabled: 1, disabled: 1 }],
  ['kimi-for-coding', { enabled: 1, disabled: 1 }],
  ['kimi-for-coding-highspeed', { enabled: 1, disabled: 1 }],
  ['kimi-k3', { enabled: null, disabled: null }],
  ['k3', { enabled: null, disabled: null }],
]);

function kimiTemperatureByThinking(
  config: ModelConfig,
  temperature: number,
): { readonly enabled: number | null; readonly disabled: number | null } {
  return (
    KIMI_FIXED_TEMPERATURES.get(config.fullName) ?? {
      enabled: 1,
      disabled: temperature,
    }
  );
}

/** Instructions the Codex backend requires when the request carries none. */
const CODEX_DEFAULT_INSTRUCTIONS = "Follow the user's instructions.";

/**
 * The Codex backend runs every turn synchronously on one connection, so an
 * effort above medium risks the client timing out before it answers.
 */
const CODEX_ALLOWED_EFFORTS: readonly RouteEffort[] = [
  ReasoningEffort.LOW,
  ReasoningEffort.MEDIUM,
];

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
            ? capabilities.reasoningEffort
            : null,
        },
      };
    case 'openai-responses':
      if (credential.route === 'chatgpt-subscription') {
        let codexEffort: RouteEffort | null = effort;
        if (effort !== null && !CODEX_ALLOWED_EFFORTS.includes(effort)) {
          codexEffort = ReasoningEffort.MEDIUM;
        }
        return {
          ...base,
          requestedModel: credential.requestedModel,
          protocol,
          background: 'unsupported',
          supportsInputTokenEstimation: false,
          supportsTemperature,
          supportsMaxOutputTokens: false,
          supportsStorage: false,
          supportsResponseChaining: false,
          webSocketStreamParameter: 'required',
          allowedReasoningEfforts: [...CODEX_ALLOWED_EFFORTS],
          instructions: {
            kind: 'required',
            fallback: CODEX_DEFAULT_INSTRUCTIONS,
          },
          defaults: {
            maxOutputTokens: null,
            temperature: supportsTemperature ? input.temperature : null,
            store: false,
            parallelToolCalls: true,
            reasoning: capabilities.supportsReasoning
              ? {
                  effort: capabilities.supportsReasoningEffort
                    ? codexEffort
                    : null,
                  mode: capabilities.reasoningMode ?? null,
                  summary: 'auto',
                }
              : null,
            serviceTier: null,
          },
        };
      }
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
        // Moonshot's own endpoint counts tokens; a managed coding endpoint
        // opts in through the catalog.
        supportsInputTokenEstimation:
          !isKimiCodeExclusiveModel(config) ||
          capabilities.supportsTokenCounting,
        thinkingControl: kimiThinkingControl(config),
        supportedEfforts: [...supportedEfforts],
        supportsForcedToolChoice: true,
        temperatureByThinking: kimiTemperatureByThinking(
          config,
          input.temperature,
        ),
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
      const xaiEffort = effort === ReasoningEffort.MAX ? null : effort;
      return {
        ...base,
        protocol,
        supportsImageInput: capabilities.supportsVision,
        supportedEfforts: supportedEfforts.filter(
          (value): value is Exclude<RouteEffort, ReasoningEffort.MAX> =>
            value !== ReasoningEffort.MAX,
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
            ? capabilities.reasoningEffort
            : null,
          stopSequences: [],
        },
      };
  }
}

type ResponsesAuthentication = Parameters<
  typeof openaiResponsesWebSocketModel
>[1];

/** The Responses bearer: a subscription token names its account, a key does not. */
function responsesAuthentication(
  credential: RouteCredential,
): ResponsesAuthentication {
  return credential.route === 'chatgpt-subscription'
    ? {
        kind: 'codex',
        accessToken: credential.accessToken,
        accountId: credential.accountId,
      }
    : { kind: 'api-key', apiKey: routeBearer(credential) };
}

/**
 * Whether this binding runs the Responses protocol over the persistent
 * WebSocket instead of HTTP. The user's opt-in, honored on the routes the
 * socket is served on: the ChatGPT-subscription backend, or OpenAI's own
 * endpoint (a per-model or dashboard endpoint may not speak it). Background
 * delivery still wins where both are selected, as it did before the binding
 * owned the choice.
 */
function responsesWebSocketSelected(
  credential: RouteCredential,
  globalState: StateStore,
): boolean {
  if (!globalState.get<boolean>(GlobalStateKey.WEBSOCKET_OPENAI, false)) {
    return false;
  }
  return (
    credential.route === 'chatgpt-subscription' ||
    credential.endpoint === OPENAI_DEFAULT_ENDPOINT
  );
}

/**
 * One constructor per protocol; a subscription token is the bearer where an
 * API key would be, and the Codex session additionally names its account.
 */
function constructModel(
  configuration: HttpConfiguration,
  credential: RouteCredential,
): Model {
  const apiKey = routeBearer(credential);
  switch (configuration.protocol) {
    case 'anthropic-messages':
      return anthropicMessagesModel(configuration, { apiKey });
    case 'openai-responses':
      return openaiResponsesModel(configuration, {
        authentication: responsesAuthentication(credential),
      });
    case 'google-interactions':
      return googleInteractionsModel(configuration, { apiKey });
    case 'openrouter-chat':
      return openrouterChatModel(configuration, { apiKey });
    case 'openai-chat':
    case 'deepseek-chat':
    case 'kimi-chat':
    case 'glm-chat':
    case 'xai-chat':
    case 'dashscope-chat':
    case 'minimax-chat':
      return openaiChatModel(configuration, { apiKey });
  }
}

/**
 * Whether a binding delivers its turns as background work: the run's
 * category and the provider's own toggle over a configuration that supports
 * it. One owner for the choice — the loop asks it per turn, and the binding
 * asks it to decide whether the Responses WebSocket applies.
 */
export function backgroundDelivery(bound: {
  readonly backgroundCapable: boolean;
  readonly protocol: ModelOrigin['protocol'];
  readonly modelName: string;
  readonly agentCategory: AgentCategory;
}): boolean {
  if (!bound.backgroundCapable) return false;
  if (bound.agentCategory !== AgentCategory.Workflow) return false;
  if (bound.protocol === 'google-interactions') {
    return getConfig<boolean>('texra.model.useGoogleBackgroundResponses');
  }
  return (
    bound.modelName.toLowerCase().startsWith('gpt') &&
    getConfig<boolean>('texra.model.useBackgroundResponses')
  );
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
  compatibilityKey: ModelCompatibilityKey,
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
 * The user's per-model reasoning level, applied to the config the run binds
 * so the request default, the reported range and the accounting all read one
 * effort. Only models whose level is user-selectable honor it; every other
 * model keeps the catalog's effort.
 */
function withReasoningLevelOverride(
  config: ModelConfig,
  globalState: StateStore,
): ModelConfig {
  if (!supportsReasoningLevel(config)) return config;
  const effort = reasoningEffortOverrides(globalState)[config.name];
  if (effort === undefined) return config;
  return {
    ...config,
    capabilities: { ...config.capabilities, reasoningEffort: effort },
  };
}

/**
 * Bind one model for a run. The route is `resolveRouteCredential`'s
 * decision, read through the same resolver every other route reader uses;
 * the persisted compatibility key of a resumed conversation wins over
 * today's default.
 */
export const bindModel = Effect.fn('bindModel')(function* (
  input: BindModelInput,
): Effect.fn.Return<BoundModel, Error, Scope.Scope> {
  const useOpenRouter = getUseOpenRouter();
  // The wire identity the preference promises, applied to the bound config
  // and not only to the route decision below (which re-applies it as
  // identity), so the request carries the unpinned identifier.
  const requested = withShortModelName(input.config, input.stores.globalState);
  const compatibilityKey =
    input.compatibilityKey ??
    (yield* Effect.try({
      try: () =>
        resolveModelCompatibilityKey(
          requested,
          input.stores.globalState,
          useOpenRouter,
          input.ownApiKeyFallback,
        ),
      catch: ensureError,
    }));
  if (compatibilityKey === undefined) {
    return yield* Effect.fail(
      new Error(`Unsupported model provider: ${input.config.provider}`),
    );
  }
  // The OpenRouter choice this binding answers to: a resumed conversation
  // keeps the route its persisted format names, a fresh one follows the live
  // preference. Read before the editor branch so a mode-selected model is
  // rejected on the route the picker already reports as unavailable.
  const selectedOpenRouter =
    input.compatibilityKey == null
      ? useOpenRouter
      : compatibilityKey === 'OpenRouterNative';
  if (
    compatibilityKey !== 'Validation' &&
    isOpenRouterRoutingUnsupported(requested, selectedOpenRouter)
  ) {
    return yield* Effect.fail(
      new Error(
        `Model ${requested.name} requires reasoning mode ${requested.capabilities.reasoningMode}, which OpenRouter does not support. Disable OpenRouter and use the provider API directly.`,
      ),
    );
  }
  const protocol = PROTOCOL_BY_KEY[compatibilityKey];
  if (protocol === 'vscode-lm') {
    return yield* bindEditorModel(requested, compatibilityKey);
  }
  const onOpenRouter = compatibilityKey === 'OpenRouterNative';
  let config = requested;
  if (compatibilityKey === 'Kimi' && isKimiSubscriptionEligible(config)) {
    config = yield* Effect.tryPromise({
      try: () =>
        input.inScope(async () =>
          kimiCodeEffectiveConfig(
            config,
            await resolveKimiCodeRoutingFacts(
              input.stores.secrets,
              onOpenRouter,
              input.declinedRoutes,
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
  // The ChatGPT session serves the Responses protocol and the Grok session
  // the xAI Chat protocol, so the subscription route is asked only there;
  // `constructModel` can then hand a subscription token to no other
  // protocol's constructor. Eligibility follows `selectedOpenRouter`: a fresh
  // binding honors the live preference (a Responses model whose route stays
  // direct must still not consume the subscription the picker reports as
  // disabled), while a resumed conversation keeps the route its persisted
  // format names instead of silently billing the provider key because the
  // preference was turned on since.
  const subscription =
    protocol === 'openai-responses' || protocol === 'xai-chat'
      ? yield* Effect.tryPromise({
          try: () =>
            input.inScope(() =>
              resolveSubscriptionCredential(
                config,
                selectedOpenRouter,
                input.declinedRoutes,
              ),
            ),
          catch: ensureError,
        })
      : null;
  let credential: RouteCredential;
  if (subscription !== null) {
    config = subscription.config;
    credential = subscription.credential;
  } else {
    credential = yield* Effect.tryPromise({
      try: () =>
        input.inScope(() =>
          resolveRouteCredential(
            config,
            onOpenRouter,
            input.stores.secrets,
            input.declinedRoutes,
          ),
        ),
      catch: ensureError,
    });
  }
  config = withReasoningLevelOverride(config, input.stores.globalState);
  const configuration = yield* Effect.try({
    try: () => configurationFor(protocol, config, credential, input),
    catch: ensureError,
  });
  // Background delivery and the persistent WebSocket are alternatives on the
  // Responses protocol, and background wins where the user selected both.
  const onWebSocket =
    configuration.protocol === 'openai-responses' &&
    !backgroundDelivery({
      backgroundCapable: backgroundCapable(configuration),
      protocol: configuration.protocol,
      modelName: config.name,
      agentCategory: input.agentCategory,
    }) &&
    responsesWebSocketSelected(credential, input.stores.globalState);
  const model =
    configuration.protocol === 'openai-responses' && onWebSocket
      ? yield* openaiResponsesWebSocketModel(
          configuration,
          responsesAuthentication(credential),
        ).pipe(Effect.mapError(ensureError))
      : yield* Effect.try({
          try: () => constructModel(configuration, credential),
          catch: ensureError,
        });
  const origin: ModelOrigin = {
    protocol: configuration.protocol,
    codecVersion: 1,
    requestedModel: configuration.requestedModel,
    deployment: configuration.deployment,
  } as ModelOrigin;
  const wireRouteKey = JSON.stringify([
    config.provider,
    credential.route,
    credential.endpoint,
    credentialFingerprint(credential.route, routeBearer(credential)),
  ]);
  return {
    modelId: config.name,
    config,
    compatibilityKey,
    model,
    origin,
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
    // The socket carries one turn at a time and submits no background work.
    backgroundCapable: !onWebSocket && backgroundCapable(configuration),
  };
});
