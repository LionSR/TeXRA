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
import {
  acceptedEfforts,
  type Model,
  type ModelConfiguration,
  type ModelOrigin,
  type ModelRoute,
  OPENAI_DEFAULT_ENDPOINT,
  originOf,
  type ReasoningChoice,
  type ReasoningRequest,
  routeConfig,
  selectModel,
  wireEffort,
} from '@texra-ai/llm';
import {
  bindModel as bindWireModel,
  type ModelCredential,
} from '@texra-ai/llm/node';

import {
  resolveModelRoute,
  resolveRouteCredential,
  resolveSubscriptionCredential,
  routeBearer,
  routeCompatibilityKey,
  withShortModelName,
  type RouteCredential,
} from '@agent/runtime/modelRoutes';
import { type ModelOptionStores } from '@model/computeModelOptions';
import { CODEX_ROUTE_EFFORTS, reasoningFor } from '@model/reasoningLevel';
import type { CopilotModelRoute } from '@model/copilotRouting';
import { longRunningModelFetch } from '@platform/defaults/longRunningModelTransport';
import { LanguageModel } from '@platform/languageModel';
import {
  AgentCategory,
  MODEL_RETRY_MAX_ATTEMPTS_SETTING,
  type DeclinableUsageRoute,
  type ModelCompatibilityKey,
  type UsageRoute,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSettingFrom } from '@utils/config/platformSettings';
import { validationModel } from './validationModel';
import type { HttpClient } from 'effect/http';

/** Tool-use runs keep output headroom for context growth. */
const TOOL_USE_MAX_OUTPUT_FACTOR = 0.5;

/** The runtime facts of one bound model that the package does not carry. */
export interface BoundModel {
  /** The run's model string (`provider/id[@effort][+pro]`), as every snapshot names it. */
  readonly modelId: string;
  readonly config: ModelConfig;
  /** What this binding asks the model for: thinking, effort and mode, and any level it substituted. */
  readonly reasoning: ReasoningChoice;
  /** The service tier the requests are sent on, which pricing bills. */
  readonly serviceTier?: 'fast';
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
  /** Automatic retries after a failed attempt, the user's setting read once
   *  with the binding: the invoker takes it from here, and a rebind (a
   *  manual retry, a model switch, a resume) reads it again. */
  readonly automaticRetries: number;
}

