// Node.js imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Stream } from 'effect';
import { z } from 'zod';
import { OpenRouterCore } from '@openrouter/sdk/core';
import { chatSend } from '@openrouter/sdk/funcs/chatSend';
import { HTTPClient } from '@openrouter/sdk/lib/http';
import { HTTPClientError } from '@openrouter/sdk/models/errors/httpclienterrors';
import { OpenRouterError } from '@openrouter/sdk/models/errors/openroutererror';
import { SDKValidationError } from '@openrouter/sdk/models/errors/sdkvalidationerror';

// Local imports - canonical model contract
import { chatDeltaAccumulator, chatUsageCounts } from './chatStream.js';
import {
  ModelConfigurationSchema,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  type Model,
  type OpenRouterConfiguration,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
  completedTurn,
} from './turn.js';
import { sameModelOrigin } from './protocol.js';
import {
  ModelError,
  authOrRejectionKind,
  enrichModelError,
  hasErrorField,
  parseJsonOrModelError,
  sdkModelError,
} from './errors.js';
import {
  chatToolResultMessages,
  parseInboundToolArguments,
  pullStream,
  readerAbortSignal,
} from './transport.js';
import type {
  ChatContentItems,
  ChatMessages,
  ChatRequest,
  ChatStreamChunk,
  ChatUsage,
  ReasoningDetailUnion,
  ReasoningFormat,
} from '@openrouter/sdk/models';

type OpenRouterTurn = Extract<ResolvedTurn, { protocol: 'openrouter-chat' }>;
type Part = TurnResult['content'][number];
type Reasoning = Extract<
  NonNullable<Extract<Part, { kind: 'reasoning' }>['evidence']>,
  { kind: 'openrouter-reasoning' }
>;
type Detail = NonNullable<Reasoning['details']>[number];

/** The finish reasons a completed turn carries; `error` fails the turn. */
const FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'tool_calls',
] as const;

/** An HTTP rejection body, read from the raw text the SDK kept. */
const ErrorSchema = z.looseObject({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string(),
});

/** One SDK reasoning detail as canonical evidence; an unknown one is malformed. */
const canonicalDetail = (detail: ReasoningDetailUnion): Detail | undefined => {
  const metadata = {
    ...('format' in detail && detail.format !== undefined
      ? { format: detail.format }
      : {}),
    ...('id' in detail && detail.id !== undefined ? { id: detail.id } : {}),
    ...('index' in detail && detail.index !== undefined
      ? { index: detail.index }
      : {}),
  };
  switch (detail.type) {
    case 'reasoning.text':
      return {
        ...metadata,
        kind: 'text',
        ...(detail.text !== undefined ? { text: detail.text } : {}),
        ...(detail.signature !== undefined
          ? { signature: detail.signature }
          : {}),
      };
    case 'reasoning.summary':
      return { ...metadata, kind: 'summary', summary: detail.summary };
    case 'reasoning.encrypted':
      return { ...metadata, kind: 'encrypted', data: detail.data };
    case 'reasoning.server_tool_call':
      return {
        ...metadata,
        kind: 'server-tool-call',
        toolName: detail.toolName,
        ...(detail.toolCallId !== undefined
          ? { toolCallId: detail.toolCallId }
          : {}),
        arguments: detail.arguments,
        result: detail.result,
      };
    default:
      return undefined;
  }
};

