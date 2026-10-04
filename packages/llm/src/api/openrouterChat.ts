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
import { assembleTurn } from './assembleTurn.js';
import {
  ModelConfigurationSchema,
  ResolvedTurnSchema,
  type Model,
  type OpenRouterConfiguration,
  type ResolvedTurn,
  type TurnResult,
} from '../turn.js';
import { decodeTurnRequest } from './turnInput.js';
import { replayableHistory, systemUpdateText } from '../message.js';
import { originOf, sameModelOrigin } from '../protocol.js';
import {
  ModelError,
  authOrRejectionKind,
  enrichModelError,
  hasErrorField,
  parseJsonOrModelError,
  sdkModelError,
} from '../errors.js';
import {
  chatToolResultMessages,
  pullStream,
  readerAbortSignal,
} from './transport.js';
import type { PartEvent } from './parts.js';
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
const FINISH = {
  stop: 'stop',
  length: 'length',
  content_filter: 'content-filter',
  tool_calls: 'tool-calls',
} as const;

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

/** The canonical receipt of one SDK usage object; absent counts stay unknown. */
const canonicalUsage = (
  usage: ChatUsage,
): NonNullable<TurnResult['usage']> => ({
  inputTokens: usage.promptTokens ?? null,
  outputTokens: usage.completionTokens ?? null,
  totalTokens: usage.totalTokens ?? null,
  cachedInputTokens: usage.promptTokensDetails?.cachedTokens ?? null,
  reasoningTokens: usage.completionTokensDetails?.reasoningTokens ?? null,
  providerUsage: {
    kind: 'openrouter',
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    ...(usage.isByok !== undefined ? { isByok: usage.isByok } : {}),
    ...(usage.promptTokensDetails !== undefined
      ? {
          inputDetails: usage.promptTokensDetails && {
            cacheWriteTokens: usage.promptTokensDetails.cacheWriteTokens,
          },
        }
      : {}),
  },
});

/**
 * One Chat completion's chunks as parts. Chat has no item positions: the
 * reasoning and the message are one part each, ahead of the tool calls by
 * their own index, so the codec opens both with the first content and
 * closes them, filled or empty, at EOF.
 */
