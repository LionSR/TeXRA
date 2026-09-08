// Node.js imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Cause, Effect, Exit, Stream } from 'effect';
import { Sse } from 'effect/unstable/encoding';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  JsonObjectSchema,
  ModelConfigurationSchema,
  ModelError,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  sameModelOrigin,
  type Model,
  type OpenRouterConfiguration,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from './turn.js';

type OpenRouterTurn = Extract<ResolvedTurn, { protocol: 'openrouter-chat' }>;
type Part = TurnResult['content'][number];
type Reasoning = Extract<
  NonNullable<Extract<Part, { kind: 'reasoning' }>['evidence']>,
  { kind: 'openrouter-reasoning' }
>;
type Annotation = Extract<Part, { kind: 'file-annotation' | 'url-citation' }>;

const DetailMetadataSchema = z.strictObject({
  format: z.string().nullish(),
  id: z.string().nullish(),
  index: z.number().optional(),
});
const DetailSchema = z
  .discriminatedUnion('type', [
    DetailMetadataSchema.extend({
      type: z.literal('reasoning.text'),
      text: z.string().nullish(),
      signature: z.string().nullish(),
    }),
    DetailMetadataSchema.extend({
      type: z.literal('reasoning.summary'),
      summary: z.string(),
    }),
    DetailMetadataSchema.extend({
      type: z.literal('reasoning.encrypted'),
      data: z.string(),
    }),
    DetailMetadataSchema.extend({
      type: z.literal('reasoning.server_tool_call'),
      tool_name: z.string(),
      tool_call_id: z.string().nullish(),
      arguments: z.string(),
      result: z.string(),
    }),
  ])
  .transform((detail): NonNullable<Reasoning['details']>[number] => {
    switch (detail.type) {
      case 'reasoning.text': {
        const { type: _, ...fields } = detail;
        return { ...fields, kind: 'text' };
      }
      case 'reasoning.summary': {
        const { type: _, ...fields } = detail;
        return { ...fields, kind: 'summary' };
      }
      case 'reasoning.encrypted': {
        const { type: _, ...fields } = detail;
        return { ...fields, kind: 'encrypted' };
      }
      case 'reasoning.server_tool_call': {
        const { type: _, tool_name, tool_call_id, ...rest } = detail;
        return {
          ...rest,
          kind: 'server-tool-call',
          toolName: tool_name,
          ...(tool_call_id !== undefined ? { toolCallId: tool_call_id } : {}),
        };
      }
    }
  });
const FileAnnotationSchema = z
  .strictObject({
    type: z.literal('file'),
    file: z.strictObject({
      hash: z.string(),
      name: z.string().optional(),
      content: z
        .array(
          z.discriminatedUnion('type', [
            z.strictObject({ type: z.literal('text'), text: z.string() }),
            z.strictObject({
              type: z.literal('image_url'),
              image_url: z.strictObject({ url: z.string() }),
            }),
          ]),
        )
        .optional(),
    }),
  })
  .transform(({ file }): Extract<Annotation, { kind: 'file-annotation' }> => ({
    kind: 'file-annotation',
    hash: file.hash,
    ...(file.name !== undefined ? { name: file.name } : {}),
    ...(file.content !== undefined
      ? {
          content: file.content.map((part) =>
            part.type === 'text'
              ? { kind: 'text' as const, text: part.text }
              : { kind: 'image-url' as const, url: part.image_url.url },
          ),
        }
      : {}),
    evidence: { kind: 'openrouter-file-annotation' },
  }));
