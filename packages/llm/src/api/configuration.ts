/**
 * The wire configuration one binding sends: the vendor rules that turn a
 * catalog model, its route and the caller's plain options into the request
 * fields each protocol takes. Every vendor quirk the package knows lives in
 * this table and the Responses vendors' (`responsesConfiguration.ts`), so a
 * caller never spells a wire field.
 */
import { Result, Schema } from 'effect';
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { ModelError, PLAN_ROUTES } from '../errors.js';
import { routeConfig } from '../models/modelRoute.js';
import {
  chooseReasoning,
  reasoningOnRoute,
} from '../models/reasoningChoice.js';
import { BACKEND_PROTOCOLS } from '../providers/providerPlugins.js';
import {
  onOpenAiEndpoint,
  responsesConfiguration,
} from './responsesConfiguration.js';
import {
  type ModelConfiguration,
  ThinkingLevelSchema,
  backgroundCapable,
} from '../turn.js';
import type { BindSpec } from '../node.js';

type HttpProtocol = ModelConfiguration['protocol'];
/** One protocol's configuration. */
export type ConfigurationOf<P extends HttpProtocol> = Extract<
  ModelConfiguration,
  { protocol: P }
>;

/** A bind's options with their defaults applied. */
type Options = Required<
  Omit<NonNullable<BindSpec['options']>, 'fetch' | 'temperature'>
> &
  Pick<NonNullable<BindSpec['options']>, 'fetch' | 'temperature'>;

/** What every protocol case reads, computed once per bind. */
export interface Facts {
  /** The bind, over its route's config and with every option defaulted. */
  readonly spec: BindSpec & { readonly options: Options };
  readonly config: ModelConfig;
  /** Requested model and deployment; a route addressed under another name overrides the model. */
  readonly base: {
    readonly requestedModel: string;
    readonly deployment: {
      readonly endpoint: string;
      readonly credentialScope: string;
    };
  };
  /** The request controls the protocol cases default from; a case that
   *  clamps or fixes one sets its own value instead. */
  readonly controls: {
    readonly maxOutputTokens: number;
    /** Null where the request takes no temperature: the route then sends none. */
    readonly temperature: number | null;
  };
  /** The effort values the route accepts on the wire (see {@link reasoningOnRoute}). */
  readonly acceptedEfforts: readonly ReasoningEffort[];
  /** The effort the route sends for the bind's reasoning (see {@link reasoningOnRoute}). */
  readonly effort: ReasoningEffort | null;
}

/** Anthropic's thinking: off, adaptive, or a budget of half the output where the model takes one. */
function anthropicThinking(
  config: ModelConfig,
  choice: Options['reasoning'],
  maxOutputTokens: number,
): ConfigurationOf<'anthropic-messages'>['defaults']['thinking'] {
  if (!choice.thinking) return { mode: 'disabled' };
  if (!config.reasoning?.budget)
    return { mode: 'adaptive', display: 'summarized' };
  return {
    mode: 'enabled',
    budgetTokens: Math.max(1024, Math.floor(maxOutputTokens / 2)),
    display: 'summarized',
  };
}

/**
 * One configuration builder per protocol. The mapped key set is the
 * exhaustiveness: a protocol added to `ModelConfiguration` and left out here
 * does not compile, and each entry is checked against that protocol's shape.
 */
const CONFIGURE: {
  readonly [P in HttpProtocol]: (facts: Facts) => ConfigurationOf<P>;
} = {
  'anthropic-messages': ({ base, config, controls, spec }) => {
    const choice = spec.options.reasoning;
    return {
      ...base,
      protocol: 'anthropic-messages',
      supportsSystemMessages: config.capabilities.supportsIntermDevMsgs,
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        thinking: anthropicThinking(config, choice, controls.maxOutputTokens),
        // Anthropic has no `none` or `minimal`: off is the thinking switch.
        effort:
          choice.effort === ReasoningEffort.NONE ||
          choice.effort === ReasoningEffort.MINIMAL
            ? null
            : choice.effort,
        cache: config.capabilities.supportsPromptCaching ? '5m' : 'disabled',
      },
    };
  },
  'openai-responses': responsesConfiguration,
  'google-interactions': ({ base, controls, spec }) => {
    const { effort } = spec.options.reasoning;
    return {
      ...base,
      protocol: 'google-interactions',
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        // Server-side conversation state is the user's choice: on, Google
        // holds the conversation and each round sends only the new turn
        // (and background execution becomes reachable); off, every round
        // resends the full transcript and nothing is retained.
        store: spec.options.serverState,
        // A Gemini model without levels (2.5, budget-controlled) keeps the
        // level this route has always sent.
        thinkingLevel: Schema.is(ThinkingLevelSchema)(effort) ? effort : 'high',
      },
    };
  },
};