function chatWire(responseId: string | undefined) {
  const fail = (message: string) =>
    Effect.fail(new ModelError({ kind: 'malformed-output', message }));
  let identified = responseId !== undefined;
  let finished = false;
  let opened = false;
  let sawText = false;
  let plain: string | null | undefined;
  let details: Detail[] | undefined;
  let usage: TurnResult['usage'] = null;
  const calls = new Set<number>();

  const parts = (
    chunk: ChatStreamChunk,
  ): Effect.Effect<PartEvent[], ModelError> =>
    Effect.gen(function* () {
      if (chunk.error !== undefined)
        return yield* new ModelError({
          kind: authOrRejectionKind(chunk.error.code),
          message: chunk.error.message,
          cause: chunk.error,
        });
      if (chunk.choices.length > 1)
        return yield* fail('OpenRouter returned more than one choice.');
      const events: PartEvent[] = [
        {
          kind: 'identity',
          // An empty identity is no identity, as the canonical result spells it.
          id: chunk.id || null,
          model: chunk.model || null,
          ...(chunk.systemFingerprint !== undefined && {
            fingerprint: chunk.systemFingerprint,
          }),
        },
      ];
      identified ||= chunk.id !== '';
      if (chunk.usage !== undefined) {
        const receipt = canonicalUsage(chunk.usage);
        if (usage !== null && !isDeepStrictEqual(usage, receipt))
          return yield* fail(
            'OpenRouter returned contradictory usage receipts.',
          );
        usage = receipt;
        events.push({ kind: 'usage', usage });
      }
      const choice = chunk.choices[0];
      if (choice?.finishReason === 'error')
        return yield* new ModelError({
          kind: 'provider-rejection',
          message: 'OpenRouter reported a failed generation.',
          cause: chunk,
        });
      if (choice === undefined) return events;
      const delta = choice.delta;
      if (
        choice.index !== 0 ||
        delta.audio !== undefined ||
        choice.logprobs != null
      )
        return yield* fail(
          'OpenRouter returned unsupported or malformed stream content.',
        );
      const received: Detail[] = [];
      for (const detail of delta.reasoningDetails ?? []) {
        const canonical = canonicalDetail(detail);
        if (canonical === undefined)
          return yield* fail(
            'OpenRouter returned an unknown or malformed reasoning detail.',
          );
        received.push(canonical);
      }
      const toolCalls = delta.toolCalls ?? [];
      const hasContent =
        !!delta.content ||
        !!delta.refusal ||
        !!delta.reasoning ||
        received.length > 0 ||
        toolCalls.length > 0;
      if (hasContent && (!identified || finished))
        return yield* fail(
          'OpenRouter emitted content without an identity or after completion.',
        );
      if (typeof delta.reasoning === 'string')
        plain = (plain ?? '') + delta.reasoning;
      else if (delta.reasoning === null && plain === undefined) plain = null;
      if (delta.reasoningDetails !== undefined)
        details = [...(details ?? []), ...received];
      if (!opened && identified && !finished) {
        opened = true;
        events.push(
          {
            kind: 'open',
            index: 0,
            part: { kind: 'reasoning', summary: [], evidence: null },
          },
          { kind: 'open', index: 1, part: { kind: 'message', content: [] } },
        );
      }
      // Display one representation; both originals remain in evidence.
      const reasoning = received.length
        ? received
            .map((detail) => {
              if (detail.kind === 'text') return detail.text ?? '';
              if (detail.kind === 'summary') return detail.summary;
              return '';
            })
            .join('')
        : (delta.reasoning ?? '');
      for (const [index, channel, text] of [
        [0, 'reasoning', reasoning],
        [1, 'text', delta.content],
        [1, 'refusal', delta.refusal],
      ] as const) {
        if (!text) continue;
        sawText ||= index === 1;
        events.push({ kind: 'append', index, channel, text });
      }
      for (const call of toolCalls) {
        calls.add(call.index);
        events.push({
          kind: 'open',
          index: 2 + call.index,
          part: {
            kind: 'local-call',
            providerCallId: call.id ?? '',
            name: call.function?.name ?? '',
            argumentsText: '',
          },
        });
        // The provider's own argument bytes, never a re-encoded parse.
        if (call.function?.arguments)
          events.push({
            kind: 'append',
            index: 2 + call.index,
            channel: 'arguments',
            text: call.function.arguments,
          });
      }
      if (choice.finishReason === null) return events;
      const finishReason = Object.entries(FINISH).find(
        ([wire]) => wire === choice.finishReason,
      )?.[1];
      if (finishReason === undefined)
        return yield* fail('OpenRouter returned an unknown finish reason.');
      finished = true;
      events.push({ kind: 'finish', finish: { finishReason } });
      return events;
    }).pipe(
      // A chunk that fails still names the response it belongs to.
      Effect.mapError((error) =>
        enrichModelError(error, {
          responseId: error.responseId ?? (chunk.id || undefined),
          model: error.model ?? (chunk.model || undefined),
        }),
      ),
    );

  /** At EOF the reasoning, the message and every call close. */
  const end = (): PartEvent[] =>
    opened
      ? [
          {
            kind: 'close',
            index: 0,
            content:
              plain === undefined && details === undefined
                ? null
                : {
                    kind: 'reasoning',
                    summary: [],
                    evidence: {
                      kind: 'openrouter-reasoning',
                      ...(plain !== undefined ? { plain } : {}),
                      ...(details !== undefined ? { details } : {}),
                    },
                  },
          },
          { kind: 'close', index: 1, ...(sawText ? {} : { content: null }) },
          ...[...calls].map((index): PartEvent => ({
            kind: 'close',
            index: 2 + index,
          })),
        ]
      : [];
  return { parts, end };
}

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
  for (const message of replayableHistory(turn.messages, turn)) {
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
    // User text, not a system message: OpenRouter routes to upstreams that
    // take system text only at the head, where the update would land in
    // front of the cached prefix it is appended after.
    if (message.role === 'system') {
      messages.push({ role: 'user', content: systemUpdateText(message.text) });
      continue;
    }
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
  const origin = originOf(config);
  const http = transport.fetch ?? globalThis.fetch;
  const prepareTurn: Model['prepareTurn'] = Effect.fn('llm.prepareTurn')(
    function* (request) {
      const authored = yield* decodeTurnRequest(
        request,
        'OpenRouter requires supported materialized input.',
      );
      if (
        authored.mode === 'background' ||
        authored.store !== undefined ||
        authored.continuation !== undefined
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
          temperature: config.defaults.temperature,
          effort: config.defaults.effort,
          stopSequences: config.defaults.stopSequences,
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
      let requestId: string | undefined;
      const enrich = (error: ModelError) =>
        enrichModelError(error, {
          responseId: error.responseId ?? responseId,
          requestId,
          model: error.model ?? config.requestedModel,
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

          const wire = chatWire(responseId);
          return assembleTurn(
            Stream.concat(
              pullStream(() => body.read(), streamFailure).pipe(
                Stream.mapEffect(wire.parts),
              ),
              Stream.sync(wire.end),
            ),
            { origin, provider: 'OpenRouter', responseId },
          ).pipe(Stream.mapError(enrich));
        }).pipe(Effect.mapError(enrich)),
      );
    });
  return { prepareTurn, streamTurn };
}