const AnnotationSchema = z.union([
  FileAnnotationSchema,
  z
    .strictObject({
      type: z.literal('url_citation'),
      url_citation: z.strictObject({
        url: z.string(),
        title: z.string().optional(),
        start_index: z.number().optional(),
        end_index: z.number().optional(),
        content: z.string().optional(),
      }),
    })
    .transform(
      ({
        url_citation: item,
      }): Extract<Annotation, { kind: 'url-citation' }> => ({
        kind: 'url-citation',
        url: item.url,
        ...(item.title !== undefined ? { title: item.title } : {}),
        ...(item.start_index !== undefined
          ? { startIndex: item.start_index }
          : {}),
        ...(item.end_index !== undefined ? { endIndex: item.end_index } : {}),
        ...(item.content !== undefined ? { content: item.content } : {}),
        evidence: { kind: 'openrouter-url-citation' },
      }),
    ),
]);
const CountSchema = z.int().nonnegative().nullish();
const UsageSchema = z
  .strictObject({
    prompt_tokens: CountSchema,
    completion_tokens: CountSchema,
    total_tokens: CountSchema,
    cost: z.number().nullish(),
    is_byok: z.boolean().optional(),
    cost_details: z
      .strictObject({
        upstream_inference_cost: z.number().nullish(),
        upstream_inference_prompt_cost: z.number().nullish(),
        upstream_inference_completions_cost: z.number().nullish(),
        server_tool_cost: z.number().nullish(),
      })
      .nullish(),
    prompt_tokens_details: z
      .strictObject({
        cached_tokens: CountSchema,
        cache_write_tokens: CountSchema,
        audio_tokens: CountSchema,
        video_tokens: CountSchema,
      })
      .nullish(),
    completion_tokens_details: z
      .strictObject({
        reasoning_tokens: CountSchema,
        audio_tokens: CountSchema,
        accepted_prediction_tokens: CountSchema,
        rejected_prediction_tokens: CountSchema,
        image_tokens: CountSchema,
      })
      .nullish(),
    server_tool_use_details: z
      .strictObject({
        tool_calls_requested: CountSchema,
        tool_calls_executed: CountSchema,
        web_search_requests: CountSchema,
      })
      .nullish(),
  })
  .transform((usage): NonNullable<TurnResult['usage']> => ({
    inputTokens: usage.prompt_tokens ?? null,
    outputTokens: usage.completion_tokens ?? null,
    totalTokens: usage.total_tokens ?? null,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? null,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens ?? null,
    providerUsage: {
      kind: 'openrouter',
      ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
      ...(usage.is_byok !== undefined ? { isByok: usage.is_byok } : {}),
      ...(usage.cost_details !== undefined
        ? {
            costDetails:
              usage.cost_details === null
                ? null
                : {
                    upstreamInferenceCost:
                      usage.cost_details.upstream_inference_cost,
                    upstreamInferencePromptCost:
                      usage.cost_details.upstream_inference_prompt_cost,
                    upstreamInferenceCompletionsCost:
                      usage.cost_details.upstream_inference_completions_cost,
                    serverToolCost: usage.cost_details.server_tool_cost,
                  },
          }
        : {}),
      ...(usage.prompt_tokens_details !== undefined
        ? {
            inputDetails:
              usage.prompt_tokens_details === null
                ? null
                : {
                    cacheWriteTokens:
                      usage.prompt_tokens_details.cache_write_tokens,
                    audioTokens: usage.prompt_tokens_details.audio_tokens,
                    videoTokens: usage.prompt_tokens_details.video_tokens,
                  },
          }
        : {}),
      ...(usage.completion_tokens_details !== undefined
        ? {
            outputDetails:
              usage.completion_tokens_details === null
                ? null
                : {
                    audioTokens: usage.completion_tokens_details.audio_tokens,
                    acceptedPredictionTokens:
                      usage.completion_tokens_details
                        .accepted_prediction_tokens,
                    rejectedPredictionTokens:
                      usage.completion_tokens_details
                        .rejected_prediction_tokens,
                    imageTokens: usage.completion_tokens_details.image_tokens,
                  },
          }
        : {}),
      ...(usage.server_tool_use_details !== undefined
        ? {
            serverToolUseDetails:
              usage.server_tool_use_details === null
                ? null
                : {
                    toolCallsRequested:
                      usage.server_tool_use_details.tool_calls_requested,
                    toolCallsExecuted:
                      usage.server_tool_use_details.tool_calls_executed,
                    webSearchRequests:
                      usage.server_tool_use_details.web_search_requests,
                  },
          }
        : {}),
    },
  }));
