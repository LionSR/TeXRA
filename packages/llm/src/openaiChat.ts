// Third-party imports
import { Cause, Effect, Exit, Stream } from 'effect';
import { Sse } from 'effect/unstable/encoding';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import { openaiFailure } from './openaiError.js';
import {
  JsonObjectSchema,
  ModelConfigurationSchema,
  ModelError,
  ModelOriginSchema,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  sameModelOrigin,
  type ChatConfiguration,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from './turn.js';

type ChatTurn = Extract<
  ResolvedTurn,
  { protocol: ChatConfiguration['protocol'] }
>;

const UsageSchema = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  total_tokens: z.int().nonnegative(),
  // Documented provider receipts, not reconstructed token counts.
  cached_tokens: z.int().nonnegative().nullish(),
  prompt_cache_hit_tokens: z.int().nonnegative().nullish(),
  prompt_cache_miss_tokens: z.int().nonnegative().nullish(),
  prompt_tokens_details: z
    .object({
      cached_tokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
  completion_tokens_details: z
    .object({
      reasoning_tokens: z.int().nonnegative().nullish(),
    })
    .nullish(),
});

// Required content outside this protocol slice fails instead of being stripped.
const ChunkSchema = z.strictObject({
  id: z.string().min(1),
  object: z.literal('chat.completion.chunk'),
  created: z.int(),
  model: z.string().min(1),
  system_fingerprint: z.string().nullish(),
  service_tier: z.string().nullish(),
  obfuscation: z.string().optional(),
  usage: UsageSchema.nullish(),
  choices: z
    .array(
      z.strictObject({
        index: z.literal(0),
        delta: z.strictObject({
          role: z.literal('assistant').optional(),
          content: z.string().nullish(),
          refusal: z.string().nullish(),
          tool_calls: z
            .array(
              z.strictObject({
                index: z.int().nonnegative(),
                id: z.string().min(1).nullish(),
                type: z.literal('function').nullish(),
                function: z
                  .strictObject({
                    name: z.string().min(1).nullish(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .nullish(),
        }),
        finish_reason: z
          .enum(['stop', 'length', 'content_filter', 'tool_calls'])
          .nullable(),
        logprobs: z.null().optional(),
      }),
    )
    .max(1),
});

const ReasoningChunkSchema = ChunkSchema.extend({
  // Z.AI also reports its original request identity in the stream body.
  request_id: z.string().min(1).optional(),
  choices: z
    .array(
      ChunkSchema.shape.choices.element.extend({
        delta: ChunkSchema.shape.choices.element.shape.delta.extend({
          role: z.literal('assistant').nullish(),
          reasoning_content: z.string().nullish(),
        }),
        finish_reason: ChunkSchema.shape.choices.element.shape.finish_reason.or(
          z.literal('insufficient_system_resource'),
        ),
        usage: UsageSchema.nullish(),
      }),
    )
    .max(1),
});

// Used by preparation as well as execution: unsupported history fails before I/O.
const chatMessages = Effect.fn('llm.chatMessages')(function* (
  history: ResolvedTurn['messages'],
  origin: ModelOrigin,
) {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  let calls: OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall[] =
    [];
  for (const message of history) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        const text: string[] = [];
        for (const part of result.content) {
          if (part.kind !== 'text') {
            return yield* new ModelError({
              kind: 'unsupported',
              message: 'This Chat protocol requires text-only tool results.',
            });
          }
          text.push(part.text);
        }
        // The canonical grammar already guarantees adjacent, complete ordinals.
        const call = calls[result.callOrdinal];
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          // Chat has no is_error field; status alone selects its visible marker.
          content:
            result.status === 'error'
              ? `Error: ${text.join('')}`
              : text.join(''),
        });
      }
      continue;
    }
    calls = [];
    if (message.role === 'user') {
      const text: string[] = [];
      for (const part of message.content) {
        if (part.kind !== 'text') {
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'This Chat protocol requires text-only user input.',
          });
        }
        text.push(part.text);
      }
      messages.push({ role: 'user', content: text.join('') });
      continue;
    }
    let assistant:
      | (OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam & {
          reasoning_content?: string;
        })
      | undefined;
    let reasoning: string | undefined;
    for (const part of message.content) {
      if (
        part.kind === 'reasoning' &&
        origin.protocol !== 'openai-chat' &&
        part.evidence?.kind === 'chat-reasoning-content' &&
        sameModelOrigin(message.origin, origin) &&
        reasoning === undefined &&
        assistant === undefined &&
        calls.length === 0
      ) {
        // The canonical boundary guarantees exactly one original text value.
        reasoning = part.content![0].text;
      } else if (part.kind === 'local-call') {
        if (part.providerCallId === null || part.evidence !== undefined) {
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'Chat tool history requires original call IDs without foreign item evidence.',
          });
        }
        calls.push({
          type: 'function',
          id: part.providerCallId,
          function: {
            name: part.name,
            arguments: JSON.stringify(part.arguments),
          },
        });
      } else if (
        part.kind === 'message' &&
        calls.length === 0 &&
        part.evidence === undefined &&
        (reasoning === undefined || assistant === undefined)
      ) {
        if (
          origin.protocol !== 'openai-chat' &&
          part.content.some((child) => child.kind !== 'text')
        ) {
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'This reasoning Chat protocol does not support refusals.',
          });
        }
        assistant = {
          role: 'assistant',
          content:
            origin.protocol === 'openai-chat'
              ? part.content.map((child) =>
                  child.kind === 'text'
                    ? { type: 'text', text: child.text }
                    : { type: 'refusal', refusal: child.text },
                )
              : part.content.map((child) => child.text).join(''),
        };
        messages.push(assistant);
      } else {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Chat requires ordinary message groups before local calls; reasoning and foreign item evidence are unsupported.',
        });
      }
    }
    if (assistant === undefined) {
      assistant = { role: 'assistant', content: '' };
      messages.push(assistant);
    }
    if (reasoning !== undefined) assistant.reasoning_content = reasoning;
    if (calls.length > 0) assistant.tool_calls = calls;
  }
  return messages;
});

