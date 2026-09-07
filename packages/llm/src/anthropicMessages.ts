// Third-party imports
import Anthropic, { APIError, APIConnectionError } from '@anthropic-ai/sdk';
import { Cause, Effect, Stream } from 'effect';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  JsonObjectSchema,
  ModelConfigurationSchema,
  ModelError,
  ResolvedTurnSchema,
  sameModelOrigin,
  TurnRequestSchema,
  TurnResultSchema,
  type AnthropicMessagesConfiguration,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from './turn.js';
import type {
  ContentBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

const CountSchema = z.int().nonnegative();
const RefusalSchema = z.strictObject({
  type: z.literal('refusal'),
  category: z
    .enum([
      'cyber',
      'bio',
      'frontier_llm',
      'reasoning_extraction',
      'general_harms',
    ])
    .nullable(),
  explanation: z.string().nullable(),
});
const UsageSchema = z.object({
  input_tokens: CountSchema.nullish(),
  output_tokens: CountSchema.nullish(),
  cache_creation_input_tokens: CountSchema.nullish(),
  cache_read_input_tokens: CountSchema.nullish(),
  cache_creation: z
    .object({
      ephemeral_5m_input_tokens: CountSchema.nullish(),
      ephemeral_1h_input_tokens: CountSchema.nullish(),
    })
    .nullish(),
  output_tokens_details: z
    .object({ thinking_tokens: CountSchema.nullish() })
    .nullish(),
  service_tier: z.enum(['standard', 'priority', 'batch']).nullish(),
  inference_geo: z.string().nullish(),
  server_tool_use: z.record(z.string(), CountSchema).nullish(),
});
const StopSchema = z.object({
  stop_reason: z
    .enum([
      'end_turn',
      'max_tokens',
      'stop_sequence',
      'tool_use',
      'pause_turn',
      'refusal',
      'model_context_window_exceeded',
    ])
    .nullish(),
  stop_sequence: z.string().nullish(),
  stop_details: RefusalSchema.nullish(),
  container: z.unknown().optional(),
});
const BlockSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('text'),
    text: z.string(),
    citations: z.array(z.unknown()).nullish(),
  }),
  z.strictObject({
    type: z.literal('thinking'),
    thinking: z.string(),
    signature: z.string(),
  }),
  z.strictObject({ type: z.literal('redacted_thinking'), data: z.string() }),
  z.strictObject({
    type: z.literal('tool_use'),
    id: z.string().min(1),
    name: z.string().min(1),
    input: JsonObjectSchema,
    caller: z.strictObject({ type: z.literal('direct') }).optional(),
    toolset_name: z.string().nullable().optional(),
  }),
]);
// The SDK parses SSE JSON but does not validate its supported event/block fields.
const EventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('message_start'),
    message: StopSchema.extend({
      id: z.string().min(1),
      model: z.string().min(1),
      type: z.literal('message'),
      role: z.literal('assistant'),
      content: z.array(z.unknown()).length(0),
      usage: UsageSchema,
    }),
  }),
  z.object({
    type: z.literal('message_delta'),
    delta: StopSchema,
    usage: UsageSchema,
  }),
  z.object({ type: z.literal('message_stop') }),
  z.object({
    type: z.literal('content_block_start'),
    index: z.int().nonnegative(),
    content_block: BlockSchema,
  }),
  z.object({
    type: z.literal('content_block_delta'),
    index: z.int().nonnegative(),
    delta: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('text_delta'), text: z.string() }),
      z.strictObject({
        type: z.literal('thinking_delta'),
        thinking: z.string(),
      }),
      z.strictObject({
        type: z.literal('signature_delta'),
        signature: z.string(),
      }),
      z.strictObject({
        type: z.literal('input_json_delta'),
        partial_json: z.string(),
      }),
    ]),
  }),
  z.object({
    type: z.literal('content_block_stop'),
    index: z.int().nonnegative(),
  }),
]);

function sdkFailure(cause: unknown): ModelError {
  let kind: ModelError['kind'] = 'transport';
  if (cause instanceof SyntaxError) kind = 'malformed-output';
  else if (
    cause instanceof APIError &&
    !(cause instanceof APIConnectionError)
  ) {
    kind =
      cause.status === 401 || cause.status === 403
        ? 'authentication'
        : 'provider-rejection';
  }
  return new ModelError({
    kind,
    message:
      cause instanceof Error
        ? cause.message
        : 'The Anthropic transport failed.',
    ...(cause instanceof APIError
      ? { status: cause.status, requestId: cause.requestID ?? undefined }
      : {}),
    cause,
  });
}