/** The canonical receipt of one SDK usage object. */
const canonicalUsage = (
  usage: ChatUsage,
): NonNullable<TurnResult['usage']> => ({
  ...chatUsageCounts({
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.totalTokens,
    prompt_tokens_details: usage.promptTokensDetails && {
      cached_tokens: usage.promptTokensDetails.cachedTokens,
    },
    completion_tokens_details: usage.completionTokensDetails && {
      reasoning_tokens: usage.completionTokensDetails.reasoningTokens,
    },
  }),
  providerUsage: {
    kind: 'openrouter',
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    ...(usage.isByok !== undefined ? { isByok: usage.isByok } : {}),
    ...(usage.costDetails !== undefined
      ? {
          costDetails: usage.costDetails && {
            upstreamInferenceCost: usage.costDetails.upstreamInferenceCost,
            upstreamInferencePromptCost:
              usage.costDetails.upstreamInferencePromptCost,
            upstreamInferenceCompletionsCost:
              usage.costDetails.upstreamInferenceCompletionsCost,
            serverToolCost: usage.costDetails.serverToolCost,
          },
        }
      : {}),
    ...(usage.promptTokensDetails !== undefined
      ? {
          inputDetails: usage.promptTokensDetails && {
            cacheWriteTokens: usage.promptTokensDetails.cacheWriteTokens,
            audioTokens: usage.promptTokensDetails.audioTokens,
            videoTokens: usage.promptTokensDetails.videoTokens,
          },
        }
      : {}),
    ...(usage.completionTokensDetails !== undefined
      ? {
          outputDetails: usage.completionTokensDetails && {
            audioTokens: usage.completionTokensDetails.audioTokens,
            acceptedPredictionTokens:
              usage.completionTokensDetails.acceptedPredictionTokens,
            rejectedPredictionTokens:
              usage.completionTokensDetails.rejectedPredictionTokens,
          },
        }
      : {}),
    ...(usage.serverToolUseDetails !== undefined
      ? {
          serverToolUseDetails: usage.serverToolUseDetails && {
            toolCallsRequested: usage.serverToolUseDetails.toolCallsRequested,
            toolCallsExecuted: usage.serverToolUseDetails.toolCallsExecuted,
            webSearchRequests: usage.serverToolUseDetails.webSearchRequests,
          },
        }
      : {}),
  },
});