interface BindModelInput {
  /** The run's model string, as stored; it also carries the effort, thinking and mode asked for. */
  readonly modelId: string;
  /** The config to bind: a route's overlay, else the catalog entry the model string names. */
  readonly config?: ModelConfig;
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

/** The wire protocol each conversation format binds. */
export const PROTOCOL_BY_KEY: Readonly<
  Record<ModelCompatibilityKey, Protocol | 'validation'>
> = {
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
    requestedModel: config.id,
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
  config: ModelConfig,
  reasoning: ReasoningChoice,
  maxOutputTokens: number,
): AnthropicThinking {
  if (!reasoning.thinking) return { mode: 'disabled' };
  if (!config.reasoning?.budget) {
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

/** The bearer a route sends: a subscription token names its account, a key does not. */
function modelCredential(credential: RouteCredential): ModelCredential {
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
  /** The one reasoning decision this bind carries out. */
  readonly reasoning: ReasoningChoice;
  /** The effort values the model accepts on the wire (see {@link acceptedEfforts}). */
  readonly acceptedEfforts: readonly ReasoningEffort[];
  readonly gpt5ReasoningSummary: boolean;
  readonly googleServerState: boolean;
  /** The user runs OpenAI models on the fast service tier where it is offered. */
  readonly fastTier: boolean;
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
 * shared facts, and its background stance. The package's `bindModel` builds
 * the model from the configuration, so a new provider is one entry here.
 */
interface ProtocolDescriptor<P extends HttpProtocol> {
  readonly configure: (facts: BindingFacts) => ConfigurationOf<P>;
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
  const { base, config, controls, reasoning: choice } = facts;
  const effort = wireEffort(config, choice);
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
    supportsTemperature: fields.supportsTemperature,
    supportsMaxOutputTokens: true,
    supportsStorage: fields.stores,
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
    case ModelProvider.DEEPSEEK:
      // `none` turns thinking off; thinking refuses a temperature.
      return route({
        supportsTemperature: facts.supportsTemperature,
        supportsForcedToolChoice: true,
        allowedReasoningEfforts: facts.acceptedEfforts,
        stores: false,
        temperature: controls.temperature,
        reasoning: reasoning(effort),
      });
    case ModelProvider.MOONSHOT:
      // Kimi fixes its sampling. Its `thinking` switch is not part of this
      // request shape, so `@none` is refused here (`routeReasoning`).
      return route({
        supportsTemperature: false,
        supportsForcedToolChoice: false,
        allowedReasoningEfforts: config.reasoning?.efforts ?? [],
        stores: false,
        temperature: null,
        reasoning: reasoning(choice.effort),
      });
    case ModelProvider.GLM:
      // Zhipu stores for seven days; `none` turns thinking off.
      return route({
        supportsTemperature: facts.supportsTemperature,
        supportsForcedToolChoice: false,
        allowedReasoningEfforts: facts.acceptedEfforts,
        stores: true,
        temperature:
          controls.temperature === null
            ? null
            : Math.min(1, controls.temperature),
        reasoning: reasoning(effort),
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
        reasoning: choice.thinking ? reasoning('high') : null,
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
      config,
      capabilities,
      controls,
      supportsTemperature,
      reasoning,
    }) => ({
      ...base,
      protocol: 'anthropic-messages',
      supportsTemperature,
      supportsForcedToolChoice: true,
      supportsSystemMessages: capabilities.supportsIntermDevMsgs,
      defaults: {
        ...controls,
        parallelToolCalls: true,
        thinking: anthropicThinking(
          config,
          reasoning,
          controls.maxOutputTokens,
        ),
        // Anthropic has no `none` or `minimal`: off is the thinking switch.
        effort:
          reasoning.effort === ReasoningEffort.NONE ||
          reasoning.effort === ReasoningEffort.MINIMAL
            ? null
            : reasoning.effort,
        cache: capabilities.supportsPromptCaching ? '5m' : 'disabled',
        stopSequences: [],
      },
    }),
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
        reasoning: choice,
        gpt5ReasoningSummary,
      } = facts;
      const effort = wireEffort(config, choice);
      // GPT-5 asks for a reasoning summary only when the user turned it on;
      // every other reasoning Responses model asks. `null` omits the field.
      const isGpt5 = config.id.startsWith('gpt-5');
      const summary: 'auto' | null =
        !isGpt5 || gpt5ReasoningSummary ? 'auto' : null;
      const reasoning =
        config.reasoning === undefined
          ? null
          : { effort, mode: choice.mode, summary };
      if (credential.route === 'chatgpt-subscription') {
        return {
          ...base,
          requestedModel: credential.requestedModel,
          protocol: 'openai-responses',
          background: 'unsupported',
          supportsTemperature,
          supportsMaxOutputTokens: false,
          supportsStorage: false,
          supportsDocumentInput: capabilities.supportsNativePdf,
          webSocketStreamParameter: 'required',
          allowedReasoningEfforts: facts.acceptedEfforts.filter(
            (value) =>
              value === ReasoningEffort.NONE ||
              CODEX_ROUTE_EFFORTS.includes(value),
          ),
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
            reasoning,
            serviceTier: null,
          },
        };
      }
      // xAI stores and chains too, but has no background mode or summary
      // control; a chained request reuses the stored instructions.
      const xai = config.provider === ModelProvider.XAI;
      return {
        ...base,
        protocol: 'openai-responses',
        background: xai ? 'unsupported' : 'supported',
        supportsTemperature,
        supportsMaxOutputTokens: true,
        supportsStorage: true,
        supportsDocumentInput: capabilities.supportsNativePdf,
        webSocketStreamParameter: 'implicit',
        allowedReasoningEfforts: facts.acceptedEfforts,
        instructions: { kind: 'optional' },
        continuationInheritsInstructions: xai,
        supportsForcedToolChoice: true,
        openaiEndpoint: credential.endpoint === OPENAI_DEFAULT_ENDPOINT,
        requestDialect: 'openai',
        defaults: {
          maxOutputTokens: controls.maxOutputTokens,
          temperature: controls.temperature,
          // Stored server-side, which `previous_response_id` chaining and
          // background submission read; the Codex arm above is stateless.
          store: true,
          parallelToolCalls: controls.parallelToolCalls,
          reasoning:
            reasoning === null || !xai
              ? reasoning
              : { ...reasoning, summary: null },
          serviceTier: facts.fastTier && config.tiers?.fast ? 'fast' : null,
        },
      };
    },
    background: (configuration) => configuration.background === 'supported',
  },
  'google-interactions': {
    configure: ({
      base,
      capabilities,
      controls,
      googleServerState,
      reasoning,
    }) => ({
      ...base,
      protocol: 'google-interactions',
      background: 'supported',
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        // Server-side conversation state is the user's choice: on, Google
        // holds the conversation and each round sends only the new turn
        // (and background execution becomes reachable); off, every round
        // resends the full transcript and nothing is retained.
        store: googleServerState,
        // A Gemini model without levels (2.5, budget-controlled) keeps the
        // level this route has always sent.
        thinkingLevel:
          reasoning.effort === 'minimal' ||
          reasoning.effort === 'low' ||
          reasoning.effort === 'medium' ||
          reasoning.effort === 'high'
            ? reasoning.effort
            : 'high',
      },
    }),
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
      reasoning,
      acceptedEfforts: supportedEfforts,
    }) => ({
      ...base,
      requestedModel:
        config.openrouterFullName ?? `${config.provider}/${config.id}`,
      protocol: 'openrouter-chat',
      supportsTemperature,
      supportsForcedToolChoice: true,
      supportsImageInput: capabilities.supportsVision,
      supportsAudioInput: capabilities.supportsNativeAudio,
      supportedEfforts: [...supportedEfforts],
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        temperature: controls.temperature,
        effort: wireEffort(config, reasoning),
        stopSequences: [],
      },
    }),
    background: false,
  },
};

