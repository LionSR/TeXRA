/**
 * The Responses protocol's vendor rules: the vendors that serve OpenAI's
 * format on their own endpoints (DeepSeek, Kimi, GLM, DashScope, MiniMax),
 * OpenAI and xAI on theirs, and the ChatGPT subscription's Codex backend.
 */
import { Number as Num } from 'effect';
import { ModelProvider } from 'llm-zoo';

import { codexBackendModelId } from '../models/modelRoute.js';
import { wireEffort } from '../models/reasoningChoice.js';
import {
  type BACKEND_PROTOCOLS,
  type BackendProviderId,
  OPENAI_DEFAULT_ENDPOINT,
} from '../providers/providerPlugins.js';
import type { ConfigurationOf, Facts } from './configuration.js';

type ResponsesConfiguration = ConfigurationOf<'openai-responses'>;

/** The one namespace a ChatGPT plan's route groups every function tool in. */
const CHATGPT_TOOL_NAMESPACE = 'texra';

/** The request fields a vendor route sets for itself. */
interface VendorFields extends Pick<
  ResponsesConfiguration,
  'supportsForcedToolChoice' | 'allowedReasoningEfforts'
> {
  readonly stores: boolean;
  readonly temperature: number | null;
  readonly reasoning: ResponsesConfiguration['defaults']['reasoning'];
}

/**
 * The Responses route of a vendor serving OpenAI's format on its own
 * endpoint: stateless unless the vendor stores and chains, no background,
 * socket, files or token count, and only the request fields it documents.
 */
function vendorRoute(
  { base, controls }: Facts,
  fields: VendorFields,
): ResponsesConfiguration {
  return {
    ...base,
    protocol: 'openai-responses',
    background: 'unsupported',
    supportsStorage: fields.stores,
    supportsDocumentInput: false,
    webSocketStreamParameter: 'implicit',
    allowedReasoningEfforts: fields.allowedReasoningEfforts,
    instructions: { kind: 'optional' },
    continuationInheritsInstructions: false,
    supportsForcedToolChoice: fields.supportsForcedToolChoice,
    toolNamespace: null,
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
  };
}

/** A reasoning request that names only its effort. */
const effortOnly = (
  effort: ResponsesConfiguration['allowedReasoningEfforts'][number] | null,
) => ({ effort, mode: null, summary: null });

/**
 * The Responses route of OpenAI, xAI and Meta on their own endpoints, and of
 * the ChatGPT subscription's Codex backend.
 */