const IdentitySchema = z.object({
  id: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
});
const ChunkSchema = IdentitySchema.extend({
  usage: UsageSchema.nullish(),
  service_tier: z.string().nullish(),
  system_fingerprint: z.string().nullish(),
  choices: z
    .array(
      z.object({
        index: z.literal(0).nullish(),
        finish_reason: z
          .enum(['stop', 'length', 'content_filter', 'tool_calls', 'error'])
          .nullish(),
        native_finish_reason: z.string().nullish(),
        delta: z
          .strictObject({
            role: z.literal('assistant').optional(),
            content: z.string().nullish(),
            refusal: z.string().nullish(),
            // Empty image placeholders carry no generated media in this route.
            images: z.array(z.never()).nullish(),
            reasoning: z.string().nullish(),
            reasoning_details: z.array(DetailSchema).nullish(),
            annotations: z.array(AnnotationSchema).nullish(),
            tool_calls: z
              .array(
                z.strictObject({
                  index: z.int().nonnegative(),
                  id: z.string().min(1).nullish(),
                  type: z.literal('function').nullish(),
                  function: z
                    .strictObject({
                      name: z.string().min(1).nullish(),
                      arguments: z.string().nullish(),
                    })
                    .optional(),
                }),
              )
              .nullish(),
          })
          .nullish(),
        logprobs: z.null().optional(),
      }),
    )
    .max(1),
});
const ErrorSchema = z.looseObject({
  code: z.union([z.string(), z.number()]).optional(),
  message: z.string(),
  metadata: z
    .looseObject({ file_annotations: z.array(FileAnnotationSchema).optional() })
    .optional(),
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
  const messages: Record<string, unknown>[] = [];
  if (turn.system !== undefined)
    messages.push({ role: 'system', content: turn.system });
  let calls: Extract<Part, { kind: 'local-call' }>[] = [];
  for (const message of turn.messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        if (result.content.some((part) => part.kind !== 'text'))
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'OpenRouter tool results require materialized text.',
          });
        const text = result.content
          .map((part) => (part.kind === 'text' ? part.text : ''))
          .join('');
        messages.push({
          role: 'tool',
          tool_call_id: calls[result.callOrdinal].providerCallId,
          content: result.status === 'error' ? `Error: ${text}` : text,
        });
      }
      continue;
    }
    calls = [];
    if (message.role === 'user') {
      const content: Record<string, unknown>[] = [];
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
    const annotations: Record<string, unknown>[] = [];
    for (const part of message.content) {
      if (
        part.kind === 'message' &&
        part.evidence === undefined &&
        text === undefined &&
        refusal === undefined &&
        calls.length === 0 &&
        annotations.length === 0
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
        annotations.length === 0 &&
        sameModelOrigin(message.origin, turn)
      ) {
        reasoning = part.evidence;
      } else if (
        part.kind === 'local-call' &&
        part.evidence === undefined &&
        annotations.length === 0
      )
        calls.push(part);
      else if (
        part.kind === 'file-annotation' &&
        sameModelOrigin(message.origin, turn)
      ) {
        annotations.push({
          type: 'file',
          file: {
            hash: part.hash,
            ...(part.name !== undefined ? { name: part.name } : {}),
            ...(part.content !== undefined
              ? {
                  content: part.content.map((item) =>
                    item.kind === 'text'
                      ? { type: 'text', text: item.text }
                      : { type: 'image_url', image_url: { url: item.url } },
                  ),
                }
              : {}),
          },
        });
      } else if (
        part.kind === 'url-citation' &&
        sameModelOrigin(message.origin, turn)
      ) {
        annotations.push({
          type: 'url_citation',
          url_citation: {
            url: part.url,
            ...(part.title !== undefined ? { title: part.title } : {}),
            ...(part.startIndex !== undefined
              ? { start_index: part.startIndex }
              : {}),
            ...(part.endIndex !== undefined
              ? { end_index: part.endIndex }
              : {}),
            ...(part.content !== undefined ? { content: part.content } : {}),
          },
        });
      } else
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
            reasoning_details:
              reasoning.details === null
                ? null
                : reasoning.details.map((detail) => {
                    const { kind, ...fields } = detail;
                    if (detail.kind === 'server-tool-call') {
                      const { kind: _, toolName, toolCallId, ...rest } = detail;
                      return {
                        ...rest,
                        type: 'reasoning.server_tool_call',
                        tool_name: toolName,
                        ...(toolCallId !== undefined
                          ? { tool_call_id: toolCallId }
                          : {}),
                      };
                    }
                    return { ...fields, type: `reasoning.${kind}` };
                  }),
          }
        : {}),
      ...(calls.length > 0
        ? {
            tool_calls: calls.map((call) => ({
              id: call.providerCallId,
              type: 'function',
              function: {
                name: call.name,
                arguments: call.argumentsText,
              },
            })),
          }
        : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
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
      ? { stop: controls.stopSequences }
      : {}),
    ...(turn.tools.length > 0
      ? {
          tools: turn.tools.map((tool) => ({
            type: 'function',
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              strict: false,
            },
          })),
          tool_choice:
            controls.toolChoice === 'auto'
              ? 'auto'
              : {
                  type: 'function',
                  function: { name: controls.toolChoice.name },
                },
        }
      : {}),
  };
});