const inputPart = Effect.fn('llm.anthropic.inputPart')(function* (
  part: Extract<
    ResolvedTurn['messages'][number],
    { role: 'user' }
  >['content'][number],
) {
  if (part.kind === 'text') return { type: 'text', text: part.text } as const;
  if (part.kind === 'image' && part.detail === undefined) {
    const mime = z
      .enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])
      .safeParse(part.mimeType);
    if (mime.success)
      return {
        type: 'image',
        source: { type: 'base64', media_type: mime.data, data: part.base64 },
      } as const;
  }
  if (part.kind === 'document' && part.mimeType === 'application/pdf') {
    return {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: part.base64,
      },
    } as const;
  }
  return yield* new ModelError({
    kind: 'unsupported',
    message:
      'Anthropic supports materialized text, exact image MIME types and PDF bytes, without foreign image detail.',
  });
});

const invocationBody = Effect.fn('llm.anthropic.invocationBody')(function* (
  turn: ResolvedTurn,
  origin: ModelOrigin,
  config: AnthropicMessagesConfiguration,
) {
  if (
    turn.protocol !== 'anthropic-messages' ||
    !sameModelOrigin(turn, origin)
  ) {
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'The prepared Anthropic invocation belongs to another model or deployment.',
    });
  }
  const controls = turn.controls;
  if (
    (!config.supportsTemperature && controls.temperature !== null) ||
    (controls.thinking.mode !== 'disabled' &&
      controls.temperature !== null &&
      controls.temperature !== 1) ||
    (controls.thinking.mode === 'enabled' &&
      controls.thinking.budgetTokens >= controls.maxOutputTokens)
  ) {
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Anthropic thinking requires an admitted temperature and a manual budget below the output limit.',
    });
  }
  const choice = controls.toolChoice;
  if (choice !== 'auto') {
    if (
      !config.supportsForcedToolChoice ||
      controls.thinking.mode === 'enabled'
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'This selected Anthropic binding does not support forcing a tool with these thinking controls.',
      });
    }
    if (!turn.tools.some((tool) => tool.name === choice.name)) {
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The selected Anthropic tool is absent from this invocation.',
      });
    }
  }
  const messages: MessageParam[] = [];
  let calls: Extract<TurnResult['content'][number], { kind: 'local-call' }>[] =
    [];
  for (const message of turn.messages) {
    if (message.role === 'user') {
      messages.push({
        role: 'user',
        content: yield* Effect.forEach(message.content, inputPart),
      });
    } else if (message.role === 'tool') {
      const content: ToolResultBlockParam[] = [];
      for (const result of message.results) {
        const call = calls[result.callOrdinal];
        if (!call?.providerCallId)
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'Anthropic tool results require their original provider call IDs.',
          });
        content.push({
          type: 'tool_result',
          tool_use_id: call.providerCallId,
          is_error: result.status === 'error',
          content: yield* Effect.forEach(result.content, inputPart),
        });
      }
      messages.push({ role: 'user', content });
    } else {
      calls = [];
      const content: ContentBlockParam[] = [];
      for (const part of message.content) {
        if (part.kind === 'message' && part.evidence === undefined) {
          for (const child of part.content) {
            if (child.kind !== 'text')
              return yield* new ModelError({
                kind: 'unsupported',
                message: 'Anthropic cannot replay foreign refusal content.',
              });
            content.push({ type: 'text', text: child.text });
          }
        } else if (
          part.kind === 'local-call' &&
          part.evidence === undefined &&
          part.providerCallId !== null
        ) {
          calls.push(part);
          content.push({
            type: 'tool_use',
            id: part.providerCallId,
            name: part.name,
            input: part.arguments,
          });
        } else if (
          part.kind === 'reasoning' &&
          sameModelOrigin(message.origin, origin)
        ) {
          if (
            part.evidence?.kind === 'anthropic-thinking-signature' &&
            part.content?.length === 1
          ) {
            content.push({
              type: 'thinking',
              thinking: part.content[0]!.text,
              signature: part.evidence.signature,
            });
          } else if (part.evidence?.kind === 'anthropic-redacted-thinking') {
            content.push({
              type: 'redacted_thinking',
              data: part.evidence.data,
            });
          } else
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Anthropic reasoning requires exact signed or redacted provider evidence.',
            });
        } else
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'Anthropic cannot replay foreign content evidence or missing call identities.',
          });
      }
      messages.push({ role: 'assistant', content });
    }
  }
  const tools: NonNullable<MessageCreateParamsStreaming['tools']> = [];
  for (const tool of turn.tools) {
    if (tool.parameters.type !== 'object')
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'Anthropic local tools require JSON object parameter schemas.',
      });
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: { ...tool.parameters, type: 'object' },
    });
  }
  const thinking = controls.thinking;
  let wireThinking: MessageCreateParamsStreaming['thinking'];
  if (thinking.mode === 'disabled') wireThinking = { type: 'disabled' };
  else if (thinking.mode === 'adaptive')
    wireThinking = { type: 'adaptive', display: thinking.display };
  else
    wireThinking = {
      type: 'enabled',
      display: thinking.display,
      budget_tokens: thinking.budgetTokens,
    };
  const body: MessageCreateParamsStreaming = {
    model: turn.requestedModel,
    max_tokens: controls.maxOutputTokens,
    messages,
    stream: true,
    ...(turn.system === undefined ? {} : { system: turn.system }),
    ...(controls.temperature === null
      ? {}
      : { temperature: controls.temperature }),
    ...(controls.effort === null
      ? {}
      : { output_config: { effort: controls.effort } }),
    ...(controls.inferenceGeo === null
      ? {}
      : { inference_geo: controls.inferenceGeo }),
    service_tier:
      controls.serviceTier === 'standard-only' ? 'standard_only' : 'auto',
    stop_sequences: [...controls.stopSequences],
    thinking: wireThinking,
    ...(controls.cache === 'disabled'
      ? {}
      : { cache_control: { type: 'ephemeral', ttl: controls.cache } }),
    ...(tools.length === 0
      ? {}
      : {
          tools,
          tool_choice: {
            ...(choice === 'auto'
              ? { type: 'auto' as const }
              : { type: 'tool' as const, name: choice.name }),
            disable_parallel_tool_use: !controls.parallelToolCalls,
          },
        }),
  };
  return body;
});