function firstPartyResponses(facts: Facts): ResponsesConfiguration {
  const { base, config, controls, spec } = facts;
  const { credential, options } = spec;
  const choice = options.reasoning;
  const effort = wireEffort(config, choice);
  // GPT-5 asks for a reasoning summary only when the user turned it on;
  // every other reasoning Responses model asks. `null` omits the field.
  const summary: 'auto' | null =
    !config.id.startsWith('gpt-5') || options.reasoningSummary ? 'auto' : null;
  const reasoning =
    config.reasoning === undefined
      ? null
      : { effort, mode: choice.mode, summary };
  if (credential.kind === 'chatgpt') {
    // OpenAI's token sharing: the public Responses API under a ChatGPT plan's
    // rules. A request is stateless and streamed (`store: false`, no
    // `previous_response_id`), takes no temperature or output limit, has no
    // background mode, and takes function tools only inside a namespace; the
    // plan's token reaches no Files API either.
    return {
      ...base,
      requestedModel: codexBackendModelId(config),
      protocol: 'openai-responses',
      background: 'unsupported',
      supportsStorage: false,
      supportsDocumentInput: config.capabilities.supportsNativePdf,
      webSocketStreamParameter: 'implicit',
      allowedReasoningEfforts: facts.acceptedEfforts,
      instructions: { kind: 'optional' },
      continuationInheritsInstructions: false,
      // OpenAI documents no `tool_choice` for a namespaced function.
      supportsForcedToolChoice: false,
      toolNamespace: CHATGPT_TOOL_NAMESPACE,
      openaiEndpoint: true,
      requestDialect: 'openai',
      defaults: {
        maxOutputTokens: null,
        temperature: null,
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
  // Background responses serve the GPT family only, as the
  // `useBackgroundResponses` setting describes; another model on this case
  // (an o-series deep-research model, Meta's) streams in the foreground.
  const background =
    !xai && config.id.toLowerCase().startsWith('gpt')
      ? 'supported'
      : 'unsupported';
  return {
    ...base,
    protocol: 'openai-responses',
    background,
    supportsStorage: true,
    supportsDocumentInput: config.capabilities.supportsNativePdf,
    webSocketStreamParameter: 'implicit',
    allowedReasoningEfforts: facts.acceptedEfforts,
    instructions: { kind: 'optional' },
    continuationInheritsInstructions: xai,
    supportsForcedToolChoice: true,
    toolNamespace: null,
    openaiEndpoint: spec.endpoint === OPENAI_DEFAULT_ENDPOINT,
    requestDialect: 'openai',
    defaults: {
      maxOutputTokens: controls.maxOutputTokens,
      temperature: controls.temperature,
      // Stored server-side, which `previous_response_id` chaining and
      // background submission read; the Codex case above is stateless.
      store: true,
      parallelToolCalls: controls.parallelToolCalls,
      reasoning:
        reasoning === null || !xai
          ? reasoning
          : { ...reasoning, summary: null },
      serviceTier: options.fastTier && config.tiers?.fast ? 'fast' : null,
    },
  };
}

/** A provider whose backend serves the Responses protocol. */
type ResponsesProviderId = {
  [
    P in BackendProviderId
  ]: (typeof BACKEND_PROTOCOLS)[P] extends 'openai-responses' ? P : never;
}[BackendProviderId];

/**
 * Each Responses provider's route. Keyed by every provider whose backend
 * serves Responses, so a provider added to `BACKEND_PROTOCOLS` does not
 * compile until its row says which route it binds.
 */
const RESPONSES_ROUTES: {
  readonly [P in ResponsesProviderId]: (facts: Facts) => ResponsesConfiguration;
} = {
  openai: firstPartyResponses,
  xai: firstPartyResponses,
  meta: firstPartyResponses,
  // `none` turns thinking off; thinking refuses a temperature.
  deepseek: (facts) =>
    vendorRoute(facts, {
      supportsForcedToolChoice: true,
      allowedReasoningEfforts: facts.acceptedEfforts,
      stores: false,
      temperature: facts.controls.temperature,
      reasoning: effortOnly(
        wireEffort(facts.config, facts.spec.options.reasoning),
      ),
    }),
  // Kimi fixes its sampling. Its `thinking` switch is not part of this
  // request shape, so `@none` is refused by the reasoning choice.
  moonshot: (facts) =>
    vendorRoute(facts, {
      supportsForcedToolChoice: false,
      allowedReasoningEfforts: facts.acceptedEfforts,
      stores: false,
      temperature: null,
      reasoning: effortOnly(facts.spec.options.reasoning.effort),
    }),
  // Zhipu stores for seven days; `none` turns thinking off.
  glm: (facts) =>
    vendorRoute(facts, {
      supportsForcedToolChoice: false,
      allowedReasoningEfforts: facts.acceptedEfforts,
      stores: true,
      temperature:
        facts.controls.temperature === null
          ? null
          : Math.min(1, facts.controls.temperature),
      reasoning: effortOnly(
        wireEffort(facts.config, facts.spec.options.reasoning),
      ),
    }),
  // DashScope stores by default; Qwen keeps its own thinking default.
  dashscope: (facts) =>
    vendorRoute(facts, {
      supportsForcedToolChoice: false,
      allowedReasoningEfforts: facts.acceptedEfforts,
      stores: true,
      temperature: facts.controls.temperature,
      reasoning: null,
    }),
  // MiniMax reasons only when asked; its temperature range is (0, 1].
  minimax: (facts) => {
    const { options } = facts.spec;
    return vendorRoute(facts, {
      supportsForcedToolChoice: false,
      allowedReasoningEfforts: ['high'],
      stores: false,
      temperature:
        options.temperature === undefined
          ? null
          : Num.clamp(options.temperature, { minimum: 0.01, maximum: 1 }),
      reasoning: options.reasoning.thinking ? effortOnly('high') : null,
    });
  },
};

/**
 * The Responses configuration of the provider's route. `configurationFor`
 * reaches this case only for a provider `BACKEND_PROTOCOLS` maps to it.
 */
export function responsesConfiguration(facts: Facts): ResponsesConfiguration {
  // cast: a Responses backend, by the protocol lookup that chose this case.
  const provider = facts.config.provider as ResponsesProviderId;
  return RESPONSES_ROUTES[provider](facts);
}
