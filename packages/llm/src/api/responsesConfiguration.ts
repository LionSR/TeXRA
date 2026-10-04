/**
 * The Responses protocol's vendor rules: the vendors that serve OpenAI's
 * format on their own endpoints (DeepSeek, Kimi, GLM, DashScope, MiniMax),
 * OpenAI and xAI on theirs, and the ChatGPT subscription's Codex backend.
 */
import { ModelProvider, ReasoningEffort } from 'llm-zoo';

import { codexBackendModelId } from '../models/modelRoute.js';
import { CODEX_ROUTE_EFFORTS, wireEffort } from '../models/reasoningChoice.js';
import { OPENAI_DEFAULT_ENDPOINT } from '../providers/providerPlugins.js';
import type { ConfigurationOf, Facts } from './configuration.js';

type ResponsesConfiguration = ConfigurationOf<'openai-responses'>;

/** Instructions the Codex backend requires when the request carries none. */
const CODEX_DEFAULT_INSTRUCTIONS = "Follow the user's instructions.";

/**
 * The Responses route of a vendor serving OpenAI's format on its own
 * endpoint: stateless unless the vendor stores and chains, no background,
 * socket, files or token count, and only the request fields it documents.
 * `null` for OpenAI, Meta and xAI, which the Responses arm binds.
 */
function vendorResponses(facts: Facts): ResponsesConfiguration | null {
  const { base, config, controls, spec } = facts;
  const choice = spec.options.reasoning;
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
      // request shape, so `@none` is refused by the reasoning choice.
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
        temperature: Math.min(1, Math.max(0.01, spec.options.temperature)),
        reasoning: choice.thinking ? reasoning('high') : null,
      });
    default:
      return null;
  }
}

/**
 * The Responses configuration: a vendor's own endpoint, else OpenAI, Meta,
 * xAI or the ChatGPT subscription.
 */
export function responsesConfiguration(facts: Facts): ResponsesConfiguration {
  const vendor = vendorResponses(facts);
  if (vendor !== null) return vendor;
  const { base, config, capabilities, controls, spec, supportsTemperature } =
    facts;
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
  if (credential.kind === 'codex') {
    return {
      ...base,
      requestedModel: codexBackendModelId(config),
      protocol: 'openai-responses',
      background: 'unsupported',
      supportsTemperature,
      supportsMaxOutputTokens: false,
      supportsStorage: false,
      supportsDocumentInput: capabilities.supportsNativePdf,
      webSocketStreamParameter: 'required',
      allowedReasoningEfforts: facts.acceptedEfforts.filter(
        (value) =>
          value === ReasoningEffort.NONE || CODEX_ROUTE_EFFORTS.includes(value),
      ),
      instructions: { kind: 'required', fallback: CODEX_DEFAULT_INSTRUCTIONS },
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
    openaiEndpoint: spec.endpoint === OPENAI_DEFAULT_ENDPOINT,
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
      serviceTier: options.fastTier && config.tiers?.fast ? 'fast' : null,
    },
  };
}