const chatToolChoice = Effect.fn('llm.chatToolChoice')(function* (
  choice: NonNullable<TurnRequest['toolChoice']>,
  tools: ResolvedTurn['tools'],
) {
  if (choice === 'auto') return choice;
  if (!tools.some((tool) => tool.name === choice.name)) {
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The required tool must be present in the supplied definitions.',
    });
  }
  return { type: 'function', function: { name: choice.name } } as const;
});

// Lower the same frozen input at both preparation and execution boundaries.
const chatParameters = Effect.fn('llm.chatParameters')(function* (
  turn: ChatTurn,
  config: ChatConfiguration,
) {
  if (turn.protocol !== config.protocol) {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The prepared input belongs to another Chat protocol.',
    });
  }
  const messages = yield* chatMessages(turn.messages, turn);
  const toolChoice = yield* chatToolChoice(
    turn.controls.toolChoice,
    turn.tools,
  );
  if (turn.system !== undefined)
    messages.unshift({ role: 'system', content: turn.system });
  const parameters: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming & {
    thinking?: {
      type: 'enabled' | 'disabled';
      keep?: 'all' | null;
      clear_thinking?: boolean;
    };
  } = {
    model: turn.requestedModel,
    messages,
    ...(turn.tools.length > 0
      ? {
          tools: turn.tools.map((tool) => ({
            type: 'function' as const,
            function: { ...tool, strict: false },
          })),
          tool_choice: toolChoice,
        }
      : {}),
    ...(turn.controls.temperature !== null
      ? { temperature: turn.controls.temperature }
      : {}),
    n: 1,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (turn.protocol === 'openai-chat') {
    parameters.max_completion_tokens = turn.controls.maxOutputTokens;
    if (turn.tools.length > 0)
      parameters.parallel_tool_calls = turn.controls.parallelToolCalls;
    return parameters;
  }
  if (config.protocol === 'openai-chat') {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The selected model does not support reasoning controls.',
    });
  }
  const { effort, thinking } = turn.controls;
  if (
    effort !== null &&
    (!config.supportedEfforts.includes(effort) || thinking.mode !== 'enabled')
  ) {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The selected thinking mode does not support this effort.',
    });
  }
  if (
    turn.controls.toolChoice !== 'auto' &&
    (config.protocol === 'glm-chat' || !config.supportsForcedToolChoice)
  ) {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The selected reasoning model does not support forced tools.',
    });
  }
  parameters.max_tokens = turn.controls.maxOutputTokens;
  if (effort !== null) parameters.reasoning_effort = effort;
  if (turn.protocol === 'deepseek-chat') {
    if (thinking.mode === 'enabled' && turn.controls.temperature !== null) {
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'DeepSeek thinking does not support a temperature control.',
      });
    }
    parameters.thinking = { type: thinking.mode };
  } else if (turn.protocol === 'kimi-chat' && config.protocol === 'kimi-chat') {
    if (
      turn.controls.temperature !==
        config.temperatureByThinking[thinking.mode] ||
      (config.thinkingControl !== 'toggle' &&
        (thinking.mode !== 'enabled' || !turn.controls.preserveThinking)) ||
      (config.thinkingControl !== 'effort' && effort !== null)
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The prepared controls do not match the selected Kimi route.',
      });
    }
    if (config.thinkingControl === 'toggle') {
      parameters.thinking = {
        type: thinking.mode,
        keep: turn.controls.preserveThinking ? 'all' : null,
      };
    }
  } else if (turn.protocol === 'glm-chat' && config.protocol === 'glm-chat') {
    if (!config.supportsThinkingDisabled && thinking.mode === 'disabled') {
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The selected GLM model cannot disable thinking.',
      });
    }
    parameters.thinking = {
      type: thinking.mode,
      clear_thinking: turn.controls.clearThinking,
    };
  }
  return parameters;
});