// Reused at preparation and execution so rehydration cannot bypass support checks.
const requestBody = Effect.fn('llm.openrouterRequest')(function* (
  turn: OpenRouterTurn,
  configuration: OpenRouterConfiguration,
) {
  const controls = turn.controls;
  const toolChoice = controls.toolChoice;
  if (
    (!configuration.supportsTemperature && controls.temperature !== null) ||
    (controls.effort !== null &&
      !configuration.supportedEfforts.includes(controls.effort)) ||
    (toolChoice !== 'auto' &&
      (!configuration.supportsForcedToolChoice ||
        !turn.tools.some((tool) => tool.name === toolChoice.name)))
  )
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'The selected OpenRouter route does not support these resolved controls.',
    });
  const messages: ChatMessages[] = [];
  if (turn.system !== undefined)
    messages.push({ role: 'system', content: turn.system });
  let calls: Extract<Part, { kind: 'local-call' }>[] = [];
  for (const message of turn.messages) {
    if (message.role === 'tool') {
      const toolResults = yield* chatToolResultMessages(
        message.results,
        calls.map((call) => call.providerCallId),
        'OpenRouter tool results require materialized text.',
      );
      for (const result of toolResults) {
        messages.push({
          role: 'tool',
          toolCallId: result.tool_call_id,
          content: result.content,
        });
      }
      continue;
    }
    calls = [];
    if (message.role === 'user') {
      const content: ChatContentItems[] = [];
      for (const part of message.content) {
        if (part.kind === 'text')
          content.push({ type: 'text', text: part.text });
        else if (
          part.kind === 'image' &&
          configuration.supportsImageInput &&
          ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(
            part.mimeType.toLowerCase(),
          ) &&
          (part.detail === undefined ||
            part.detail === 'low' ||
            part.detail === 'high')
        ) {
          content.push({
            type: 'image_url',
            imageUrl: {
              url: `data:${part.mimeType};base64,${part.base64}`,
              ...(part.detail !== undefined ? { detail: part.detail } : {}),
            },
          });
        } else if (
          part.kind === 'document' &&
          part.mimeType.toLowerCase() === 'application/pdf'
        ) {
          content.push({
            type: 'file',
            file: { fileData: `data:${part.mimeType};base64,${part.base64}` },
          });
        } else if (part.kind === 'audio' && configuration.supportsAudioInput) {
          const formats: Record<string, string> = {
            'audio/wav': 'wav',
            'audio/mpeg': 'mp3',
            'audio/aiff': 'aiff',
            'audio/aac': 'aac',
            'audio/ogg': 'ogg',
            'audio/flac': 'flac',
            'audio/mp4': 'm4a',
          };
          const format = formats[part.mimeType.toLowerCase()];
          if (format === undefined)
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'OpenRouter requires a supported self-contained audio encoding.',
            });
          content.push({
            type: 'input_audio',
            inputAudio: { data: part.base64, format },
          });
        } else
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'The selected OpenRouter route cannot represent this media part or image detail.',
          });
      }
      messages.push({ role: 'user', content });
      continue;
    }
    let text: string | undefined;
    let refusal: string | undefined;
    let reasoning: Reasoning | undefined;
    for (const part of message.content) {
      if (
        part.kind === 'message' &&
        part.evidence === undefined &&
        text === undefined &&
        refusal === undefined &&
        calls.length === 0
      ) {
        text = part.content
          .filter((child) => child.kind === 'text')
          .map((child) => child.text)
          .join('');
        if (part.content.some((child) => child.kind === 'refusal'))
          refusal = part.content
            .filter((child) => child.kind === 'refusal')
            .map((child) => child.text)
            .join('');
      } else if (
        part.kind === 'reasoning' &&
        part.evidence?.kind === 'openrouter-reasoning' &&
        reasoning === undefined &&
        text === undefined &&
        calls.length === 0 &&
        sameModelOrigin(message.origin, turn)
      ) {
        reasoning = part.evidence;
      } else if (part.kind === 'local-call' && part.evidence === undefined)
        calls.push(part);
      else
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'OpenRouter cannot replay this assistant content or foreign protocol evidence.',
        });
    }
    messages.push({
      role: 'assistant',
      content: text ?? '',
      ...(refusal !== undefined ? { refusal } : {}),
      ...(reasoning?.plain !== undefined ? { reasoning: reasoning.plain } : {}),
      ...(reasoning?.details !== undefined
        ? {
            reasoningDetails: reasoning.details.map(
              (detail): ReasoningDetailUnion => {
                // The SDK brands a format it does not list; the wire is a string.
                const format = detail.format as
                  ReasoningFormat | null | undefined;
                switch (detail.kind) {
                  case 'text': {
                    const { kind: _, ...fields } = detail;
                    return { ...fields, format, type: 'reasoning.text' };
                  }
                  case 'summary': {
                    const { kind: _, ...fields } = detail;
                    return { ...fields, format, type: 'reasoning.summary' };
                  }
                  case 'encrypted': {
                    const { kind: _, ...fields } = detail;
                    return { ...fields, format, type: 'reasoning.encrypted' };
                  }
                  case 'server-tool-call': {
                    const { kind: _, ...fields } = detail;
                    return {
                      ...fields,
                      format,
                      type: 'reasoning.server_tool_call',
                    };
                  }
                }
              },
            ),
          }
        : {}),
      ...(calls.length > 0
        ? {
            toolCalls: calls.map((call) => ({
              id: call.providerCallId,
              type: 'function' as const,
              function: {
                name: call.name,
                arguments: call.argumentsText,
              },
            })),
          }
        : {}),
    });
  }
  return {
    model: turn.requestedModel,
    messages,
    stream: true,
    maxCompletionTokens: controls.maxOutputTokens,
    ...(controls.temperature !== null
      ? { temperature: controls.temperature }
      : {}),
    ...(controls.effort !== null
      ? { reasoning: { effort: controls.effort } }
      : {}),
    ...(controls.stopSequences.length > 0
      ? { stop: [...controls.stopSequences] }
      : {}),
    ...(turn.tools.length > 0
      ? {
          tools: turn.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            },
          })),
          toolChoice:
            controls.toolChoice === 'auto'
              ? ('auto' as const)
              : {
                  type: 'function' as const,
                  function: { name: controls.toolChoice.name },
                },
        }
      : {}),
  } satisfies ChatRequest & { stream: true };
});

/**
 * OpenRouter Chat through `@openrouter/sdk`; selected credentials and transport
 * are explicit. The SDK never retries: the run's retry gate owns every retry,
 * and the SDK's default backoff would hold a 5XX for up to an hour.
 */
