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

import { Effect, type Scope } from 'effect';
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';
import { anthropicMessagesModel } from '@texra-ai/llm/anthropic-messages';
import { googleInteractionsModel } from '@texra-ai/llm/google-interactions';
import {
  openaiResponsesModel,
  openaiResponsesWebSocketModel,
} from '@texra-ai/llm/openai-responses';
import { openrouterChatModel } from '@texra-ai/llm/openrouter-chat';
import {
  type Model,
  type ModelConfiguration,
  type ModelOrigin,
} from '@texra-ai/llm/turn';

import {
  bearerTransport,
  resolveModelRoute,
  resolveRouteCredential,
  resolveSubscriptionCredential,
  routeBearer,
  routeCompatibilityKey,
  withShortModelName,
  type RouteCredential,
} from '@agent/runtime/modelRoutes';
import { type ModelOptionStores } from '@model/computeModelOptions';
import {
  reasoningEffortOverrides,
  supportsReasoningLevel,
} from '@model/reasoningLevel';
import type { CopilotModelRoute } from '@model/copilotRouting';
import { routeConfig, type ModelRoute } from '@model/modelRoute';
import { longRunningModelFetch } from '@platform/defaults/longRunningModelTransport';
import type { StateStore } from '@platform/interfaces';
import { LanguageModel } from '@platform/languageModel';
import { OPENAI_DEFAULT_ENDPOINT } from '@shared/constants/modelProviderPlugins';
import {
  AgentCategory,
  type DeclinableUsageRoute,
  type ModelCompatibilityKey,
  type UsageRoute,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { ensureError } from '@utils/errors/errorMessage';
import { validationModel } from './validationModel';
import type { HttpClient } from 'effect/unstable/http';

/** Tool-use runs keep output headroom for context growth. */
const TOOL_USE_MAX_OUTPUT_FACTOR = 0.5;

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
  /** The route decision this binding carries out (the retry offer reads it). */
  readonly route: ModelRoute;
  readonly usageRoute: UsageRoute;
  /** The route's subscription plan, when it names one; display-only. */
  readonly usagePlan?: string;
  readonly contextWindow: number;
  readonly supportsVision: boolean;
  /** Mirror `config.capabilities`: the media pipeline reads these two. */
  readonly supportsNativePdf: boolean;
  readonly supportsNativeAudio: boolean;
  readonly supportsForcedToolChoice: boolean;
  /** The retry gate's keys: one wire route (provider, credential route,
   *  endpoint, key fingerprint), and that route narrowed to one model. */
  readonly wireRouteKey: string;
  readonly modelRetryRouteKey: string;
  /** The binding can run a turn as background work (submit + observe). */
  readonly backgroundCapable: boolean;
  /** One connection a failed turn invalidates (the Responses WebSocket): the
   *  invoker rebinds before it tries again. */
  readonly persistentConnection: boolean;
}

interface BindModelInput {
  readonly config: ModelConfig;
  /** Live settings from this run's session, plus the process secret store. */
  readonly stores: ModelOptionStores;
  /** A persisted conversation format wins over today's default route. */
  readonly compatibilityKey?: ModelCompatibilityKey | null;
  /** Own-key quota fallback also declines Copilot; seeds declinedRoutes. */
  readonly ownApiKeyFallback?: boolean;
  /** Declined routes persist on this run's ledger, not in user preferences. */
  readonly declinedRoutes?: readonly DeclinableUsageRoute[];
  readonly agentCategory: AgentCategory;
  /** The route default's temperature. */
  readonly temperature: number;
}

type Protocol = ModelConfiguration['protocol'];
/** The protocols the package constructs a model for; the editor's is the host's. */
type HttpProtocol = Exclude<Protocol, 'vscode-lm'>;
type HttpConfiguration = Exclude<ModelConfiguration, { protocol: 'vscode-lm' }>;
/** One protocol's configuration, keyed by the discriminant it carries. */
type ConfigurationOf<P extends HttpProtocol> = Extract<
  HttpConfiguration,
  { protocol: P }
>;