/** Stable Messages protocol, without a transcript owner, uploads or SDK emitters. */
export function anthropicMessagesModel(
  configuration: AnthropicMessagesConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'anthropic-messages' || !transport.apiKey) {
    throw new ModelError({
      kind: 'invalid-request',
      message:
        'Anthropic Messages requires its selected configuration and an explicit API key.',
    });
  }
  // The pinned SDK otherwise lets these ambient headers override selected credentials and protocol.
  if (process.env.ANTHROPIC_CUSTOM_HEADERS) {
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Anthropic Messages does not support ANTHROPIC_CUSTOM_HEADERS; the selected binding must determine its request headers.',
    });
  }
  const origin: ModelOrigin = {
    protocol: 'anthropic-messages',
    codecVersion: 1,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
  };
  const client = new Anthropic({
    apiKey: transport.apiKey,
    authToken: null,
    baseURL: config.deployment.endpoint,
    fetch: transport.fetch,
    maxRetries: 0,
    logLevel: 'off',
    timeout: 600_000,
  });
  const prepareTurn: Model['prepareTurn'] = Effect.fn(
    'llm.anthropic.prepareTurn',
  )(function* (request) {
    const parsed = TurnRequestSchema.safeParse(request);
    if (!parsed.success)
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The canonical Anthropic input is invalid.',
        cause: parsed.error,
      });
    const input = parsed.data;
    if (
      input.mode === 'background' ||
      input.continuation !== undefined ||
      input.store !== undefined ||
      input.reasoning !== undefined ||
      input.thinkingLevel !== undefined ||
      input.serviceTier === 'fast' ||
      input.serviceTier === null ||
      (!config.supportsTemperature && input.temperature !== undefined)
    )
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The selected Anthropic model does not support these authored controls.',
      });
    let thinking = input.thinking ?? config.defaults.thinking;
    if (thinking.mode === 'enabled') {
      thinking = {
        mode: 'enabled',
        budgetTokens:
          thinking.budgetTokens ??
          (config.defaults.thinking.mode === 'enabled'
            ? config.defaults.thinking.budgetTokens
            : undefined),
        display:
          thinking.display ??
          (config.defaults.thinking.mode !== 'disabled'
            ? config.defaults.thinking.display
            : 'summarized'),
      };
    }
    const prepared = ResolvedTurnSchema.safeParse({
      ...origin,
      mode: 'foreground',
      system: input.system,
      messages: input.messages,
      tools: input.tools ?? [],
      controls: {
        maxOutputTokens:
          input.maxOutputTokens ?? config.defaults.maxOutputTokens,
        temperature: input.temperature ?? config.defaults.temperature,
        parallelToolCalls:
          input.parallelToolCalls ?? config.defaults.parallelToolCalls,
        toolChoice: input.toolChoice ?? 'auto',
        thinking,
        effort:
          input.effort === undefined ? config.defaults.effort : input.effort,
        cache: input.cache ?? config.defaults.cache,
        stopSequences: input.stopSequences ?? config.defaults.stopSequences,
        serviceTier: input.serviceTier ?? config.defaults.serviceTier,
        inferenceGeo:
          input.inferenceGeo === undefined
            ? config.defaults.inferenceGeo
            : input.inferenceGeo,
      },
    });
    if (!prepared.success)
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'Anthropic requires complete supported invocation controls.',
        cause: prepared.error,
      });
    yield* invocationBody(prepared.data, origin, config);
    return prepared.data;
  });

  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | null = null;
      const enrich = (error: ModelError) =>
        new ModelError({
          ...error,
          message: error.message,
          cause: error.cause,
          responseId: error.responseId ?? responseId,
          model: error.model ?? returnedModel ?? origin.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const prepared = ResolvedTurnSchema.safeParse(input);
          if (!prepared.success)
            return yield* new ModelError({
              kind: 'invalid-request',
              message: 'The prepared Anthropic invocation is invalid.',
              cause: prepared.error,
            });
          const body = yield* invocationBody(prepared.data, origin, config);
          const signal = yield* Effect.abortSignal;
          const source = yield* Effect.tryPromise({
            try: () => client.messages.create(body, { signal }),
            catch: sdkFailure,
          });
          const iterator = yield* Effect.acquireRelease(
            Effect.sync(() => source[Symbol.asyncIterator]()),
            (iterator) => {
              // A queued return cannot release a pending SDK read until its request aborts.
              source.controller.abort();
              if (!iterator.return) return Effect.void;
              return Effect.promise(() => iterator.return!());
            },
          );
          const content: Array<TurnResult['content'][number]> = [];
          let open:
            | {
                index: number;
                block: z.infer<typeof BlockSchema>;
                argumentsText?: string;
                signatureSeen: boolean;
              }
            | undefined;
          let stopped = false;
          let stop: z.infer<typeof StopSchema> = {};
          let usage: z.infer<typeof UsageSchema> = {};
          const chunks = Stream.fromPull(
            Effect.succeed(
              Effect.tryPromise({
                try: () => iterator.next(),
                catch: sdkFailure,
              }).pipe(
                Effect.flatMap((next) =>
                  next.done
                    ? Cause.done()
                    : Effect.succeed([next.value] as const),
                ),
              ),
            ),
          );
          const progress = chunks.pipe(
            Stream.mapEffect((raw) =>
              Effect.gen(function* (): Effect.fn.Return<
                TurnEvent[],
                ModelError
              > {
                const decoded = EventSchema.safeParse(raw);
                if (!decoded.success)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'Anthropic returned an unsupported or malformed stream event.',
                    cause: decoded.error,
                  });
                const event = decoded.data;
                if (event.type === 'message_start') {
                  if (
                    responseId !== undefined ||
                    event.message.stop_reason != null ||
                    event.message.stop_sequence != null ||
                    event.message.stop_details != null ||
                    event.message.container != null
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Anthropic returned an invalid initial message.',
                    });
                  responseId = event.message.id;
                  returnedModel = event.message.model;
                  usage = event.message.usage;
                  if (
                    Object.values(usage.server_tool_use ?? {}).some(
                      (count) => count !== 0,
                    )
                  )
                    return yield* new ModelError({
                      kind: 'unsupported',
                      message:
                        'Anthropic hosted-tool accounting is not supported by this codec.',
                    });
                  return [
                    {
                      kind: 'identified',
                      providerResponseId: responseId,
                      requestedOrigin: origin,
                      returnedModel,
                    } satisfies TurnEvent,
                  ];
                }
                if (responseId === undefined)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'Anthropic emitted content before message identity.',
                  });
                if (event.type === 'message_delta') {
                  if (
                    open ||
                    event.delta.container != null ||
                    Object.values(event.usage.server_tool_use ?? {}).some(
                      (count) => count !== 0,
                    )
                  )
                    return yield* new ModelError({
                      kind: 'unsupported',
                      message:
                        'Anthropic returned unsettled content or unsupported hosted execution.',
                    });
                  stop = event.delta;
                  // These counters are cumulative; null/omission means no update, never zero or addition.
                  usage = {
                    ...usage,
                    ...Object.fromEntries(
                      Object.entries(event.usage).filter(
                        ([, value]) => value != null,
                      ),
                    ),
                  };
                  return [];
                }
                if (event.type === 'message_stop') {
                  if (open || stop.stop_reason == null)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Anthropic stopped without complete content and a terminal reason.',
                    });
                  stopped = true;
                  return [];
                }
                if (stop.stop_reason != null)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'Anthropic emitted content after terminal message metadata.',
                  });
                if (event.type === 'content_block_start') {
                  if (open || event.index !== content.length)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Anthropic content blocks are not complete and ordered.',
                    });
                  const block = event.content_block;
                  if (
                    (block.type === 'text' &&
                      (block.citations?.length ?? 0) > 0) ||
                    (block.type === 'tool_use' &&
                      (block.toolset_name != null ||
                        Object.keys(block.input).length !== 0))
                  ) {
                    return yield* new ModelError({
                      kind: 'unsupported',
                      message:
                        'Anthropic citations, toolsets and nonempty streamed argument placeholders are unsupported.',
                    });
                  }
                  open = {
                    index: event.index,
                    block,
                    signatureSeen:
                      block.type === 'thinking' && block.signature.length > 0,
                  };
                  if (block.type === 'tool_use') return [];
                  const events: TurnEvent[] = [
                    {
                      kind: 'phase',
                      part: block.type === 'text' ? 'text' : 'reasoning',
                      boundary: 'start',
                      providerItemIndex: event.index,
                    },
                  ];
                  if (block.type === 'text' && block.text.length > 0)
                    events.push({
                      kind: 'delta',
                      part: 'text',
                      text: block.text,
                      providerItemIndex: event.index,
                    });
                  if (block.type === 'thinking' && block.thinking.length > 0)
                    events.push({
                      kind: 'delta',
                      part: 'reasoning',
                      text: block.thinking,
                      providerItemIndex: event.index,
                    });
                  return events;
                }
                if (!open || open.index !== event.index)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'Anthropic updated a block that is not open.',
                  });
                const block = open.block;
                if (event.type === 'content_block_delta') {
                  const delta = event.delta;
                  if (block.type === 'text' && delta.type === 'text_delta') {
                    block.text += delta.text;
                    return [
                      {
                        kind: 'delta',
                        part: 'text',
                        text: delta.text,
                        providerItemIndex: event.index,
                      } satisfies TurnEvent,
                    ];
                  }
                  if (
                    block.type === 'thinking' &&
                    delta.type === 'thinking_delta'
                  ) {
                    block.thinking += delta.thinking;
                    return [
                      {
                        kind: 'delta',
                        part: 'reasoning',
                        text: delta.thinking,
                        providerItemIndex: event.index,
                      } satisfies TurnEvent,
                    ];
                  }
                  if (
                    block.type === 'thinking' &&
                    delta.type === 'signature_delta'
                  ) {
                    block.signature = delta.signature;
                    open.signatureSeen = true;
                  } else if (
                    block.type === 'tool_use' &&
                    delta.type === 'input_json_delta'
                  ) {
                    open.argumentsText =
                      (open.argumentsText ?? '') + delta.partial_json;
                  } else
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Anthropic emitted a mismatched content delta.',
                    });
                  return [];
                }
                if (block.type === 'text')
                  content.push({
                    kind: 'message',
                    content: [{ kind: 'text', text: block.text }],
                  });
                else if (block.type === 'thinking') {
                  if (!open.signatureSeen)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Anthropic thinking ended without its signature.',
                    });
                  content.push({
                    kind: 'reasoning',
                    summary: [],
                    content: [{ kind: 'text', text: block.thinking }],
                    evidence: {
                      kind: 'anthropic-thinking-signature',
                      signature: block.signature,
                    },
                  });
                } else if (block.type === 'redacted_thinking')
                  content.push({
                    kind: 'reasoning',
                    summary: [],
                    evidence: {
                      kind: 'anthropic-redacted-thinking',
                      data: block.data,
                    },
                  });
                else {
                  const argumentsText = open.argumentsText;
                  const argumentsValue =
                    argumentsText === undefined
                      ? block.input
                      : yield* Effect.try({
                          try: () => JSON.parse(argumentsText),
                          catch: (cause) =>
                            new ModelError({
                              kind: 'malformed-output',
                              message:
                                'Anthropic returned incomplete function argument JSON.',
                              cause,
                            }),
                        });
                  const argumentsResult =
                    JsonObjectSchema.safeParse(argumentsValue);
                  if (!argumentsResult.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Anthropic function arguments must be a supported JSON object.',
                      cause: argumentsResult.error,
                    });
                  content.push({
                    kind: 'local-call',
                    providerCallId: block.id,
                    name: block.name,
                    arguments: argumentsResult.data,
                  });
                }
                open = undefined;
                if (block.type === 'tool_use') return [];
                return [
                  {
                    kind: 'phase',
                    part: block.type === 'text' ? 'text' : 'reasoning',
                    boundary: 'end',
                    providerItemIndex: event.index,
                  },
                ];
              }),
            ),
            // message_stop settles the response; HTTP EOF is not an additional condition.
            Stream.takeUntil(() => stopped),
            Stream.flattenIterable,
          );
          const terminal = Stream.fromEffect(
            Effect.gen(function* () {
              if (
                !stopped ||
                responseId === undefined ||
                stop.stop_reason == null
              )
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'Anthropic ended without message_stop and a terminal result.',
                });
              if (stop.stop_reason === 'pause_turn')
                return yield* new ModelError({
                  kind: 'unsupported',
                  message:
                    'Anthropic paused hosted execution requires a separate supported continuation protocol.',
                });
              const finishReason = {
                end_turn: 'stop',
                max_tokens: 'length',
                stop_sequence: 'stop-sequence',
                tool_use: 'tool-calls',
                refusal: 'refusal',
                model_context_window_exceeded: 'context-window-exceeded',
              }[stop.stop_reason] as TurnResult['finishReason'];
              if (
                finishReason === 'tool-calls' &&
                !content.some((part) => part.kind === 'local-call')
              )
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'Anthropic stopped for local tools without a complete local call.',
                });
              const uncached = usage.input_tokens ?? null;
              const cached = usage.cache_read_input_tokens ?? null;
              const creation = usage.cache_creation_input_tokens ?? null;
              const inputTokens =
                uncached !== null && cached !== null && creation !== null
                  ? uncached + cached + creation
                  : null;
              const outputTokens = usage.output_tokens ?? null;
              const result = TurnResultSchema.safeParse({
                providerResponseId: responseId,
                requestedOrigin: origin,
                returnedModel,
                modelFingerprint: null,
                content,
                finishReason,
                ...(stop.stop_sequence == null
                  ? {}
                  : { stopSequence: stop.stop_sequence }),
                ...(stop.stop_details === undefined
                  ? {}
                  : {
                      refusalEvidence:
                        stop.stop_details === null
                          ? null
                          : {
                              kind: 'anthropic-refusal',
                              category: stop.stop_details.category,
                              explanation: stop.stop_details.explanation,
                            },
                    }),
                usage: {
                  inputTokens,
                  outputTokens,
                  cachedInputTokens: cached,
                  totalTokens:
                    inputTokens !== null && outputTokens !== null
                      ? inputTokens + outputTokens
                      : null,
                  reasoningTokens:
                    usage.output_tokens_details?.thinking_tokens ?? null,
                  providerUsage: {
                    kind: 'anthropic',
                    uncachedInputTokens: uncached,
                    cacheCreationTokens: creation,
                    cacheCreation5mTokens:
                      usage.cache_creation?.ephemeral_5m_input_tokens ?? null,
                    cacheCreation1hTokens:
                      usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
                    serviceTier: usage.service_tier ?? null,
                    inferenceGeo: usage.inference_geo ?? null,
                  },
                },
              });
              if (!result.success)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'Anthropic returned inconsistent terminal content or evidence.',
                  cause: result.error,
                });
              return {
                kind: 'completed',
                result: result.data,
              } satisfies TurnEvent;
            }),
          );
          return Stream.concat(progress, terminal).pipe(
            Stream.mapError(enrich),
          );
        }).pipe(Effect.mapError(enrich)),
      );
    });
  const generateTurn: Model['generateTurn'] = Effect.fn(
    'llm.anthropic.generateTurn',
  )(function* (turn) {
    const completed = yield* Stream.runFold(
      streamTurn(turn),
      () => null as TurnResult | null,
      (result, event) => (event.kind === 'completed' ? event.result : result),
    );
    if (completed === null)
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Anthropic produced no completed turn.',
      });
    return completed;
  });
  return Object.freeze({ prepareTurn, streamTurn, generateTurn });
}