/** The protocol each backend provider serves, by provider id. */
const PROTOCOL_OF: Readonly<Partial<Record<string, HttpProtocol>>> =
  BACKEND_PROTOCOLS;

/**
 * What `spec` binds: the config its route runs, its options with their
 * defaults, and the configuration they make on the provider's protocol.
 */
export function configurationFor(spec: BindSpec): Result.Result<
  {
    readonly config: ModelConfig;
    readonly options: Options;
    readonly configuration: ModelConfiguration;
  },
  ModelError
> {
  const { route } = spec;
  const config = routeConfig(spec.model, route);
  const protocol = PROTOCOL_OF[config.provider];
  if (protocol === undefined)
    return Result.fail(
      new ModelError({
        kind: 'invalid-request',
        message: `No protocol serves ${config.provider} models.`,
      }),
    );
  // The model's default reasoning on the route, unless the spec names one;
  // a default the route cannot carry is the spec's invalid request.
  let reasoning = spec.options?.reasoning;
  if (reasoning === undefined) {
    const chosen = chooseReasoning(config, {}, { route });
    if (Result.isFailure(chosen))
      return Result.fail(
        new ModelError({
          kind: 'invalid-request',
          message: chosen.failure.message,
        }),
      );
    reasoning = chosen.success;
  }
  const options: Options = {
    maxOutputTokens: config.maxOutputTokens,
    reasoning,
    serverState: false,
    fastTier: false,
    webSocket: false,
    background: false,
    ...spec.options,
  };
  // A request that does not think is sampled at the caller's temperature,
  // except on an OpenAI reasoning model, which refuses a temperature even at
  // effort `none`.
  const sampled =
    !options.reasoning.thinking &&
    !(
      config.provider === ModelProvider.OPENAI && config.reasoning !== undefined
    );
  // A session's scope is named by its plan, a key's by its kind: the name a
  // stored turn's deployment carries, so a continuation still matches it.
  const [credentialProvider, credentialName] =
    route.kind === 'api-key'
      ? [route.provider, route.kind]
      : [PLAN_ROUTES[route.plan].provider, route.plan];
  const onRoute = reasoningOnRoute(config, route);
  const configuration = CONFIGURE[protocol]({
    spec: { ...spec, model: config, options },
    config,
    base: {
      requestedModel: config.id,
      deployment: {
        endpoint: spec.route.endpoint,
        // A non-secret name of the credential route.
        credentialScope: `${credentialProvider}:${credentialName}`,
      },
    },
    controls: {
      maxOutputTokens: options.maxOutputTokens,
      temperature: sampled ? (options.temperature ?? null) : null,
    },
    acceptedEfforts: onRoute.acceptedEfforts,
    effort: onRoute.wireEffort(options.reasoning),
  });
  // The configuration knows which media its route carries; the config the
  // binding reports says the same, so a caller never sends a document the
  // route refuses.
  const takesDocuments =
    configuration.protocol !== 'openai-responses' ||
    configuration.supportsDocumentInput;
  return Result.succeed({
    config: takesDocuments
      ? config
      : {
          ...config,
          capabilities: { ...config.capabilities, supportsNativePdf: false },
        },
    options,
    configuration,
  });
}

/** Whether the configuration takes a tool choice naming one function. */
export function forcedToolChoice(configuration: ModelConfiguration): boolean {
  switch (configuration.protocol) {
    case 'openai-responses':
      return configuration.supportsForcedToolChoice;
    case 'google-interactions':
      return true;
    case 'anthropic-messages':
      return false;
  }
}

/**
 * Whether the binding serves Responses over its persistent WebSocket: the
 * caller's opt-in, on OpenAI's own API endpoint (a per-model or dashboard
 * endpoint may not speak it, and the ChatGPT plan's requests are HTTP
 * streams), and never for turns that go out as background work.
 */
export function servesWebSocket(
  options: Options,
  configuration: ModelConfiguration,
): boolean {
  return (
    configuration.protocol === 'openai-responses' &&
    options.webSocket &&
    !(options.background && backgroundCapable(configuration)) &&
    configuration.requestDialect === 'openai' &&
    onOpenAiEndpoint(configuration)
  );
}