const PROTOCOL_BY_KEY: Record<ModelCompatibilityKey, Protocol | 'validation'> =
  {
    Validation: 'validation',
    OpenAIResponse: 'openai-responses',
    OpenRouterNative: 'openrouter-chat',
    VscodeLm: 'vscode-lm',
    Anthropic: 'anthropic-messages',
    OpenAI: 'openai-responses',
    GoogleInteractions: 'google-interactions',
    DeepSeek: 'openai-responses',
    XAI: 'openai-responses',
    Kimi: 'openai-responses',
    DashScope: 'openai-responses',
    MiniMax: 'openai-responses',
    GLM: 'openai-responses',
    Meta: 'openai-responses',
  };

/** A binding's {@link BoundModel.wireRouteKey} and model-scoped key. */
function routeKeys(wire: readonly string[], model: string) {
  const wireRouteKey = JSON.stringify(wire);
  return {
    wireRouteKey,
    modelRetryRouteKey: JSON.stringify([wireRouteKey, model]),
  };
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
 * What every protocol's configuration is derived from, computed once per bind:
 * the shared binding, the run's ceilings, and the effort and thinking facts
 * the arms read off the catalog and the live settings.
 */
interface BindingFacts {
  readonly config: ModelConfig;
  /** `config.capabilities`, which most arms read several fields of. */
  readonly capabilities: ModelConfig['capabilities'];
  readonly credential: RouteCredential;
  readonly input: BindModelInput;
  /** Requested model and deployment; only a route addressed under another
   *  name overrides it. */
  readonly base: ReturnType<typeof binding>;
  /**
   * The three request controls every OpenAI-descended route defaults from, in
   * the package's own order. An arm that clamps or fixes one overrides it
   * after the spread; an arm whose route takes only some of the three names
   * those, because a spread is not excess-property-checked and the package
   * parses its configuration strictly.
   */
  readonly controls: {
    readonly maxOutputTokens: number;
    readonly temperature: number | null;
    readonly parallelToolCalls: boolean;
  };
  readonly supportsTemperature: boolean;
  readonly effort: RouteEffort | null;
  readonly supportedEfforts: readonly RouteEffort[];
  readonly gpt5ReasoningSummary: boolean;
  readonly googleServerState: boolean;
  readonly thinkingMode: 'enabled' | 'disabled';
}

/**
 * Whether a bound configuration admits background work. `false` is a protocol
 * with no background mode at all, which is most of them; a predicate reads the
 * fact off the configuration the bind produced.
 */
type BackgroundRule<P extends HttpProtocol> =
  false | ((configuration: ConfigurationOf<P>) => boolean);

/**
 * What one HTTP protocol contributes: the configuration it binds over the
 * shared facts, the package factory its model comes from, and its background
 * stance. Three facts in one place, so a new provider is one entry instead of
 * an arm in each of three switches.
 */
interface ProtocolDescriptor<P extends HttpProtocol> {
  readonly configure: (facts: BindingFacts) => ConfigurationOf<P>;
  readonly construct: (
    configuration: ConfigurationOf<P>,
    credential: RouteCredential,
  ) => Model;
  readonly background: BackgroundRule<P>;
}

type ResponsesConfiguration = ConfigurationOf<'openai-responses'>;

/**
 * The Responses route of a vendor serving OpenAI's format on its own
 * endpoint: stateless unless the vendor stores and chains, no background,
 * socket, files or token count, and only the request fields it documents.
 * `null` for OpenAI, Meta and xAI, which the arm below binds.
 */
function vendorResponses(facts: BindingFacts): ResponsesConfiguration | null {
  const { base, config, capabilities, controls, effort, thinkingMode } = facts;
  const route = (
    fields: Pick<
      ResponsesConfiguration,
      | 'supportsTemperature'
      | 'supportsForcedToolChoice'
      | 'allowedReasoningEfforts'
    > & {
      readonly stores: boolean;
      readonly temperature: number | null;
      readonly reasoning: ResponsesConfiguration['defaults']['reasoning'];
    },
  ): ResponsesConfiguration => ({
    ...base,
    protocol: 'openai-responses',
    background: 'unsupported',
    supportsInputTokenEstimation: false,
    supportsTemperature: fields.supportsTemperature,
    supportsMaxOutputTokens: true,
    supportsStorage: fields.stores,
    supportsResponseChaining: fields.stores,
    supportsDocumentInput: false,
    webSocketStreamParameter: 'implicit',
    allowedReasoningEfforts: fields.allowedReasoningEfforts,
    instructions: { kind: 'optional' },
    continuationInheritsInstructions: false,
    supportsForcedToolChoice: fields.supportsForcedToolChoice,
    openaiEndpoint: false,
    requestDialect: 'compatible',
    defaults: {
      maxOutputTokens: controls.maxOutputTokens,
      temperature: fields.temperature,
      store: fields.stores,
      parallelToolCalls: controls.parallelToolCalls,
      reasoning: fields.reasoning,
      serviceTier: null,
    },
  });
  const reasoning = (
    value: ResponsesConfiguration['allowedReasoningEfforts'][number] | null,
  ) => ({ effort: value, mode: null, summary: null });
  switch (config.provider) {
    case ModelProvider.DEEPSEEK: {
      // `none` turns thinking off; thinking refuses a temperature.
      const thinkingEffort =
        effort === ReasoningEffort.LOW || effort === ReasoningEffort.MAX
          ? effort
          : ReasoningEffort.HIGH;
      return route({
        supportsTemperature: facts.supportsTemperature,
        supportsForcedToolChoice: true,
        allowedReasoningEfforts: ['none', 'low', 'high', 'max'],
        stores: false,
        temperature: controls.temperature,
        reasoning: reasoning(
          thinkingMode === 'disabled' ? 'none' : thinkingEffort,
        ),
      });
    }
    case ModelProvider.MOONSHOT:
      // Kimi fixes its sampling, always thinks, and takes only `auto`.
      return route({
        supportsTemperature: false,
        supportsForcedToolChoice: false,
        allowedReasoningEfforts: ['low', 'high', 'max'],
        stores: false,
        temperature: null,
        reasoning: reasoning(
          effort === ReasoningEffort.LOW ||
            effort === ReasoningEffort.HIGH ||
            effort === ReasoningEffort.MAX
            ? effort
            : null,
        ),
      });
    case ModelProvider.GLM:
      // Zhipu stores for seven days; `none` turns thinking off.
      return route({
        supportsTemperature: facts.supportsTemperature,
        supportsForcedToolChoice: false,
        allowedReasoningEfforts: [
          'none',
          'minimal',
          'low',
          'medium',
          'high',
          'xhigh',
          'max',
        ],
        stores: true,
        temperature:
          controls.temperature === null
            ? null
            : Math.min(1, controls.temperature),
        reasoning: reasoning(thinkingMode === 'disabled' ? 'none' : effort),
      });
    case ModelProvider.DASHSCOPE:
      // DashScope stores by default; Qwen keeps its own thinking default.
      return route({
        supportsTemperature: facts.supportsTemperature,
        supportsForcedToolChoice: false,
        allowedReasoningEfforts: [],
        stores: true,
        temperature: controls.temperature,
        reasoning: null,
      });
    case ModelProvider.MINIMAX:
      // M3 reasons only when asked; its temperature range is (0, 1].
      return route({
        supportsTemperature: true,
        supportsForcedToolChoice: false,
        allowedReasoningEfforts: ['high'],
        stores: false,
        temperature: Math.min(1, Math.max(0.01, facts.input.temperature)),
        reasoning: capabilities.supportsReasoning ? reasoning('high') : null,
      });
    default:
      return null;
  }
}

/**
 * One entry per protocol the package speaks. The mapped key set is the
 * exhaustiveness the three switches used to carry: a protocol added to
 * `ModelConfiguration` and left out here does not compile, and each entry's
 * configuration is checked against that protocol's own shape.
 */
const PROTOCOL_DESCRIPTORS: {
  readonly [P in HttpProtocol]: ProtocolDescriptor<P>;
} = {
  'anthropic-messages': {
    configure: ({
      base,
      capabilities,
      controls,
      supportsTemperature,
      effort,
    }) => ({
      ...base,
      protocol: 'anthropic-messages',
      supportsInputTokenEstimation: capabilities.supportsTokenCounting,
      supportsTemperature,
      supportsForcedToolChoice: true,
      supportsSystemMessages: capabilities.supportsIntermDevMsgs,
      defaults: {
        ...controls,
        parallelToolCalls: true,
        thinking: anthropicThinking(capabilities, controls.maxOutputTokens),
        effort: capabilities.supportsReasoningEffort ? effort : null,
        cache: capabilities.supportsPromptCaching ? '5m' : 'disabled',
        stopSequences: [],
      },
    }),
    construct: (configuration, credential) =>
      anthropicMessagesModel(configuration, bearerTransport(credential)),
    background: false,
  },
  'openai-responses': {
    configure: (facts) => {
      const vendor = vendorResponses(facts);
      if (vendor !== null) return vendor;
      const {
        base,
        config,
        capabilities,
        controls,
        credential,
        supportsTemperature,
        effort,
        supportedEfforts,
        gpt5ReasoningSummary,
      } = facts;
      // GPT-5 asks for a reasoning summary only when the user turned it on;
      // every other reasoning Responses model asks. `null` omits the field.
      const isGpt5 =
        config.name.startsWith('gpt5') || config.fullName.startsWith('gpt-5');
      const summary: 'auto' | null =
        !isGpt5 || gpt5ReasoningSummary ? 'auto' : null;
      if (credential.route === 'chatgpt-subscription') {
        let codexEffort: RouteEffort | null = effort;
        if (effort !== null && !CODEX_ALLOWED_EFFORTS.includes(effort)) {
          codexEffort = ReasoningEffort.MEDIUM;
        }
        return {
          ...base,
          requestedModel: credential.requestedModel,
          protocol: 'openai-responses',
          background: 'unsupported',
          supportsInputTokenEstimation: false,
          supportsTemperature,
          supportsMaxOutputTokens: false,
          supportsStorage: false,
          supportsResponseChaining: false,
          supportsDocumentInput: capabilities.supportsNativePdf,
          webSocketStreamParameter: 'required',
          allowedReasoningEfforts: [...CODEX_ALLOWED_EFFORTS],
          instructions: {
            kind: 'required',
            fallback: CODEX_DEFAULT_INSTRUCTIONS,
          },
          continuationInheritsInstructions: false,
          supportsForcedToolChoice: true,
          openaiEndpoint: true,
          requestDialect: 'openai',
          defaults: {
            maxOutputTokens: null,
            temperature: controls.temperature,
            store: false,
            parallelToolCalls: controls.parallelToolCalls,
            reasoning: capabilities.supportsReasoning
              ? {
                  effort: capabilities.supportsReasoningEffort
                    ? codexEffort
                    : null,
                  mode: capabilities.reasoningMode ?? null,
                  summary,
                }
              : null,
            serviceTier: null,
          },
        };
      }
      // xAI stores and chains too, but has no background mode, `max` effort
      // or summary control; a chained request reuses the stored instructions.
      const xai = config.provider === ModelProvider.XAI;
      const routeEffort = xai && effort === ReasoningEffort.MAX ? null : effort;
      return {
        ...base,
        protocol: 'openai-responses',
        background: xai ? 'unsupported' : 'supported',
        supportsInputTokenEstimation: false,
        supportsTemperature,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsResponseChaining: true,
        supportsDocumentInput: capabilities.supportsNativePdf,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: supportedEfforts.length
          ? supportedEfforts.filter(
              (value) => !xai || value !== ReasoningEffort.MAX,
            )
          : ['low', 'medium', 'high'],
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: xai,
        supportsForcedToolChoice: true,
        openaiEndpoint: config.provider === ModelProvider.OPENAI,
        requestDialect: 'openai',
        defaults: {
          maxOutputTokens: controls.maxOutputTokens,
          temperature: controls.temperature,
          // Stored server-side, which `previous_response_id` chaining and
          // background submission read; the Codex arm above is stateless.
          store: true,
          parallelToolCalls: controls.parallelToolCalls,
          reasoning: capabilities.supportsReasoning
            ? {
                effort: capabilities.supportsReasoningEffort
                  ? routeEffort
                  : null,
                mode: capabilities.reasoningMode ?? null,
                summary: xai ? null : summary,
              }
            : null,
          serviceTier: config.serviceTier ?? null,
        },
      };
    },
    construct: (configuration, credential) =>
      openaiResponsesModel(configuration, {
        authentication: responsesAuthentication(credential),
        fetch: longRunningModelFetch,
      }),
    background: (configuration) => configuration.background === 'supported',
  },
  'google-interactions': {
    configure: ({
      base,
      capabilities,
      controls,
      googleServerState,
      effort,
    }) => ({
      ...base,
      protocol: 'google-interactions',
      background: 'supported',
      supportsInputTokenEstimation: capabilities.supportsTokenCounting,
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        // Server-side conversation state is the user's choice: on, Google
        // holds the conversation and each round sends only the new turn
        // (and background execution becomes reachable); off, every round
        // resends the full transcript and nothing is retained.
        store: googleServerState,
        thinkingLevel:
          effort === 'low' || effort === 'medium' || effort === 'high'
            ? effort
            : 'high',
      },
    }),
    construct: (configuration, credential) =>
      googleInteractionsModel(configuration, bearerTransport(credential)),
    // Google retrieves a background result through server-side state.
    background: (configuration) =>
      configuration.background === 'supported' && configuration.defaults.store,
  },
  'openrouter-chat': {
    configure: ({
      base,
      config,
      capabilities,
      controls,
      supportsTemperature,
      supportedEfforts,
    }) => ({
      ...base,
      requestedModel:
        config.openrouterFullName ?? `${config.provider}/${config.fullName}`,
      protocol: 'openrouter-chat',
      supportsTemperature,
      supportsForcedToolChoice: true,
      supportsImageInput: capabilities.supportsVision,
      supportsAudioInput: capabilities.supportsNativeAudio,
      supportedEfforts: [...supportedEfforts],
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        temperature: controls.temperature,
        effort: capabilities.supportsReasoningEffort
          ? capabilities.reasoningEffort
          : null,
        stopSequences: [],
      },
    }),
    construct: (configuration, credential) =>
      openrouterChatModel(configuration, bearerTransport(credential)),
    background: false,
  },
};