const normalizeUsage = Effect.fn('llm.chatUsage')(function* (
  receipt: z.infer<typeof UsageSchema>,
  protocol: ChatConfiguration['protocol'],
) {
  let cached = receipt.prompt_tokens_details?.cached_tokens ?? null;
  const providerCached =
    protocol === 'deepseek-chat'
      ? receipt.prompt_cache_hit_tokens
      : protocol === 'kimi-chat' && receipt.cached_tokens;
  if (typeof providerCached === 'number') {
    if (cached !== null && cached !== providerCached) {
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'The model reported contradictory cached token counts.',
      });
    }
    cached = providerCached;
  }
  if (
    protocol === 'deepseek-chat' &&
    receipt.prompt_cache_hit_tokens != null &&
    receipt.prompt_cache_miss_tokens != null &&
    receipt.prompt_cache_hit_tokens + receipt.prompt_cache_miss_tokens !==
      receipt.prompt_tokens
  ) {
    return yield* new ModelError({
      kind: 'malformed-output',
      message: 'DeepSeek reported inconsistent input and cache token counts.',
    });
  }
  return {
    inputTokens: receipt.prompt_tokens,
    outputTokens: receipt.completion_tokens,
    totalTokens: receipt.total_tokens,
    cachedInputTokens: cached,
    reasoningTokens:
      receipt.completion_tokens_details?.reasoning_tokens ?? null,
  } satisfies NonNullable<TurnResult['usage']>;
});