/** The configuration one protocol binds, over the facts every arm shares. */
const configurationFor = Effect.fn('configurationFor')(function* (
  protocol: HttpProtocol,
  config: ModelConfig,
  credential: RouteCredential,
  input: BindModelInput,
  reasoning: ReasoningChoice,
) {
  const maxOutputTokens =
    input.agentCategory === AgentCategory.ToolUse
      ? Math.max(
          1,
          Math.floor(config.maxOutputTokens * TOOL_USE_MAX_OUTPUT_FACTOR),
        )
      : config.maxOutputTokens;
  // A request that does not think is sampled at the run's temperature (the
  // helper model runs at 0), except on an OpenAI reasoning model, which
  // refuses a temperature even at effort `none`.
  const supportsTemperature =
    !reasoning.thinking &&
    !(
      config.provider === ModelProvider.OPENAI && config.reasoning !== undefined
    );
  return PROTOCOL_DESCRIPTORS[protocol].configure({
    config,
    capabilities: config.capabilities,
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
    reasoning,
    acceptedEfforts: acceptedEfforts(config),
    fastTier:
      protocol === 'openai-responses' &&
      (yield* readSettingFrom<boolean>(
        input.stores,
        'texra.model.openaiFastTier',
      )),
  });
});

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
  modelId: string,
  compatibilityKey: ModelCompatibilityKey,
  route: CopilotModelRoute,
  reasoning: ReasoningChoice,
  automaticRetries: number,
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
    modelId,
    config: routed,
    reasoning,
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
    automaticRetries,
  };
});

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
  const selected = selectModel(input.modelId);
  const catalog = input.config ?? selected?.config;
  if (catalog === undefined) {
    return yield* Effect.fail(
      new Error(`Model ${input.modelId} is not registered`),
    );
  }
  const request: ReasoningRequest = selected?.request ?? {};
  const automaticRetries = yield* readSettingFrom<number>(
    input.stores,
    MODEL_RETRY_MAX_ATTEMPTS_SETTING.configKey,
  );
  // The wire identity the preference promises, applied to the bound config;
  // a request in a provider mode (OpenAI `pro`) keeps the pinned id.
  const requested =
    request.mode === undefined
      ? yield* withShortModelName(catalog, input.stores)
      : catalog;
  const { route, facts } = yield* resolveModelRoute(input.stores, requested, {
    ...input,
    mode: request.mode,
  });
  const compatibilityKey =
    input.compatibilityKey ?? (yield* routeCompatibilityKey(requested, route));
  if (compatibilityKey === undefined) {
    return yield* Effect.fail(
      new Error(`Unsupported model provider: ${catalog.provider}`),
    );
  }
  const protocol = PROTOCOL_BY_KEY[compatibilityKey];
  if (protocol === 'vscode-lm' && route.kind === 'copilot') {
    // The editor manages its own reasoning; the choice is recorded, not sent.
    return yield* bindEditorModel(
      input.modelId,
      compatibilityKey,
      route.route,
      yield* reasoningFor(requested, request, input.stores.globalState, {
        protocol,
        codexSubscription: false,
      }),
      automaticRetries,
    );
  }
  if (protocol === 'validation') {
    const bound = validationModel(requested);
    return {
      modelId: input.modelId,
      config: requested,
      reasoning: yield* reasoningFor(
        requested,
        request,
        input.stores.globalState,
        { protocol, codexSubscription: false },
      ),
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
      ...routeKeys([requested.provider, 'validation'], requested.id),
      backgroundCapable: false,
      persistentConnection: false,
      automaticRetries,
    };
  }
  if (
    protocol === 'vscode-lm' ||
    route.kind === 'copilot' ||
    route.kind === 'validation'
  ) {
    return yield* Effect.fail(
      new Error(
        `Model ${input.modelId} routes through ${route.kind}, which the recorded ${compatibilityKey} format cannot bind.`,
      ),
    );
  }
  const config = routeConfig(requested, route, facts);
  const credential: RouteCredential =
    route.kind === 'chatgpt-subscription' || route.kind === 'xai-subscription'
      ? yield* resolveSubscriptionCredential(
          config,
          route,
          input.stores.secrets,
        )
      : yield* resolveRouteCredential(
          facts,
          config,
          route,
          input.stores.secrets,
        );
  const reasoning = yield* reasoningFor(
    config,
    request,
    input.stores.globalState,
    {
      protocol,
      codexSubscription: credential.route === 'chatgpt-subscription',
    },
  );
  const configuration = yield* configurationFor(
    protocol,
    config,
    credential,
    input,
    reasoning,
  );

  // Background delivery and the persistent WebSocket are alternatives on the
  // Responses protocol, and background wins where the user selected both.
  const onWebSocket =
    configuration.protocol === 'openai-responses' &&
    !(yield* backgroundDelivery(
      {
        backgroundCapable: backgroundCapable(configuration),
        protocol: configuration.protocol,
        modelName: config.id,
        agentCategory: input.agentCategory,
      },
      input.stores,
    )) &&
    (yield* responsesWebSocketSelected(credential, input.stores));
  // A subscription token is the bearer where an API key would be, and the
  // Codex session additionally names its account.
  const model = yield* bindWireModel(
    configuration,
    modelCredential(credential),
    {
      fetch: longRunningModelFetch,
      webSocket: onWebSocket,
    },
  );
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
                `Could not delete ${unreleased.length} uploaded file(s) when the ${config.label} binding closed; the provider expires them on its own.`,
              ).pipe(Effect.annotateLogs({ unreleased })),
        ),
      ),
    );
  }
  const origin = originOf(configuration);
  return {
    modelId: input.modelId,
    config,
    reasoning,
    ...(configuration.protocol === 'openai-responses' &&
      configuration.defaults.serviceTier === 'fast' && {
        serviceTier: 'fast' as const,
      }),
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
      config.id,
    ),
    // The socket carries one turn at a time and submits no background work.
    backgroundCapable: !onWebSocket && backgroundCapable(configuration),
    persistentConnection: onWebSocket,
    automaticRetries,
  };
});