/** The configuration one protocol binds, over the facts every arm shares. */
const configurationFor = Effect.fn('configurationFor')(function* (
  protocol: HttpProtocol,
  config: ModelConfig,
  credential: RouteCredential,
  input: BindModelInput,
) {
  const { capabilities } = config;
  const maxOutputTokens =
    input.agentCategory === AgentCategory.ToolUse
      ? Math.max(
          1,
          Math.floor(config.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR),
        )
      : config.maxOutputTokens;
  const supportsTemperature = !capabilities.supportsReasoning;
  return PROTOCOL_DESCRIPTORS[protocol].configure({
    config,
    capabilities,
    credential,
    input,
    base: binding(config, credential),
    gpt5ReasoningSummary:
      protocol === 'openai-responses' &&
      (yield* readSettingFrom<boolean>(
        input.stores,
        'texra.model.gpt5ReasoningSummary',
      )),
    googleServerState:
      protocol === 'google-interactions' &&
      (yield* readSettingFrom<boolean>(
        input.stores,
        'texra.model.useGoogleInteractionsServerState',
      )),
    controls: {
      maxOutputTokens,
      temperature: supportsTemperature ? input.temperature : null,
      // Every OpenAI-descended route honors this; Anthropic uses its default.
      parallelToolCalls: yield* readSettingFrom<boolean>(
        input.stores,
        'texra.model.openaiParallelToolCalls',
      ),
    },
    supportsTemperature,
    effort: routeEffort(capabilities.reasoningEffort),
    supportedEfforts: supportedRouteEfforts(config),
    thinkingMode: capabilities.supportsReasoning ? 'enabled' : 'disabled',
  });
});