/** Direct Chat protocols; credentials and HTTP transport are foreign inputs. */
export function openaiChatModel(
  configuration: ChatConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (
    config.protocol !== 'openai-chat' &&
    config.protocol !== 'deepseek-chat' &&
    config.protocol !== 'kimi-chat' &&
    config.protocol !== 'glm-chat'
  ) {
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements the selected native Chat protocols.',
    });
  }
  const origin = ModelOriginSchema.parse({
    protocol: config.protocol,
    codecVersion: 1,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
  });
  if (process.env.OPENAI_CUSTOM_HEADERS) {
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Ambient OpenAI custom headers cannot override the selected model binding.',
    });
  }
  const client = new OpenAI({
    apiKey: transport.apiKey,
    baseURL: config.deployment.endpoint,
    fetch: transport.fetch,
    maxRetries: 0,
    organization: null,
    project: null,
    logLevel: 'off',
  });

  const prepareTurn: Model['prepareTurn'] = Effect.fn('llm.prepareTurn')(
    function* (request) {
      const parsed = TurnRequestSchema.safeParse(request);
      if (!parsed.success) {
        return yield* new ModelError({
          kind: 'invalid-request',
          message: 'This model requires supported materialized text input.',
          cause: parsed.error,
        });
      }
      if (
        parsed.data.mode === 'background' ||
        parsed.data.store !== undefined ||
        parsed.data.thinkingLevel !== undefined ||
        parsed.data.continuation !== undefined ||
        parsed.data.reasoning !== undefined ||
        parsed.data.serviceTier !== undefined ||
        parsed.data.cache !== undefined ||
        parsed.data.stopSequences !== undefined ||
        parsed.data.inferenceGeo !== undefined
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'This Chat protocol does not support the supplied background, storage, reasoning, caching, stopping, routing or continuation controls.',
        });
      }
      if (
        (config.protocol === 'openai-chat' &&
          (parsed.data.thinking !== undefined ||
            parsed.data.effort !== undefined)) ||
        (config.protocol !== 'openai-chat' &&
          parsed.data.parallelToolCalls !== undefined)
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'The selected Chat protocol does not support these controls.',
        });
      }
      const tools = parsed.data.tools ?? [];
      const toolChoice = parsed.data.toolChoice ?? 'auto';
      const common = {
        ...origin,
        mode: 'foreground' as const,
        system: parsed.data.system,
        messages: parsed.data.messages,
        tools,
      };
      const maxOutputTokens =
        parsed.data.maxOutputTokens ?? config.defaults.maxOutputTokens;
      let controls: ChatTurn['controls'];
      if (config.protocol === 'openai-chat') {
        controls = {
          temperature: parsed.data.temperature ?? config.defaults.temperature,
          maxOutputTokens,
          parallelToolCalls:
            parsed.data.parallelToolCalls ?? config.defaults.parallelToolCalls,
          toolChoice,
        };
      } else {
        const authoredThinking = parsed.data.thinking;
        if (
          authoredThinking?.mode === 'adaptive' ||
          (authoredThinking?.mode === 'enabled' &&
            (authoredThinking.budgetTokens !== undefined ||
              authoredThinking.display !== undefined)) ||
          (config.protocol === 'kimi-chat' &&
            config.thinkingControl !== 'toggle' &&
            authoredThinking !== undefined)
        ) {
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'The selected Chat route does not support this thinking control.',
          });
        }
        const thinking = authoredThinking ?? config.defaults.thinking;
        let effort =
          thinking.mode === 'enabled' ? config.defaults.effort : null;
        if (parsed.data.effort !== undefined) effort = parsed.data.effort;
        let temperature: number | null;
        if (config.protocol === 'kimi-chat') {
          temperature = config.temperatureByThinking[thinking.mode];
          if (
            parsed.data.temperature !== undefined &&
            parsed.data.temperature !== temperature
          ) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The selected Kimi route has a fixed or omitted temperature.',
            });
          }
        } else if (
          config.protocol === 'deepseek-chat' &&
          thinking.mode === 'enabled'
        ) {
          if (parsed.data.temperature !== undefined) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'DeepSeek thinking does not support a temperature control.',
            });
          }
          temperature = null;
        } else {
          temperature = parsed.data.temperature ?? config.defaults.temperature;
        }
        controls = {
          ...config.defaults,
          thinking,
          effort,
          temperature,
          maxOutputTokens,
          toolChoice,
        };
      }
      const prepared = ResolvedTurnSchema.safeParse({ ...common, controls });
      if (!prepared.success) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'The selected Chat route does not support the prepared controls.',
          cause: prepared.error,
        });
      }
      // This branch originates from the closed Chat configuration union above.
      const turn = prepared.data as ChatTurn;
      yield* chatParameters(turn, config);
      return turn;
    },
  );

  const streamTurn = (
    input: ResolvedTurn,
  ): Stream.Stream<TurnEvent, ModelError> =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      let requestId: string | undefined;
      let bodyRequestId: string | undefined;
      const enrich = (error: ModelError) =>
        new ModelError({
          ...error,
          message: error.message,
          cause: error.cause,
          responseId,
          requestId: error.requestId ?? requestId,
          model: returnedModel ?? config.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const parsed = ResolvedTurnSchema.safeParse(input);
          if (!parsed.success) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The prepared input uses unsupported content or protocol controls.',
              cause: parsed.error,
            });
          }
          const turn = parsed.data;
          if (
            (turn.protocol !== 'openai-chat' &&
              turn.protocol !== 'deepseek-chat' &&
              turn.protocol !== 'kimi-chat' &&
              turn.protocol !== 'glm-chat') ||
            !sameModelOrigin(turn, origin)
          ) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The prepared invocation belongs to another model or deployment.',
            });
          }
          const parameters = yield* chatParameters(turn, config);
          let reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
            undefined;
          // Registered first: the later signal finalizer aborts before cancel joins.
          yield* Effect.addFinalizer((exit) => {
            if (reader === undefined) return Effect.void;
            const body = reader;
            const cancel = Effect.tryPromise({
              try: () => body.cancel(),
              catch: (cause) => cause,
            }).pipe(
              Effect.catch((cause) => {
                // An errored reader repeats its read error when cancelled. Preserve
                // distinct cleanup defects; Scope combines them with the primary exit.
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
            );
            return cancel.pipe(
              Effect.ensuring(Effect.sync(() => body.releaseLock())),
            );
          });
          const signal = yield* Effect.abortSignal;
          const source = yield* Effect.tryPromise({
            try: () =>
              client.chat.completions
                .create(parameters, { signal })
                .asResponse(),
            catch: openaiFailure,
          });
          requestId = source.headers.get('x-request-id') ?? undefined;
          if (source.body === null) {
            return yield* new ModelError({
              kind: 'malformed-output',
              message: 'The model returned no streaming response body.',
            });
          }
          reader = source.body.getReader();
          const body = reader;
          let fingerprint: string | null = null;
          let finishReason: TurnResult['finishReason'] | undefined;
          let usage: TurnResult['usage'] = null;
          let choiceUsage: TurnResult['usage'] = null;
          let reasoning: string | undefined;
          let receivedSentinel = false;
          const content: Array<{ kind: 'text' | 'refusal'; text: string }> = [];
          const calls = new Map<
            number,
            {
              id?: string;
              name?: string;
              type?: 'function';
              arguments: string;
            }
          >();

          const bytes = Stream.fromPull(
            Effect.succeed(
              Effect.tryPromise({
                try: () => body.read(),
                catch: openaiFailure,
              }).pipe(
                Effect.flatMap((next) =>
                  next.done
                    ? Cause.done()
                    : Effect.succeed([next.value] as const),
                ),
              ),
            ),
          );
          let parsedEvents: Sse.Event[] = [];
          const parser = Sse.makeParser(
            (event) => {
              // Retry is only a reconnect hint; this operation never reconnects.
              if (event._tag === 'Event') parsedEvents.push(event);
            },
            {
              // Preserve the prior no-added-cap policy, not a bounded-memory claim.
              maxEventSize: Number.POSITIVE_INFINITY,
            },
          );
          const chunks = bytes.pipe(
            Stream.decodeText,
            Stream.mapEffect((text) =>
              Effect.gen(function* () {
                parsedEvents = [];
                const failure = parser.feed(text);
                if (failure !== undefined) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'The model returned malformed server-sent events.',
                    cause: failure,
                  });
                }
                return parsedEvents;
              }),
            ),
            Stream.flattenIterable,
            Stream.takeUntil((event) => event.data === '[DONE]'),
          );

          const progress = chunks.pipe(
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                if (event.data === '[DONE]') {
                  receivedSentinel = true;
                  return [];
                }
                const raw: unknown = yield* Effect.try({
                  try: () => JSON.parse(event.data),
                  catch: (cause) =>
                    new ModelError({
                      kind: 'malformed-output',
                      message: 'The model returned malformed stream data.',
                      cause,
                    }),
                });
                if (
                  event.event === 'error' ||
                  (typeof raw === 'object' && raw !== null && 'error' in raw)
                ) {
                  const payload =
                    typeof raw === 'object' && raw !== null && 'error' in raw
                      ? raw.error
                      : raw;
                  return yield* openaiFailure(
                    new OpenAI.APIError(
                      undefined,
                      typeof payload === 'object' && payload !== null
                        ? payload
                        : undefined,
                      typeof payload === 'string' ? payload : undefined,
                      source.headers,
                    ),
                  );
                }
                const decoded =
                  turn.protocol === 'openai-chat'
                    ? ChunkSchema.safeParse(raw)
                    : ReasoningChunkSchema.safeParse(raw);
                if (!decoded.success) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model returned malformed or unsupported content.',
                    cause: decoded.error,
                  });
                }
                const chunk: z.infer<typeof ReasoningChunkSchema> =
                  decoded.data;
                if ('request_id' in chunk && chunk.request_id !== undefined) {
                  if (
                    turn.protocol !== 'glm-chat' ||
                    (bodyRequestId !== undefined &&
                      bodyRequestId !== chunk.request_id)
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The model reported an inconsistent request identity.',
                    });
                  }
                  bodyRequestId = chunk.request_id;
                  requestId ??= bodyRequestId;
                }
                if (
                  (responseId !== undefined && responseId !== chunk.id) ||
                  (returnedModel !== undefined && returnedModel !== chunk.model)
                ) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'The model stream changed its response identity.',
                  });
                }
                const events: TurnEvent[] = [];
                if (responseId === undefined)
                  events.push({
                    kind: 'identified',
                    providerResponseId: chunk.id,
                    requestedOrigin: origin,
                    returnedModel: chunk.model,
                  });
                responseId = chunk.id;
                returnedModel = chunk.model;
                fingerprint = chunk.system_fingerprint ?? fingerprint;
                if (chunk.usage) {
                  usage = yield* normalizeUsage(chunk.usage, turn.protocol);
                }
                const choice = chunk.choices[0];
                if (!choice) return events;
                if (choice.finish_reason === 'insufficient_system_resource') {
                  return yield* new ModelError({
                    kind:
                      turn.protocol === 'deepseek-chat'
                        ? 'provider-rejection'
                        : 'malformed-output',
                    message:
                      'The model stopped because its inference system had insufficient resources.',
                    cause: chunk,
                  });
                }
                if ('usage' in choice && choice.usage != null) {
                  if (turn.protocol !== 'kimi-chat') {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'This Chat protocol does not report choice-level usage.',
                    });
                  }
                  choiceUsage = yield* normalizeUsage(
                    choice.usage,
                    turn.protocol,
                  );
                }
                if (finishReason !== undefined) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model emitted another choice after completion.',
                  });
                }
                if (
                  'reasoning_content' in choice.delta &&
                  choice.delta.reasoning_content != null
                ) {
                  const text = choice.delta.reasoning_content;
                  reasoning = (reasoning ?? '') + text;
                  if (text !== '')
                    events.push({ kind: 'delta', part: 'reasoning', text });
                }
                if (
                  turn.protocol !== 'openai-chat' &&
                  choice.delta.refusal != null
                ) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'This reasoning Chat protocol does not support a refusal field.',
                  });
                }
                for (const [part, text] of [
                  ['text', choice.delta.content],
                  ['refusal', choice.delta.refusal],
                ] as const) {
                  if (text == null || text === '') continue;
                  const previous = content.at(-1);
                  if (previous?.kind === part) previous.text += text;
                  else content.push({ kind: part, text });
                  events.push({ kind: 'delta', part, text });
                }
                for (const delta of choice.delta.tool_calls ?? []) {
                  const call = calls.get(delta.index) ?? { arguments: '' };
                  if (
                    (delta.id != null &&
                      call.id !== undefined &&
                      delta.id !== call.id) ||
                    (delta.function?.name != null &&
                      call.name !== undefined &&
                      delta.function.name !== call.name)
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The model changed a streamed tool call identity.',
                    });
                  }
                  call.id = delta.id ?? call.id;
                  call.name = delta.function?.name ?? call.name;
                  call.type = delta.type ?? call.type;
                  call.arguments += delta.function?.arguments ?? '';
                  calls.set(delta.index, call);
                }
                if (choice.finish_reason !== null) {
                  switch (choice.finish_reason) {
                    case 'content_filter':
                      finishReason = 'content-filter';
                      break;
                    case 'tool_calls':
                      finishReason = 'tool-calls';
                      break;
                    default:
                      finishReason = choice.finish_reason;
                  }
                }
                return events;
              }),
            ),
            Stream.flattenIterable,
          );

          // include_usage arrives after finish_reason; EOF, not that choice, ends collection.
          const completion = Stream.fromEffect(
            Effect.gen(function* () {
              if (
                responseId === undefined ||
                returnedModel === undefined ||
                finishReason === undefined ||
                (turn.protocol === 'kimi-chat' && !receivedSentinel)
              ) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'The model stream ended without a completed response.',
                });
              }
              if ((finishReason === 'tool-calls') !== calls.size > 0) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'The model finish reason does not match its tool calls.',
                });
              }
              // Root receipts take precedence. A second present receipt may not contradict one.
              if (usage !== null && choiceUsage !== null) {
                for (const key of [
                  'inputTokens',
                  'outputTokens',
                  'totalTokens',
                  'cachedInputTokens',
                  'reasoningTokens',
                ] as const) {
                  if (
                    usage[key] !== null &&
                    choiceUsage[key] !== null &&
                    usage[key] !== choiceUsage[key]
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The model reported contradictory root and choice usage.',
                    });
                  }
                }
              }
              const completedContent: TurnResult['content'][number][] = [];
              if (reasoning !== undefined) {
                completedContent.push({
                  kind: 'reasoning',
                  summary: [],
                  content: [{ kind: 'text', text: reasoning }],
                  evidence: { kind: 'chat-reasoning-content' },
                });
              }
              if (content.length > 0)
                completedContent.push({ kind: 'message', content });
              for (const [ordinal, [index, call]] of [...calls]
                .toSorted(([left], [right]) => left - right)
                .entries()) {
                if (
                  index !== ordinal ||
                  call.id === undefined ||
                  call.name === undefined ||
                  call.type === undefined
                ) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model returned incomplete tool call identities.',
                  });
                }
                const args = yield* Effect.try({
                  try: () => JsonObjectSchema.parse(JSON.parse(call.arguments)),
                  catch: (cause) =>
                    new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The model returned invalid tool call arguments.',
                      cause,
                    }),
                });
                completedContent.push({
                  kind: 'local-call',
                  providerCallId: call.id,
                  name: call.name,
                  arguments: args,
                });
              }
              const parsedResult = TurnResultSchema.safeParse({
                providerResponseId: responseId,
                requestedOrigin: origin,
                returnedModel,
                modelFingerprint: fingerprint,
                content: completedContent,
                finishReason,
                usage: usage ?? choiceUsage,
              });
              if (!parsedResult.success) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message: 'The model returned inconsistent completed content.',
                  cause: parsedResult.error,
                });
              }
              return { kind: 'completed', result: parsedResult.data } as const;
            }),
          );
          // Enrich before the reader scope closes, preserving primary + cleanup causes.
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
      if (completed === null) {
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'The model stream produced no completed result.',
        });
      }
      return completed;
    },
  );
  return Object.freeze({ prepareTurn, streamTurn, generateTurn });
}
