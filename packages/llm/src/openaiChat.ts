// Third-party imports
import { Cause, Effect, Stream } from 'effect';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  ModelConfigurationSchema,
  ModelError,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  type Model,
  type ModelConfiguration,
  type ResolvedTurn,
  type TurnEvent,
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
        }),
        finish_reason: z.enum(['stop', 'length', 'content_filter']).nullable(),
        logprobs: z.null().optional(),
      }),
    )
    .max(1),
});

function sdkFailure(cause: unknown): ModelError {
  if (cause instanceof OpenAI.APIConnectionError) {
    return new ModelError({
      kind: 'transport',
      message: cause.message,
      cause,
    });
  }
  if (cause instanceof OpenAI.APIError) {
    return new ModelError({
      kind:
        cause.status === 401 || cause.status === 403
          ? 'authentication'
          : 'provider-rejection',
      message: cause.message,
      status: cause.status,
      requestId: cause.requestID ?? undefined,
      cause,
    });
  }
  return new ModelError({
    kind: 'transport',
    message: 'The model transport failed.',
    cause,
  });
}

/** Direct OpenAI Chat protocol; credentials and HTTP transport are foreign inputs. */
export function openaiChatModel(
  configuration: ModelConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
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
      return ResolvedTurnSchema.parse({
        protocol: 'openai-chat',
        codecVersion: 1,
        mode: 'foreground',
        model: config.model,
        deployment: config.deployment,
        system: parsed.data.system,
        messages: parsed.data.messages,
        controls: {
          temperature: parsed.data.temperature ?? config.defaults.temperature,
          maxOutputTokens:
            parsed.data.maxOutputTokens ?? config.defaults.maxOutputTokens,
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
            turn.model !== config.model ||
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
          const signal = yield* Effect.abortSignal;
          const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] =
            turn.messages.map((message) => ({
              role: message.role,
              content: message.content.map((part) => part.text).join(''),
            }));
          if (turn.system !== undefined) {
            messages.unshift({ role: 'system', content: turn.system });
          }
          const source = yield* Effect.tryPromise({
            try: () =>
              client.chat.completions.create(
                {
                  model: turn.model,
                  messages,
                  temperature: turn.controls.temperature,
                  max_completion_tokens: turn.controls.maxOutputTokens,
                  n: 1,
                  stream: true,
                  stream_options: { include_usage: true },
                },
                { signal },
              ),
            catch: sdkFailure,
          });
          let fingerprint: string | null = null;
          let finishReason: TurnResult['finishReason'] | undefined;
          let usage: TurnResult['usage'] = null;
          const content: Array<{ kind: 'text' | 'refusal'; text: string }> = [];

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
                    : sdkFailure(cause),
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
                if (!choice) return [];
                if (finishReason !== undefined) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model emitted another choice after completion.',
                  });
                }
                const events: TurnEvent[] = [];
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
                if (choice.finish_reason !== null) {
                  finishReason =
                    choice.finish_reason === 'content_filter'
                      ? 'content-filter'
                      : choice.finish_reason;
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
              const result = TurnResultSchema.parse({
                responseId,
                model: returnedModel,
                modelFingerprint: fingerprint,
                content,
                finishReason,
                usage,
              });
              return { kind: 'completed', result } as const;
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
              model: returnedModel ?? config.model,
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