/**
 * The model of one bound configuration, from its protocol's own factory; a
 * subscription token is the bearer where an API key would be, and the Codex
 * session additionally names its account. Generic in the protocol so the
 * table entry and the configuration handed to it stay the same arm.
 */
function constructModel<P extends HttpProtocol>(
  configuration: ConfigurationOf<P>,
  credential: RouteCredential,
): Model {
  return PROTOCOL_DESCRIPTORS[configuration.protocol].construct(
    configuration,
    credential,
  );
}

/** Whether a binding's configuration admits background work. */
function backgroundCapable<P extends HttpProtocol>(
  configuration: ConfigurationOf<P>,
): boolean {
  const rule = PROTOCOL_DESCRIPTORS[configuration.protocol].background;
  return rule === false ? false : rule(configuration);
}

/**
 * Whether this binding runs the Responses protocol over the persistent
 * WebSocket instead of HTTP. The user's opt-in, honored on the routes the
 * socket is served on: the ChatGPT-subscription backend, or OpenAI's own
 * endpoint (a per-model or dashboard endpoint may not speak it). Background
 * delivery still wins where both are selected, as it did before the binding
 * owned the choice.
 */
const responsesWebSocketSelected = Effect.fn('responsesWebSocketSelected')(
  function* (credential: RouteCredential, stores: SettingsStores) {
    if (
      !(yield* readSettingFrom<boolean>(
        stores,
        GlobalStateKey.WEBSOCKET_OPENAI,
      ))
    ) {
      return false;
    }
    return (
      credential.route === 'chatgpt-subscription' ||
      credential.endpoint === OPENAI_DEFAULT_ENDPOINT
    );
  },
);

