/**
 * The wire configuration one binding sends: the vendor rules that turn a
 * catalog model, its route and the caller's plain options into the request
 * fields each protocol takes. Every vendor quirk the package knows lives in
 * this table and the Responses vendors' (`responsesConfiguration.ts`), so a
 * caller never spells a wire field.
 */
import { ModelProvider, ReasoningEffort, type ModelConfig } from 'llm-zoo';

import { acceptedEfforts, wireEffort } from '../models/reasoningChoice.js';
import { OPENAI_DEFAULT_ENDPOINT } from '../providers/providerPlugins.js';
import { responsesConfiguration } from './responsesConfiguration.js';
import type { ModelConfiguration } from '../turn.js';
import type { BindSpec } from '../node.js';

/** A configuration one of the package's HTTP protocols serves. */
export type HttpModelConfiguration = Exclude<
  ModelConfiguration,
  { protocol: 'vscode-lm' }
>;
type HttpProtocol = HttpModelConfiguration['protocol'];
/** One protocol's configuration. */
export type ConfigurationOf<P extends HttpProtocol> = Extract<
  HttpModelConfiguration,
  { protocol: P }
>;

/** What every protocol arm reads, computed once per bind. */
export interface Facts {
  readonly spec: BindSpec;
  readonly config: ModelConfig;
  readonly capabilities: ModelConfig['capabilities'];
  /** Requested model and deployment; a route addressed under another name overrides the model. */
  readonly base: {
    readonly requestedModel: string;
    readonly deployment: {
      readonly endpoint: string;
      readonly credentialScope: string;
    };
  };
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
  /** The effort values the model accepts on the wire (see {@link acceptedEfforts}). */
  readonly acceptedEfforts: readonly ReasoningEffort[];
}

/** Anthropic's thinking: off, adaptive, or a budget of half the output where the model takes one. */
function anthropicThinking(
  config: ModelConfig,
  choice: BindSpec['options']['reasoning'],
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
  'anthropic-messages': ({
    base,
    config,
    capabilities,
    controls,
    spec,
    supportsTemperature,
  }) => {
    const choice = spec.options.reasoning;
    return {
      ...base,
      protocol: 'anthropic-messages',
      supportsTemperature,
      supportsForcedToolChoice: true,
      supportsSystemMessages: capabilities.supportsIntermDevMsgs,
      defaults: {
        ...controls,
        parallelToolCalls: true,
        thinking: anthropicThinking(config, choice, controls.maxOutputTokens),
        // Anthropic has no `none` or `minimal`: off is the thinking switch.
        effort:
          choice.effort === ReasoningEffort.NONE ||
          choice.effort === ReasoningEffort.MINIMAL
            ? null
            : choice.effort,
        cache: capabilities.supportsPromptCaching ? '5m' : 'disabled',
        stopSequences: [],
      },
    };
  },
  'openai-responses': responsesConfiguration,
  'google-interactions': ({ base, controls, spec }) => {
    const { effort } = spec.options.reasoning;
    return {
      ...base,
      protocol: 'google-interactions',
      background: 'supported',
      defaults: {
        maxOutputTokens: controls.maxOutputTokens,
        // Server-side conversation state is the user's choice: on, Google
        // holds the conversation and each round sends only the new turn
        // (and background execution becomes reachable); off, every round
        // resends the full transcript and nothing is retained.
        store: spec.options.serverState,
        // A Gemini model without levels (2.5, budget-controlled) keeps the
        // level this route has always sent.
        thinkingLevel:
          effort === 'minimal' ||
          effort === 'low' ||
          effort === 'medium' ||
          effort === 'high'
            ? effort
            : 'high',
      },
    };
  },
  'openrouter-chat': ({
    base,
    config,
    capabilities,
    controls,
    spec,
    supportsTemperature,
  }) => ({
    ...base,
    requestedModel:
      config.openrouterFullName ?? `${config.provider}/${config.id}`,
    protocol: 'openrouter-chat',
    supportsTemperature,
    supportsForcedToolChoice: true,
    supportsImageInput: capabilities.supportsVision,
    supportsAudioInput: capabilities.supportsNativeAudio,
    supportedEfforts: acceptedEfforts(config),
    defaults: {
      maxOutputTokens: controls.maxOutputTokens,
      temperature: controls.temperature,
      effort: wireEffort(config, spec.options.reasoning),
      stopSequences: [],
    },
  }),
};

/** The configuration `spec` binds on its protocol. */
export function configurationFor(spec: BindSpec): HttpModelConfiguration {
  const { model: config, options } = spec;
  // A request that does not think is sampled at the caller's temperature,
  // except on an OpenAI reasoning model, which refuses a temperature even at
  // effort `none`.
  const supportsTemperature =
    !options.reasoning.thinking &&
    !(
      config.provider === ModelProvider.OPENAI && config.reasoning !== undefined
    );
  return CONFIGURE[spec.protocol]({
    spec,
    config,
    capabilities: config.capabilities,
    base: {
      requestedModel: config.id,
      deployment: {
        endpoint: spec.endpoint,
        credentialScope: spec.credentialScope,
      },
    },
    controls: {
      maxOutputTokens: options.maxOutputTokens,
      temperature: supportsTemperature ? options.temperature : null,
      // Every OpenAI-descended route honors this; Anthropic uses its default.
      parallelToolCalls: options.parallelToolCalls,
    },
    supportsTemperature,
    acceptedEfforts: acceptedEfforts(config),
  });
}

/**
 * Whether a configuration admits background work: Responses and Google mark
 * it, and Google retrieves a background result through server-side state.
 */
export function backgroundCapable(
  configuration: HttpModelConfiguration,
): boolean {
  switch (configuration.protocol) {
    case 'openai-responses':
      return configuration.background === 'supported';
    case 'google-interactions':
      return (
        configuration.background === 'supported' && configuration.defaults.store
      );
    case 'anthropic-messages':
    case 'openrouter-chat':
      return false;
  }
}

/** Whether the configuration takes a tool choice naming one function. */
export function forcedToolChoice(
  configuration: HttpModelConfiguration,
  config: ModelConfig,
): boolean {
  switch (configuration.protocol) {
    case 'openai-responses':
      return configuration.supportsForcedToolChoice;
    case 'google-interactions':
      return config.capabilities.supportsFunctionCalling;
    case 'anthropic-messages':
    case 'openrouter-chat':
      return true;
  }
}

/**
 * Whether the binding serves Responses over its persistent WebSocket: the
 * caller's opt-in, on a route known to speak it (the ChatGPT subscription,
 * or OpenAI's own endpoint; a per-model or dashboard endpoint may not), and
 * never for turns that go out as background work.
 */
export function servesWebSocket(
  spec: BindSpec,
  configuration: HttpModelConfiguration,
): boolean {
  return (
    configuration.protocol === 'openai-responses' &&
    spec.options.webSocket &&
    !(spec.options.background && backgroundCapable(configuration)) &&
    (spec.credential.kind === 'codex' ||
      spec.endpoint === OPENAI_DEFAULT_ENDPOINT)
  );
}
