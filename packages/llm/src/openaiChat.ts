// Third-party imports
import { Cause, Effect, Stream } from 'effect';
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
  type Model,
  type OpenAIChatConfiguration,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
} from './turn.js';

const UsageSchema = z.object({
  prompt_tokens: z.int().nonnegative(),
  completion_tokens: z.int().nonnegative(),
  total_tokens: z.int().nonnegative(),
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

// Used by preparation as well as execution: unsupported history fails before I/O.
const chatMessages = Effect.fn('llm.chatMessages')(function* (
  history: ResolvedTurn['messages'],
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
      OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam | undefined;
    for (const part of message.content) {
      if (part.kind === 'local-call') {
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
        part.evidence === undefined
      ) {
        assistant = {
          role: 'assistant',
          content: part.content.map((child) =>
            child.kind === 'text'
              ? { type: 'text', text: child.text }
              : { type: 'refusal', refusal: child.text },
          ),
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

/** Direct OpenAI Chat protocol; credentials and HTTP transport are foreign inputs. */
export function openaiChatModel(
  configuration: OpenAIChatConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openai-chat') {
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements the OpenAI Chat protocol.',
    });
  }
  const origin = ModelOriginSchema.parse({
    protocol: config.protocol,
    codecVersion: 1,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
  });
  const client = new OpenAI({
    apiKey: transport.apiKey,
    baseURL: config.deployment.endpoint,
    fetch: transport.fetch,
    maxRetries: 0,
    organization: null,
    project: null,
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
        parsed.data.store !== undefined ||
        parsed.data.thinkingLevel !== undefined ||
        parsed.data.continuation !== undefined ||
        parsed.data.reasoning !== undefined ||
        parsed.data.serviceTier !== undefined
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'This Chat protocol does not support storage, reasoning, service-tier or continuation controls.',
        });
      }
      yield* chatMessages(parsed.data.messages);
      const tools = parsed.data.tools ?? [];
      const toolChoice = parsed.data.toolChoice ?? 'auto';
      yield* chatToolChoice(toolChoice, tools);
      return ResolvedTurnSchema.parse({
        ...origin,
        mode: 'foreground',
        system: parsed.data.system,
        messages: parsed.data.messages,
        tools,
        controls: {
          temperature: parsed.data.temperature ?? config.defaults.temperature,
          maxOutputTokens:
            parsed.data.maxOutputTokens ?? config.defaults.maxOutputTokens,
          parallelToolCalls:
            parsed.data.parallelToolCalls ?? config.defaults.parallelToolCalls,
          toolChoice,
        },
      });
    },
  );

  const streamTurn = (
    input: ResolvedTurn,
  ): Stream.Stream<TurnEvent, ModelError> =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | undefined;
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
            turn.protocol !== 'openai-chat' ||
            turn.requestedModel !== config.requestedModel ||
            turn.deployment.endpoint !== config.deployment.endpoint ||
            turn.deployment.credentialScope !==
              config.deployment.credentialScope
          ) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'The prepared invocation belongs to another model or deployment.',
            });
          }
          const messages = yield* chatMessages(turn.messages);
          const toolChoice = yield* chatToolChoice(
            turn.controls.toolChoice,
            turn.tools,
          );
          if (turn.system !== undefined) {
            messages.unshift({ role: 'system', content: turn.system });
          }
          const signal = yield* Effect.abortSignal;
          const source = yield* Effect.tryPromise({
            try: () =>
              client.chat.completions.create(
                {
                  model: turn.requestedModel,
                  messages,
                  ...(turn.tools.length > 0
                    ? {
                        tools: turn.tools.map((tool) => ({
                          type: 'function' as const,
                          function: { ...tool, strict: false },
                        })),
                        tool_choice: toolChoice,
                        parallel_tool_calls: turn.controls.parallelToolCalls,
                      }
                    : {}),
                  temperature: turn.controls.temperature,
                  max_completion_tokens: turn.controls.maxOutputTokens,
                  n: 1,
                  stream: true,
                  stream_options: { include_usage: true },
                },
                { signal },
              ),
            catch: openaiFailure,
          });
          let fingerprint: string | null = null;
          let finishReason: TurnResult['finishReason'] | undefined;
          let usage: TurnResult['usage'] = null;
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

          const iterator = yield* Effect.acquireRelease(
            Effect.sync(() => source[Symbol.asyncIterator]()),
            (iterator) =>
              Effect.gen(function* () {
                // Abort the SDK request before joining a pending iterator read.
                source.controller.abort();
                if (iterator.return)
                  yield* Effect.promise(() => iterator.return!());
              }),
          );
          const chunks = Stream.fromPull(
            Effect.succeed(
              Effect.tryPromise({
                try: () => iterator.next(),
                catch: (cause) =>
                  cause instanceof SyntaxError
                    ? new ModelError({
                        kind: 'malformed-output',
                        message: 'The model returned malformed stream data.',
                        cause,
                      })
                    : openaiFailure(cause),
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
              Effect.gen(function* () {
                const decoded = ChunkSchema.safeParse(raw);
                if (!decoded.success) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model returned malformed or unsupported content.',
                    cause: decoded.error,
                  });
                }
                const chunk = decoded.data;
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
                  usage = {
                    inputTokens: chunk.usage.prompt_tokens,
                    outputTokens: chunk.usage.completion_tokens,
                    totalTokens: chunk.usage.total_tokens,
                    cachedInputTokens:
                      chunk.usage.prompt_tokens_details?.cached_tokens ?? null,
                    reasoningTokens:
                      chunk.usage.completion_tokens_details?.reasoning_tokens ??
                      null,
                  };
                }
                const choice = chunk.choices[0];
                if (!choice) return events;
                if (finishReason !== undefined) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model emitted another choice after completion.',
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
                finishReason === undefined
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
              const completedContent: TurnResult['content'][number][] =
                content.length > 0 ? [{ kind: 'message', content }] : [];
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
                usage,
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
          return Stream.concat(progress, completion);
        }),
      ).pipe(
        Stream.mapError(
          (error) =>
            new ModelError({
              ...error,
              message: error.message,
              cause: error.cause,
              responseId,
              model: returnedModel ?? config.requestedModel,
            }),
        ),
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