/**
 * Whether a binding delivers its turns as background work: the run's
 * category and the provider's own toggle over a configuration that supports
 * it. One owner for the choice — the loop asks it per turn, and the binding
 * asks it to decide whether the Responses WebSocket applies. The toggles are
 * read live on every call through the catalog reader, so a flip mid-run takes
 * effect on the next turn, on the scope the Models tab shows (#12710).
 */
export const backgroundDelivery = Effect.fn('backgroundDelivery')(function* (
  bound: {
    readonly backgroundCapable: boolean;
    readonly protocol: ModelOrigin['protocol'];
    readonly modelName: string;
    readonly agentCategory: AgentCategory;
  },
  stores: SettingsStores,
) {
  if (!bound.backgroundCapable) return false;
  if (bound.agentCategory !== AgentCategory.Workflow) return false;
  if (bound.protocol === 'google-interactions') {
    return yield* readSettingFrom<boolean>(
      stores,
      'texra.model.useGoogleBackgroundResponses',
    );
  }
  return (
    bound.modelName.toLowerCase().startsWith('gpt') &&
    (yield* readSettingFrom<boolean>(
      stores,
      'texra.model.useBackgroundResponses',
    ))
  );
});

/** Bind a model the editor serves over the route its decision discovered
 *  (exact id, vendor and version), into the caller's scope. */
