// Node.js imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Result, Schema, Stream } from 'effect';
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type HttpClientResponse,
} from 'effect/http';

// Local imports - canonical model contract
import { assembleTurn } from './assembleTurn.js';
import {
  decodeModelConfiguration,
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
  fillModelError,
  hasErrorField,
  parseJsonOrModelError,
  sdkModelError,
} from '../errors.js';
import {
  chatChunks,
  type ChatMessage,
  type ChatRequest,
  type ChatStreamChunk,
  type ChatUsage,
  type ContentItem,
  type ReasoningDetail,
} from './openrouterChatWire.js';
import type { Sse } from 'effect/encoding';
import type { PartEvent } from './parts.js';

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

/** An HTTP rejection body. */
const ErrorSchema = Schema.Struct({
  code: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  message: Schema.String,
});

/** One wire reasoning detail as canonical evidence. */
const canonicalDetail = (detail: ReasoningDetail): Detail => {
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
        toolName: detail.tool_name,
        ...(detail.tool_call_id !== undefined
          ? { toolCallId: detail.tool_call_id }
          : {}),
        arguments: detail.arguments,
        result: detail.result,
      };
  }
};

/** The canonical receipt of one usage object; absent counts stay unknown. */
const canonicalUsage = (
  usage: ChatUsage,
): NonNullable<TurnResult['usage']> => ({
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  totalTokens: usage.total_tokens,
  cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
  reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
  providerUsage: {
    kind: 'openrouter',
    ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
    ...(usage.is_byok !== undefined ? { isByok: usage.is_byok } : {}),
    ...(usage.prompt_tokens_details !== undefined
      ? {
          inputDetails: usage.prompt_tokens_details && {
            cacheWriteTokens: usage.prompt_tokens_details.cache_write_tokens,
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
          id: chunk.id,
          model: chunk.model,
          ...(chunk.system_fingerprint !== undefined && {
            fingerprint: chunk.system_fingerprint,
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
      if (choice?.finish_reason === 'error')
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
      const received = (delta.reasoning_details ?? []).map(canonicalDetail);
      const toolCalls = delta.tool_calls ?? [];
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
      if (delta.reasoning_details !== undefined)
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
      if (choice.finish_reason === null) return events;
      const finishReason = Object.entries(FINISH).find(
        ([wire]) => wire === choice.finish_reason,
      )?.[1];
      if (finishReason === undefined)
        return yield* fail('OpenRouter returned an unknown finish reason.');
      finished = true;
      events.push({ kind: 'finish', finish: { finishReason } });
      return events;
    }).pipe(
      // A chunk that fails still names the response it belongs to.
      Effect.mapError((error) =>
        fillModelError(error, {
          responseId: chunk.id || undefined,
          model: chunk.model || undefined,
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

/** One canonical reasoning detail as the wire spells it, for replay. */
const wireDetail = (detail: Detail): ReasoningDetail => {
  switch (detail.kind) {
    case 'text': {
      const { kind: _, ...fields } = detail;
      return { ...fields, type: 'reasoning.text' };
    }
    case 'summary': {
      const { kind: _, ...fields } = detail;
      return { ...fields, type: 'reasoning.summary' };
    }
    case 'encrypted': {
      const { kind: _, ...fields } = detail;
      return { ...fields, type: 'reasoning.encrypted' };
    }
    case 'server-tool-call': {
      const { kind: _, toolName, toolCallId, ...fields } = detail;
      return {
        ...fields,
        type: 'reasoning.server_tool_call',
        tool_name: toolName,
        ...(toolCallId !== undefined ? { tool_call_id: toolCallId } : {}),
      };
    }
  }
};

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
  const messages: ChatMessage[] = [];
  if (turn.system !== undefined)
    messages.push({ role: 'system', content: turn.system });
  let calls: Extract<Part, { kind: 'local-call' }>[] = [];
  for (const message of replayableHistory(turn.messages, turn)) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        if (result.content.some((part) => part.kind !== 'text'))
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'OpenRouter tool results require materialized text.',
          });
        const text = result.content
          .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
          .join('');
        messages.push({
          role: 'tool',
          // The canonical grammar guarantees adjacent, complete ordinals.
          tool_call_id: calls[result.callOrdinal].providerCallId,
          content: result.status === 'error' ? `Error: ${text}` : text,
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
      const content: ContentItem[] = [];
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
            image_url: {
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
            file: { file_data: `data:${part.mimeType};base64,${part.base64}` },
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
            input_audio: { data: part.base64, format },
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
        ? { reasoning_details: reasoning.details.map(wireDetail) }
        : {}),
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
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
    max_completion_tokens: controls.maxOutputTokens,
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
          tool_choice:
            controls.toolChoice === 'auto'
              ? ('auto' as const)
              : {
                  type: 'function' as const,
                  function: { name: controls.toolChoice.name },
                },
        }
      : {}),
  } satisfies ChatRequest;
});

/**
 * OpenRouter Chat over Effect's `HttpClient`, its stream parsed by Effect's
 * SSE parser and decoded by Effect Schema; selected credentials and the
 * `fetch` under the client are explicit. Nothing here retries: the run's
 * retry gate owns every retry.
 */
export function openrouterChatModel(
  configuration: OpenRouterConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = decodeModelConfiguration(configuration);
  if (config.protocol !== 'openrouter-chat')
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements OpenRouter Chat.',
    });
  const origin = originOf(config);
  const http = transport.fetch ?? globalThis.fetch;
  const endpoint = config.deployment.endpoint.replace(/\/$/, '');
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
      const prepared = Schema.decodeUnknownResult(ResolvedTurnSchema)({
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
      const resolved = Result.getOrUndefined(prepared);
      if (resolved?.protocol !== 'openrouter-chat')
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'OpenRouter cannot prepare these controls.',
          cause: Result.isFailure(prepared) ? prepared.failure : undefined,
        });
      yield* requestBody(resolved, config);
      return resolved;
    },
  );

  const streamTurn: Model['streamTurn'] = (turn) =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let requestId: string | undefined;
      const enrich = (error: ModelError) =>
        fillModelError(error, {
          responseId,
          requestId,
          model: config.requestedModel,
        });
      // Only the underlying cause: the client error also holds the request,
      // whose headers carry the API key.
      const transportFailure = (error: HttpClientError.HttpClientError) =>
        new ModelError({
          kind: 'transport',
          message: 'The OpenRouter connection failed.',
          cause: error.reason.cause ?? error.reason,
        });
      // A decoder's refusal of a streamed event is the provider's output; a
      // failed read is the connection.
      const streamFailure = (
        error:
          HttpClientError.HttpClientError | Sse.SseError | Schema.SchemaError,
      ) =>
        HttpClientError.isHttpClientError(error)
          ? transportFailure(error)
          : new ModelError({
              kind: 'malformed-output',
              message:
                'OpenRouter returned unsupported or malformed stream content.',
              cause: error,
            });
      /** A reply that is not a stream: a rejection, read from its body. */
      const rejection = Effect.fn('llm.openrouterRejection')(function* (
        response: HttpClientResponse.HttpClientResponse,
      ) {
        const status = response.status;
        if (status < 400)
          return yield* new ModelError({
            kind: 'malformed-output',
            message: 'OpenRouter returned an unexpected response.',
            status,
          });
        // Status, request id and any retry-after delay come from the reply;
        // the kind and message come from its body.
        const failure = sdkModelError(
          undefined,
          {
            status,
            headers: new globalThis.Headers(response.headers),
            requestId: requestId ?? null,
          },
          `OpenRouter rejected the request (HTTP ${status}).`,
        );
        const text = yield* response.text.pipe(
          Effect.mapError(transportFailure),
        );
        const raw = yield* parseJsonOrModelError(text, (cause) =>
          enrichModelError(failure, {
            kind: 'provider-rejection',
            message: `OpenRouter rejected the request (HTTP ${status}).`,
            cause,
          }),
        );
        const payload = hasErrorField(raw) ? raw.error : raw;
        const parsed = Schema.decodeUnknownResult(ErrorSchema)(payload);
        return yield* Result.isSuccess(parsed)
          ? enrichModelError(failure, {
              kind: authOrRejectionKind(status, parsed.success.code),
              message: parsed.success.message,
              cause: payload,
            })
          : enrichModelError(failure, {
              kind: 'malformed-output',
              message: 'OpenRouter returned a malformed error receipt.',
              cause: payload,
            });
      });
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
          // The request lives as long as this stream: closing it cancels the
          // body, then aborts the fetch.
          const client = HttpClient.withScope(yield* HttpClient.HttpClient);
          const response = yield* client
            .execute(
              HttpClientRequest.post(`${endpoint}/chat/completions`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${transport.apiKey}`,
                  Accept: 'text/event-stream',
                  'X-Title': 'TeXRA.ai',
                }),
                HttpClientRequest.bodyJsonUnsafe(chatRequest),
              ),
            )
            .pipe(Effect.mapError(transportFailure));
          requestId = response.headers['x-request-id'];
          responseId = response.headers['x-generation-id'];
          if (response.status < 200 || response.status >= 300)
            return yield* rejection(response);
          if (!response.headers['content-type']?.includes('text/event-stream'))
            return yield* new ModelError({
              kind: 'malformed-output',
              message: 'OpenRouter answered a streamed request without SSE.',
            });
          const wire = chatWire(responseId);
          return assembleTurn(
            chatChunks(response.stream).pipe(
              Stream.mapError(streamFailure),
              Stream.mapEffect(wire.parts),
              Stream.concat(Stream.sync(wire.end)),
            ),
            { origin, provider: 'OpenRouter', responseId },
          ).pipe(Stream.mapError(enrich));
        }).pipe(Effect.mapError(enrich)),
      );
    }).pipe(
      Stream.provide(FetchHttpClient.layer),
      Stream.provideService(FetchHttpClient.Fetch, http),
      // OpenRouter is a third party: no trace context leaves this process.
      Stream.provideService(HttpClient.TracerPropagationEnabled, false),
    );
  return { prepareTurn, streamTurn };
}