export function openrouterChatModel(
  configuration: OpenRouterConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openrouter-chat')
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements OpenRouter Chat.',
    });
  const origin = Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1 as const,
  });
  const http = transport.fetch ?? globalThis.fetch;
  const prepareTurn: Model['prepareTurn'] = Effect.fn('llm.prepareTurn')(
    function* (request) {
      const parsed = TurnRequestSchema.safeParse(request);
      if (!parsed.success)
        return yield* new ModelError({
          kind: 'invalid-request',
          message: 'OpenRouter requires supported materialized input.',
          cause: parsed.error,
        });
      const authored = parsed.data;
      if (
        authored.mode === 'background' ||
        authored.store !== undefined ||
        authored.thinkingLevel !== undefined ||
        authored.continuation !== undefined ||
        authored.reasoning !== undefined ||
        authored.serviceTier !== undefined ||
        authored.cache !== undefined ||
        authored.parallelToolCalls !== undefined ||
        authored.thinking !== undefined
      )
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'OpenRouter does not support these authored operation or provider controls.',
        });
      const prepared = ResolvedTurnSchema.safeParse({
        ...origin,
        mode: 'foreground',
        system: authored.system,
        messages: authored.messages,
        tools: authored.tools ?? [],
        controls: {
          maxOutputTokens:
            authored.maxOutputTokens ?? config.defaults.maxOutputTokens,
          temperature:
            authored.temperature === undefined
              ? config.defaults.temperature
              : authored.temperature,
          effort:
            authored.effort === undefined
              ? config.defaults.effort
              : authored.effort,
          stopSequences:
            authored.stopSequences ?? config.defaults.stopSequences,
          toolChoice: authored.toolChoice ?? 'auto',
        },
      });
      if (!prepared.success || prepared.data.protocol !== 'openrouter-chat')
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'OpenRouter cannot prepare these controls.',
          cause: prepared.error,
        });
      yield* requestBody(prepared.data, config);
      return prepared.data;
    },
  );

  const streamTurn: Model['streamTurn'] = (turn) =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      let requestId: string | undefined;
      const enrich = (error: ModelError) =>
        enrichModelError(error, {
          responseId,
          requestId,
          model: returnedModel ?? config.requestedModel,
        });
      // The SDK's parse of one streamed event throws a ZodError; anything else
      // a body read raises is the connection.
      const streamFailure = (cause: unknown) =>
        cause instanceof z.ZodError
          ? new ModelError({
              kind: 'malformed-output',
              message:
                'OpenRouter returned unsupported or malformed stream content.',
              cause,
            })
          : transportFailure(cause);
      const transportFailure = (cause: unknown) =>
        new ModelError({
          kind: 'transport',
          message: 'The OpenRouter connection failed.',
          cause,
        });
      /** One SDK request failure; any OpenRouterError is a reply, not ours. */
      const requestFailure = Effect.fn('llm.openrouterRequestFailure')(
        function* (error: unknown) {
          if (!(error instanceof OpenRouterError))
            return yield* error instanceof SDKValidationError
              ? new ModelError({
                  kind: 'invalid-request',
                  message: 'OpenRouter refused to encode this request.',
                  cause: error,
                })
              : transportFailure(
                  error instanceof HTTPClientError ? error.cause : error,
                );
          const status = error.statusCode;
          if (status < 400)
            return yield* new ModelError({
              kind: 'malformed-output',
              message: 'OpenRouter returned an unexpected response.',
              status,
              cause: error,
            });
          // Status, request id and any retry-after delay come from the reply;
          // the kind and message come from the raw body the SDK kept.
          const rejection = sdkModelError(
            error,
            {
              status,
              headers: error.headers,
              requestId: error.headers.get('x-request-id'),
            },
            `OpenRouter rejected the request (HTTP ${status}).`,
          );
          const raw = yield* parseJsonOrModelError(error.body, (cause) =>
            enrichModelError(rejection, {
              kind: 'provider-rejection',
              message: `OpenRouter rejected the request (HTTP ${status}).`,
              cause,
            }),
          );
          const payload = hasErrorField(raw) ? raw.error : raw;
          const parsed = ErrorSchema.safeParse(payload);
          return yield* parsed.success
            ? enrichModelError(rejection, {
                kind: authOrRejectionKind(status, parsed.data.code),
                message: parsed.data.message,
                cause: payload,
              })
            : enrichModelError(rejection, {
                kind: 'malformed-output',
                message: 'OpenRouter returned a malformed error receipt.',
                cause: payload,
              });
        },
      );
      return Stream.unwrap(
        Effect.gen(function* () {
          if (
            turn.protocol !== 'openrouter-chat' ||
            !sameModelOrigin(turn, origin)
          )
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The prepared turn belongs to another protocol or deployment.',
            });
          const chatRequest = yield* requestBody(turn, config);
          let reader: ReadableStreamDefaultReader<ChatStreamChunk> | undefined =
            undefined;
          const signal = yield* readerAbortSignal(() => reader);
          // One client per request: its fetcher reads this response's headers,
          // and hands fetch the scope's signal itself. The SDK's `Request`
          // only follows that signal through a controller the runtime holds
          // weakly, so a collected clone would never see the abort.
          const client = new OpenRouterCore({
            apiKey: transport.apiKey,
            serverURL: config.deployment.endpoint,
            retryConfig: { strategy: 'none' },
            httpClient: new HTTPClient({
              fetcher: async (request, init) => {
                const response = await http(request, { ...init, signal });
                requestId = response.headers.get('x-request-id') ?? undefined;
                responseId =
                  response.headers.get('x-generation-id') ?? undefined;
                return response;
              },
            }),
          });
          const result = yield* Effect.tryPromise({
            try: () =>
              chatSend(
                client,
                { chatRequest },
                { signal, headers: { 'X-Title': 'TeXRA.ai' } },
              ),
            catch: transportFailure,
          });
          if (!result.ok) return yield* requestFailure(result.error);
          if (!(result.value instanceof ReadableStream))
            return yield* new ModelError({
              kind: 'malformed-output',
              message: 'OpenRouter answered a streamed request without SSE.',
            });
          reader = result.value.getReader();
          const body = reader;

          let fingerprint: string | null = null;
          let finished: (typeof FINISH_REASONS)[number] | undefined;
          let usage: TurnResult['usage'] = null;
          let serviceTier: string | null | undefined;
          let plain: string | null | undefined;
          let details: Detail[] | undefined;
          let observedIdentity = false;
          const assistant = chatDeltaAccumulator();
          const progress = pullStream(() => body.read(), streamFailure).pipe(
            Stream.mapEffect((chunk) =>
              Effect.gen(function* () {
                if (
                  (responseId !== undefined && chunk.id !== responseId) ||
                  (returnedModel !== undefined && chunk.model !== returnedModel)
                )
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'OpenRouter changed the response identity.',
                  });
                // An empty identity is no identity, as the canonical result spells it.
                responseId ??= chunk.id === '' ? undefined : chunk.id;
                returnedModel ??= chunk.model === '' ? undefined : chunk.model;
                if (chunk.error !== undefined)
                  return yield* new ModelError({
                    kind: authOrRejectionKind(chunk.error.code),
                    message: chunk.error.message,
                    cause: chunk.error,
                  });
                if (chunk.choices.length > 1)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'OpenRouter returned more than one choice.',
                  });
                if (chunk.serviceTier !== undefined) {
                  if (
                    serviceTier != null &&
                    chunk.serviceTier != null &&
                    serviceTier !== chunk.serviceTier
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the reported service tier.',
                    });
                  if (serviceTier === undefined || chunk.serviceTier !== null)
                    serviceTier = chunk.serviceTier;
                }
                if (chunk.systemFingerprint !== undefined) {
                  if (
                    fingerprint !== null &&
                    fingerprint !== chunk.systemFingerprint
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the model fingerprint.',
                    });
                  fingerprint = chunk.systemFingerprint;
                }
                if (chunk.usage !== undefined) {
                  const receipt = canonicalUsage(chunk.usage);
                  if (usage !== null && !isDeepStrictEqual(usage, receipt))
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'OpenRouter returned contradictory usage receipts.',
                    });
                  usage = receipt;
                }
                const choice = chunk.choices[0];
                if (choice?.finishReason === 'error')
                  return yield* new ModelError({
                    kind: 'provider-rejection',
                    message: 'OpenRouter reported a failed generation.',
                    cause: chunk,
                  });
                const events: TurnEvent[] = [];
                if (responseId !== undefined && !observedIdentity) {
                  observedIdentity = true;
                  events.push({
                    kind: 'identified',
                    providerResponseId: responseId,
                    requestedOrigin: origin,
                    returnedModel: returnedModel ?? null,
                  });
                }
                if (choice !== undefined) {
                  const delta = choice.delta;
                  if (
                    choice.index !== 0 ||
                    delta.audio !== undefined ||
                    choice.logprobs != null
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'OpenRouter returned unsupported or malformed stream content.',
                    });
                  const received: Detail[] = [];
                  for (const detail of delta.reasoningDetails ?? []) {
                    const canonical = canonicalDetail(detail);
                    if (canonical === undefined)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'OpenRouter returned an unknown or malformed reasoning detail.',
                      });
                    received.push(canonical);
                  }
                  const hasContent =
                    (delta.content != null && delta.content !== '') ||
                    (delta.refusal != null && delta.refusal !== '') ||
                    (delta.reasoning != null && delta.reasoning !== '') ||
                    received.length > 0 ||
                    (delta.toolCalls?.length ?? 0) > 0;
                  if (
                    hasContent &&
                    (!observedIdentity || finished !== undefined)
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'OpenRouter emitted content without an identity or after completion.',
                    });
                  if (typeof delta.reasoning === 'string')
                    plain = (plain ?? '') + delta.reasoning;
                  else if (delta.reasoning === null && plain === undefined)
                    plain = null;
                  if (delta.reasoningDetails !== undefined) {
                    details ??= [];
                    details.push(...received);
                  }
                  // Display one representation; both originals remain in evidence.
                  const visibleReasoning = received.length
                    ? received
                        .map((detail) => {
                          if (detail.kind === 'text') return detail.text ?? '';
                          if (detail.kind === 'summary') return detail.summary;
                          return '';
                        })
                        .join('')
                    : (delta.reasoning ?? '');
                  events.push(
                    ...assistant.absorbText({
                      reasoning: visibleReasoning,
                      text: delta.content,
                      refusal: delta.refusal,
                    }),
                  );
                  if ((delta.toolCalls?.length ?? 0) > 0)
                    events.push(...assistant.closePhase());
                  yield* assistant.absorbToolCalls(
                    delta.toolCalls?.map((call) => ({
                      index: call.index,
                      id: call.id,
                      type: call.type === undefined ? undefined : 'function',
                      function: call.function,
                    })),
                    'OpenRouter changed a local tool-call identity.',
                  );
                  if (choice.finishReason !== null) {
                    const reason = FINISH_REASONS.find(
                      (known) => known === choice.finishReason,
                    );
                    if (reason === undefined)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'OpenRouter returned an unknown finish reason.',
                      });
                    if (finished !== undefined && finished !== reason)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'OpenRouter changed the finish reason.',
                      });
                    finished = reason;
                  }
                }
                return events;
              }),
            ),
            Stream.flattenIterable,
          );
          const completion = Stream.fromEffect(
            Effect.gen(function* () {
              if (finished === undefined || responseId === undefined)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'OpenRouter ended without an identified terminal result.',
                });
              const toolCalls = assistant.toolCalls();
              if ((finished === 'tool_calls') !== toolCalls.length > 0)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'OpenRouter returned inconsistent tool calls and finish reason.',
                });
              const content: Part[] = [];
              if (plain !== undefined || details !== undefined)
                content.push({
                  kind: 'reasoning',
                  summary: [],
                  evidence: {
                    kind: 'openrouter-reasoning',
                    ...(plain !== undefined ? { plain } : {}),
                    ...(details !== undefined ? { details } : {}),
                  },
                });
              if (assistant.parts.length > 0)
                content.push({ kind: 'message', content: assistant.parts });
              const ids = new Set<string>();
              for (const [ordinal, [index, call]] of toolCalls.entries()) {
                if (
                  index !== ordinal ||
                  call.id === undefined ||
                  call.name === undefined ||
                  ids.has(call.id)
                )
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'OpenRouter returned incomplete or duplicate local tool calls.',
                  });
                yield* parseInboundToolArguments(call.arguments, 'OpenRouter');
                ids.add(call.id);
                content.push({
                  kind: 'local-call',
                  providerCallId: call.id,
                  name: call.name,
                  // The accumulated delta bytes, validated above.
                  argumentsText: call.arguments,
                });
              }
              if (serviceTier !== undefined)
                usage = {
                  ...(usage ?? chatUsageCounts({})),
                  providerUsage: {
                    ...usage?.providerUsage,
                    kind: 'openrouter',
                    serviceTier,
                  },
                };
              let finishReason: string = finished;
              if (finished === 'tool_calls') finishReason = 'tool-calls';
              if (finished === 'content_filter')
                finishReason = 'content-filter';
              const result = TurnResultSchema.safeParse({
                kind: 'http',
                providerResponseId: responseId,
                requestedOrigin: origin,
                returnedModel: returnedModel ?? null,
                modelFingerprint: fingerprint,
                content,
                finishReason,
                usage,
              });
              if (!result.success)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'OpenRouter returned inconsistent completed content.',
                  cause: result.error,
                });
              const events: TurnEvent[] = assistant.closePhase();
              events.push({ kind: 'completed', result: result.data });
              return events;
            }),
          ).pipe(Stream.flattenIterable);
          return Stream.concat(progress, completion).pipe(
            Stream.mapError(enrich),
          );
        }).pipe(Effect.mapError(enrich)),
      );
    });
  const generateTurn: Model['generateTurn'] = (turn) =>
    completedTurn(streamTurn(turn));
  return { prepareTurn, streamTurn, generateTurn };
}