const bindEditorModel = Effect.fn('bindEditorModel')(function* (
  config: ModelConfig,
  compatibilityKey: ModelCompatibilityKey,
  route: CopilotModelRoute,
): Effect.fn.Return<BoundModel, Error, Scope.Scope | LanguageModel> {
  const editor = yield* LanguageModel;
  // The discovered route carries the editor's own context ceiling and the
  // subscription's pricing: the config the run accounts against.
  const routed = route.effectiveConfig;
  const requestedModel = route.reference.id;
  const deployment = {
    vendor: route.reference.vendor,
    version: route.version,
  } as const;
  const model = yield* editor.acquire({
    protocol: 'vscode-lm',
    requestedModel,
    deployment,
    supportsImageInput: routed.capabilities.supportsVision,
    supportsToolCalling: routed.capabilities.supportsFunctionCalling,
    defaults: { justification: 'Run the selected TeXRA agent.' },
  });
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
    route: { kind: 'copilot', route },
    usageRoute: 'api-key',
    contextWindow: routed.contextWindow,
    supportsVision: routed.capabilities.supportsVision,
    supportsNativePdf: false,
    supportsNativeAudio: false,
    supportsForcedToolChoice: false,
    ...routeKeys(
      ['vscode-lm', deployment.vendor, deployment.version],
      requestedModel,
    ),
    backgroundCapable: false,
    persistentConnection: false,
  };
});

/**
 * The user's per-model reasoning level, applied to the config the run binds
 * so the request default, the reported range and the accounting all read one
 * effort. Only models whose level is user-selectable honor it; every other
 * model keeps the catalog's effort.
 */
const withReasoningLevelOverride = Effect.fn('withReasoningLevelOverride')(
  function* (config: ModelConfig, globalState: StateStore) {
    if (!supportsReasoningLevel(config)) return config;
    const effort = (yield* reasoningEffortOverrides(globalState))[config.name];
    if (effort === undefined) return config;
    return {
      ...config,
      capabilities: { ...config.capabilities, reasoningEffort: effort },
    };
  },
);

/**
 * Bind one model for a run. The route is `resolveModelRoute`'s one decision,
 * and only the credential that route names is fetched; the persisted
 * compatibility key of a resumed conversation wins over today's default.
 */