/** Direct OpenRouter HTTP/SSE; selected credentials and transport are explicit. */
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
  const endpoint = new URL(config.deployment.endpoint);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/chat/completions`;
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
        authored.inferenceGeo !== undefined ||
        authored.promptCacheKey !== undefined ||
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

  const streamTurn = (
    input: ResolvedTurn,
  ): Stream.Stream<TurnEvent, ModelError> =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      let requestId: string | undefined;
      const enrich = (error: ModelError) =>
        new ModelError({
          ...error,
          message: error.message,
          cause: error.cause,
          responseId,
          requestId,
          model: returnedModel ?? config.requestedModel,
        });
      const transportFailure = (cause: unknown) =>
        new ModelError({
          kind: 'transport',
          message: 'The OpenRouter connection failed.',
          cause,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const parsed = ResolvedTurnSchema.safeParse(input);
          if (
            !parsed.success ||
            parsed.data.protocol !== 'openrouter-chat' ||
            !sameModelOrigin(parsed.data, origin)
          )
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The prepared turn belongs to another protocol or deployment.',
              cause: parsed.error,
            });
          const turn = parsed.data;
          const parameters = yield* requestBody(turn, config);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
            undefined;
          // The later signal finalizer aborts before cancellation is awaited.
          yield* Effect.addFinalizer((exit) => {
            if (reader === undefined) return Effect.void;
            const body = reader;
            return Effect.tryPromise({
              try: () => body.cancel(),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) => {
                if (
                  (signal.aborted && cause === signal.reason) ||
                  (Exit.isFailure(exit) &&
                    exit.cause.reasons.some(
                      (reason) =>
                        Cause.isFailReason(reason) &&
                        reason.error instanceof ModelError &&
                        reason.error.kind === 'transport' &&
                        reason.error.cause === cause,
                    ))
                )
                  return Effect.void;
                return Effect.die(cause);
              }),
              Effect.ensuring(Effect.sync(() => body.releaseLock())),
            );
          });
          const signal = yield* Effect.abortSignal;
          const response = yield* Effect.tryPromise({
            try: () =>
              http(endpoint.toString(), {
                method: 'POST',
                signal,
                headers: {
                  Authorization: `Bearer ${transport.apiKey}`,
                  'Content-Type': 'application/json',
                  Accept: 'text/event-stream',
                  'X-Title': 'TeXRA.ai',
                },
                body: JSON.stringify(parameters),
              }),
            catch: transportFailure,
          });
          requestId = response.headers.get('x-request-id') ?? undefined;
          responseId = response.headers.get('x-generation-id') ?? undefined;
          if (response.body === null)
            return yield* new ModelError({
              kind: response.ok ? 'malformed-output' : 'provider-rejection',
              message: 'OpenRouter returned no response body.',
              status: response.status,
            });
          reader = response.body.getReader();
          const body = reader;
          const failure = (payload: unknown, status?: number) => {
            const parsedError = ErrorSchema.safeParse(payload);
            if (!parsedError.success)
              return new ModelError({
                kind: 'malformed-output',
                message: 'OpenRouter returned a malformed error receipt.',
                cause: payload,
                status,
              });
            const error = parsedError.data;
            return new ModelError({
              kind:
                status === 401 ||
                status === 403 ||
                error.code === 401 ||
                error.code === 403
                  ? 'authentication'
                  : 'provider-rejection',
              message: error.message,
              status,
              cause: payload,
              ...(error.metadata?.file_annotations !== undefined
                ? {
                    providerEvidence: {
                      kind: 'openrouter' as const,
                      origin,
                      fileAnnotations: error.metadata.file_annotations,
                    },
                  }
                : {}),
            });
          };
          // Reads and classification stay inside the acquired scope: primary failures
          // and distinct cleanup defects are combined by Effect, not reconstructed.
          const bytes = Stream.fromPull(
            Effect.succeed(
              Effect.tryPromise({
                try: () => body.read(),
                catch: transportFailure,
              }).pipe(
                Effect.flatMap((next) =>
                  next.done
                    ? Cause.done()
                    : Effect.succeed([next.value] as const),
                ),
              ),
            ),
          );
          if (!response.ok)
            return Stream.fromEffect(
              Effect.gen(function* () {
                const text = yield* Stream.runFold(
                  bytes.pipe(Stream.decodeText),
                  () => '',
                  (all, chunk) => all + chunk,
                );
                const raw: unknown = yield* Effect.try({
                  try: () => JSON.parse(text),
                  catch: (cause) =>
                    new ModelError({
                      kind: 'provider-rejection',
                      message: `OpenRouter rejected the request (HTTP ${response.status}).`,
                      status: response.status,
                      cause,
                    }),
                });
                return yield* failure(
                  typeof raw === 'object' && raw !== null && 'error' in raw
                    ? raw.error
                    : raw,
                  response.status,
                );
              }).pipe(Effect.mapError(enrich)),
            );

          let observedIdentity = false;
          let fingerprint: string | null = null;
          let finished:
            | Exclude<
                z.infer<typeof ChunkSchema>['choices'][number]['finish_reason'],
                null | undefined
              >
            | undefined;
          let nativeFinishReason: string | null | undefined;
          let usage: TurnResult['usage'] = null;
          let serviceTier: string | null | undefined;
          let plain: string | null | undefined;
          let details:
            NonNullable<Reasoning['details']>[number][] | null | undefined;
          let activePhase: 'reasoning' | 'text' | undefined;
          let sentinel = false;
          const textParts: Array<{ kind: 'text' | 'refusal'; text: string }> =
            [];
          const annotations: Annotation[] = [];
          const calls = new Map<
            number,
            { id?: string; name?: string; arguments: string }
          >();
          let parsedEvents: Sse.Event[] = [];
          const parser = Sse.makeParser(
            (event) => {
              // This one-shot operation ignores reconnect hints and never reconnects.
              if (event._tag === 'Event') parsedEvents.push(event);
            },
            { maxEventSize: Number.POSITIVE_INFINITY },
          );
          const progress = bytes.pipe(
            Stream.decodeText,
            Stream.mapEffect((text) =>
              Effect.gen(function* () {
                parsedEvents = [];
                const error = parser.feed(text);
                if (error !== undefined)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'OpenRouter returned malformed SSE.',
                    cause: error,
                  });
                return parsedEvents;
              }),
            ),
            Stream.flattenIterable,
            Stream.takeUntil((event) => event.data === '[DONE]'),
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                if (event.data === '[DONE]') {
                  sentinel = true;
                  return [];
                }
                const raw: unknown = yield* Effect.try({
                  try: () => JSON.parse(event.data),
                  catch: (cause) =>
                    new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter returned malformed stream JSON.',
                      cause,
                    }),
                });
                const identity = IdentitySchema.safeParse(raw);
                if (identity.success) {
                  if (
                    (identity.data.id !== undefined &&
                      responseId !== undefined &&
                      identity.data.id !== responseId) ||
                    (identity.data.model !== undefined &&
                      returnedModel !== undefined &&
                      identity.data.model !== returnedModel)
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the response identity.',
                    });
                  responseId ??= identity.data.id;
                  returnedModel ??= identity.data.model;
                }
                if (
                  event.event === 'error' ||
                  (typeof raw === 'object' && raw !== null && 'error' in raw)
                )
                  return yield* failure(
                    typeof raw === 'object' && raw !== null && 'error' in raw
                      ? raw.error
                      : raw,
                  );
                const parsedChunk = ChunkSchema.safeParse(raw);
                if (!parsedChunk.success)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'OpenRouter returned unsupported or malformed stream content.',
                    cause: parsedChunk.error,
                  });
                const chunk = parsedChunk.data;
                if (chunk.service_tier !== undefined) {
                  if (
                    serviceTier != null &&
                    chunk.service_tier != null &&
                    serviceTier !== chunk.service_tier
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the reported service tier.',
                    });
                  if (serviceTier === undefined || chunk.service_tier !== null)
                    serviceTier = chunk.service_tier;
                }
                if (chunk.system_fingerprint != null) {
                  if (
                    fingerprint !== null &&
                    fingerprint !== chunk.system_fingerprint
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the model fingerprint.',
                    });
                  fingerprint = chunk.system_fingerprint;
                }
                if (chunk.usage != null) {
                  if (usage !== null && !isDeepStrictEqual(usage, chunk.usage))
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'OpenRouter returned contradictory usage receipts.',
                    });
                  usage = chunk.usage;
                }
                const choice = chunk.choices[0];
                if (choice?.finish_reason === 'error')
                  return yield* new ModelError({
                    kind: 'provider-rejection',
                    message: 'OpenRouter reported a failed generation.',
                    cause: raw,
                  });
                const delta = choice?.delta;
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
                if (delta !== undefined && delta !== null) {
                  const hasContent =
                    (delta.content != null && delta.content !== '') ||
                    (delta.refusal != null && delta.refusal !== '') ||
                    (delta.reasoning != null && delta.reasoning !== '') ||
                    (delta.reasoning_details?.length ?? 0) > 0 ||
                    (delta.tool_calls?.length ?? 0) > 0 ||
                    (delta.annotations?.length ?? 0) > 0;
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
                  if (Array.isArray(delta.reasoning_details)) {
                    details ??= [];
                    details.push(...delta.reasoning_details);
                  } else if (
                    delta.reasoning_details === null &&
                    details === undefined
                  )
                    details = null;
                  // Display one representation; both originals remain in evidence.
                  const visibleReasoning = delta.reasoning_details?.length
                    ? delta.reasoning_details
                        .map((detail) => {
                          if (detail.kind === 'text') return detail.text ?? '';
                          if (detail.kind === 'summary') return detail.summary;
                          return '';
                        })
                        .join('')
                    : (delta.reasoning ?? '');
                  for (const [part, text] of [
                    ['reasoning', visibleReasoning],
                    ['text', delta.content],
                    ['refusal', delta.refusal],
                  ] as const) {
                    if (text == null || text === '') continue;
                    const phase = part === 'reasoning' ? 'reasoning' : 'text';
                    if (activePhase !== phase) {
                      if (activePhase !== undefined)
                        events.push({
                          kind: 'phase',
                          part: activePhase,
                          boundary: 'end',
                          providerItemIndex: null,
                        });
                      events.push({
                        kind: 'phase',
                        part: phase,
                        boundary: 'start',
                        providerItemIndex: null,
                      });
                      activePhase = phase;
                    }
                    events.push({
                      kind: 'delta',
                      part,
                      text,
                      providerItemIndex: null,
                    });
                    if (part !== 'reasoning') {
                      const previous = textParts.at(-1);
                      if (previous?.kind === part) previous.text += text;
                      else textParts.push({ kind: part, text });
                    }
                  }
                  for (const annotation of delta.annotations ?? []) {
                    if (annotation.kind === 'file-annotation') {
                      const previous = annotations.find(
                        (item) =>
                          item.kind === 'file-annotation' &&
                          item.hash === annotation.hash,
                      );
                      if (previous !== undefined) {
                        if (!isDeepStrictEqual(previous, annotation))
                          return yield* new ModelError({
                            kind: 'malformed-output',
                            message:
                              'OpenRouter changed a file annotation with the same hash.',
                          });
                        continue;
                      }
                    }
                    annotations.push(annotation);
                  }
                  if (
                    (delta.tool_calls?.length ?? 0) > 0 &&
                    activePhase !== undefined
                  ) {
                    events.push({
                      kind: 'phase',
                      part: activePhase,
                      boundary: 'end',
                      providerItemIndex: null,
                    });
                    activePhase = undefined;
                  }
                  for (const fragment of delta.tool_calls ?? []) {
                    const call = calls.get(fragment.index) ?? { arguments: '' };
                    if (
                      (fragment.id != null &&
                        call.id !== undefined &&
                        fragment.id !== call.id) ||
                      (fragment.function?.name != null &&
                        call.name !== undefined &&
                        fragment.function.name !== call.name)
                    )
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'OpenRouter changed a local tool-call identity.',
                      });
                    call.id ??= fragment.id ?? undefined;
                    call.name ??= fragment.function?.name ?? undefined;
                    call.arguments += fragment.function?.arguments ?? '';
                    calls.set(fragment.index, call);
                  }
                }
                if (choice?.native_finish_reason !== undefined) {
                  if (
                    nativeFinishReason != null &&
                    choice.native_finish_reason !== null &&
                    nativeFinishReason !== choice.native_finish_reason
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the native finish reason.',
                    });
                  if (
                    nativeFinishReason === undefined ||
                    choice.native_finish_reason !== null
                  )
                    nativeFinishReason = choice.native_finish_reason;
                }
                if (choice?.finish_reason != null) {
                  if (
                    finished !== undefined &&
                    finished !== choice.finish_reason
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter changed the finish reason.',
                    });
                  finished = choice.finish_reason;
                }
                return events;
              }),
            ),
            Stream.flattenIterable,
          );
          const completion = Stream.fromEffect(
            Effect.gen(function* () {
              if (
                !sentinel ||
                finished === undefined ||
                responseId === undefined
              )
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'OpenRouter ended without an identified terminal result and DONE marker.',
                });
              if ((finished === 'tool_calls') !== calls.size > 0)
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
              if (textParts.length > 0)
                content.push({ kind: 'message', content: textParts });
              const ids = new Set<string>();
              for (const [ordinal, [index, call]] of [...calls.entries()]
                .sort(([a], [b]) => a - b)
                .entries()) {
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
                const args: unknown = yield* Effect.try({
                  try: () => JSON.parse(call.arguments),
                  catch: (cause) =>
                    new ModelError({
                      kind: 'malformed-output',
                      message: 'OpenRouter returned malformed tool arguments.',
                      cause,
                    }),
                });
                const parsedArgs = JsonObjectSchema.safeParse(args);
                if (!parsedArgs.success)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'OpenRouter tool arguments must be a supported JSON object.',
                    cause: parsedArgs.error,
                  });
                ids.add(call.id);
                content.push({
                  kind: 'local-call',
                  providerCallId: call.id,
                  name: call.name,
                  // The accumulated delta bytes, which `arguments` above is the
                  // parse of, so the pair holds by construction.
                  argumentsText: call.arguments,
                  arguments: parsedArgs.data,
                });
              }
              content.push(...annotations);
              if (serviceTier !== undefined)
                usage = {
                  ...(usage ?? {
                    inputTokens: null,
                    outputTokens: null,
                    totalTokens: null,
                    cachedInputTokens: null,
                    reasoningTokens: null,
                  }),
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
                providerResponseId: responseId,
                requestedOrigin: origin,
                returnedModel: returnedModel ?? null,
                modelFingerprint: fingerprint,
                content,
                finishReason,
                ...(nativeFinishReason !== undefined
                  ? {
                      finishEvidence: {
                        kind: 'openrouter',
                        nativeFinishReason,
                      },
                    }
                  : {}),
                usage,
              });
              if (!result.success)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'OpenRouter returned inconsistent completed content.',
                  cause: result.error,
                });
              const events: TurnEvent[] = [];
              if (activePhase !== undefined)
                events.push({
                  kind: 'phase',
                  part: activePhase,
                  boundary: 'end',
                  providerItemIndex: null,
                });
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
  const generateTurn: Model['generateTurn'] = Effect.fn('llm.generateTurn')(
    function* (turn) {
      const completed = yield* Stream.runFold(
        streamTurn(turn),
        () => null as TurnResult | null,
        (result, event) => (event.kind === 'completed' ? event.result : result),
      );
      if (completed === null)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'OpenRouter produced no completed result.',
        });
      return completed;
    },
  );
  return { prepareTurn, streamTurn, generateTurn };
}