export const bindModel = Effect.fn('bindModel')(function* (
  input: BindModelInput,
): Effect.fn.Return<
  BoundModel,
  Error,
  Scope.Scope | HttpClient.HttpClient | LanguageModel
> {
  // The wire identity the preference promises, applied to the bound config.
  const requested = yield* withShortModelName(input.config, input.stores);
  const route = yield* resolveModelRoute(input.stores, requested, input);
  const compatibilityKey =
    input.compatibilityKey ?? (yield* routeCompatibilityKey(requested, route));
  if (compatibilityKey === undefined) {
    return yield* Effect.fail(
      new Error(`Unsupported model provider: ${input.config.provider}`),
    );
  }
  const protocol = PROTOCOL_BY_KEY[compatibilityKey];
  if (protocol === 'vscode-lm' && route.kind === 'copilot') {
    return yield* bindEditorModel(requested, compatibilityKey, route.route);
  }
  if (protocol === 'validation') {
    const bound = validationModel(requested);
    return {
      modelId: requested.name,
      config: requested,
      compatibilityKey,
      model: bound.model,
      origin: bound.origin,
      route: { kind: 'validation' },
      usageRoute: 'api-key',
      contextWindow: requested.contextWindow,
      supportsVision: false,
      supportsNativePdf: false,
      supportsNativeAudio: false,
      supportsForcedToolChoice: true,
      ...routeKeys([requested.provider, 'validation'], requested.fullName),
      backgroundCapable: false,
      persistentConnection: false,
    };
  }
  if (
    protocol === 'vscode-lm' ||
    route.kind === 'copilot' ||
    route.kind === 'validation'
  ) {
    return yield* Effect.fail(
      new Error(
        `Model ${requested.name} routes through ${route.kind}, which the recorded ${compatibilityKey} format cannot bind.`,
      ),
    );
  }
  let config = yield* routeConfig(input.stores, requested, route);
  const credential: RouteCredential =
    route.kind === 'chatgpt-subscription' || route.kind === 'xai-subscription'
      ? yield* resolveSubscriptionCredential(
          config,
          route,
          input.stores.secrets,
        )
      : yield* resolveRouteCredential(
          input.stores,
          config,
          route,
          input.stores.secrets,
        );
  config = yield* withReasoningLevelOverride(config, input.stores.globalState);
  const configuration = yield* configurationFor(
    protocol,
    config,
    credential,
    input,
  );
  // Background delivery and the persistent WebSocket are alternatives on the
  // Responses protocol, and background wins where the user selected both.
  const onWebSocket =
    configuration.protocol === 'openai-responses' &&
    !(yield* backgroundDelivery(
      {
        backgroundCapable: backgroundCapable(configuration),
        protocol: configuration.protocol,
        modelName: config.name,
        agentCategory: input.agentCategory,
      },
      input.stores,
    )) &&
    (yield* responsesWebSocketSelected(credential, input.stores));
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
  // Uploads live only in this model's memory: they are deleted when the
  // binding's scope closes. A delete the provider refuses or leaves
  // unanswered is logged and left to the upload's own expiry.
  const release = model.releaseUploads;
  if (release !== undefined) {
    yield* Effect.addFinalizer(() =>
      release().pipe(
        Effect.flatMap((unreleased) =>
          unreleased.length === 0
            ? Effect.void
            : Effect.logWarning(
                `Could not delete ${unreleased.length} uploaded file(s) when the ${config.name} binding closed; the provider expires them on its own.`,
              ).pipe(Effect.annotateLogs({ unreleased })),
        ),
      ),
    );
  }
  const origin: ModelOrigin = {
    protocol: configuration.protocol,
    codecVersion: 1,
    requestedModel: configuration.requestedModel,
    deployment: configuration.deployment,
  } as ModelOrigin;
  return {
    modelId: config.name,
    config,
    compatibilityKey,
    model,
    origin,
    route,
    usageRoute: credential.usageRoute,
    ...(credential.route === 'chatgpt-subscription' && credential.plan
      ? { usagePlan: credential.plan }
      : {}),
    contextWindow: config.contextWindow,
    supportsVision: config.capabilities.supportsVision,
    supportsNativePdf: config.capabilities.supportsNativePdf,
    supportsNativeAudio: config.capabilities.supportsNativeAudio,
    supportsForcedToolChoice:
      configuration.protocol === 'openai-responses'
        ? configuration.supportsForcedToolChoice
        : protocol !== 'google-interactions' ||
          config.capabilities.supportsFunctionCalling,
    ...routeKeys(
      [
        config.provider,
        credential.route,
        credential.endpoint,
        credentialFingerprint(credential.route, routeBearer(credential)),
      ],
      config.fullName,
    ),
    // The socket carries one turn at a time and submits no background work.
    backgroundCapable: !onWebSocket && backgroundCapable(configuration),
    persistentConnection: onWebSocket,
  };
});
