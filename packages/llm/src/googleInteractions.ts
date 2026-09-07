// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import { GoogleGenAI, type Interactions } from '@google/genai';
import { Cause, Effect, Exit, Stream } from 'effect';
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
  type GoogleInteractionsConfiguration,
  type Model,
  type ModelOrigin,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from './turn.js';

// SDK stream parsing does not validate the JSON values it returns.
const WireTextSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});
const WireStepSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('thought'),
    summary: z.array(WireTextSchema).optional(),
    signature: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal('model_output'),
    content: z.array(WireTextSchema).optional(),
  }),
  z.strictObject({
    type: z.literal('function_call'),
    id: z.string().min(1),
    name: z.string().min(1),
    // Initial arguments are empty; argument content arrives in deltas.
    arguments: JsonObjectSchema.refine(
      (value) => Object.keys(value).length === 0,
    ).optional(),
  }),
]);
const WireUsageSchema = z.object({
  total_input_tokens: z.int().nonnegative().optional(),
  total_output_tokens: z.int().nonnegative().optional(),
  total_tokens: z.int().nonnegative().optional(),
  total_cached_tokens: z.int().nonnegative().optional(),
  total_thought_tokens: z.int().nonnegative().optional(),
});
const WireInteractionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  model: z.string().min(1).optional(),
  steps: z.unknown().optional(),
  usage: WireUsageSchema.optional(),
});
const WireEventSchema = z.discriminatedUnion('event_type', [
  z.object({
    event_type: z.literal('interaction.created'),
    interaction: WireInteractionSchema,
  }),
  z.object({
    event_type: z.literal('interaction.completed'),
    interaction: WireInteractionSchema,
  }),
  z.object({
    event_type: z.literal('interaction.status_update'),
    interaction_id: z.string().min(1),
    status: z.string(),
  }),
  z.object({
    event_type: z.literal('step.start'),
    index: z.int().nonnegative(),
    step: WireStepSchema,
  }),
  z.object({
    event_type: z.literal('step.stop'),
    index: z.int().nonnegative(),
    usage: WireUsageSchema.optional(),
  }),
  z.object({
    event_type: z.literal('step.delta'),
    index: z.int().nonnegative(),
    metadata: z.object({ total_usage: WireUsageSchema.optional() }).optional(),
    delta: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('text'), text: z.string() }),
      z.strictObject({
        type: z.literal('thought_summary'),
        content: WireTextSchema,
      }),
      z.strictObject({
        type: z.literal('thought_signature'),
        signature: z.string().min(1),
      }),
      z.strictObject({
        type: z.literal('arguments_delta'),
        arguments: z.string(),
      }),
    ]),
  }),
  z.object({ event_type: z.literal('error'), error: z.unknown() }),
]);

/** Codec 1 uses sorted object entries followed by ECMAScript JSON enumeration. */
function prefixFingerprint(
  origin: ModelOrigin,
  system: string | undefined,
  messages: ResolvedTurn['messages'],
): string {
  const encoded = JSON.stringify(
    ['texra-google-interactions-prefix-v1', origin, system ?? null, messages],
    (_key, value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) =>
          left < right ? -1 : Number(left > right),
        ),
      );
    },
  );
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

const lowerMessages = Effect.fn('llm.google.lowerMessages')(function* (
  messages: ResolvedTurn['messages'],
  origin: ModelOrigin,
) {
  const steps: Interactions.Step[] = [];
  let calls: Extract<TurnResult['content'][number], { kind: 'local-call' }>[] =
    [];
  for (const message of messages) {
    if (message.role === 'user') {
      steps.push({
        type: 'user_input',
        content: message.content.map(({ text }) => ({ type: 'text', text })),
      });
    } else if (message.role === 'tool') {
      for (const result of message.results) {
        const call = calls[result.callOrdinal];
        if (!call?.providerCallId) {
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'A Google tool result requires its original provider call ID.',
          });
        }
        steps.push({
          type: 'function_result',
          call_id: call.providerCallId,
          name: call.name,
          ...(result.status === 'error' ? { is_error: true } : {}),
          result: result.content.map(({ text }) => ({ type: 'text', text })),
        });
      }
      calls = [];
    } else {
      calls = [];
      const ids = new Set<string>();
      for (const part of message.content) {
        switch (part.kind) {
          case 'text':
            steps.push({
              type: 'model_output',
              content: [{ type: 'text', text: part.text }],
            });
            break;
          case 'reasoning':
            if (!sameModelOrigin(message.origin, origin)) {
              return yield* new ModelError({
                kind: 'unsupported',
                message:
                  'Google reasoning belongs to another model or deployment.',
              });
            }
            steps.push({
              type: 'thought',
              summary: part.summary.map(({ text }) => ({ type: 'text', text })),
              ...(part.evidence ? { signature: part.evidence.signature } : {}),
            });
            break;
          case 'local-call':
            if (!part.providerCallId || ids.has(part.providerCallId)) {
              return yield* new ModelError({
                kind: 'unsupported',
                message:
                  'Google calls require distinct original IDs within each response.',
              });
            }
            ids.add(part.providerCallId);
            calls.push(part);
            steps.push({
              type: 'function_call',
              id: part.providerCallId,
              name: part.name,
              arguments: part.arguments,
            });
            break;
          default:
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Google Interactions cannot encode this canonical content.',
            });
        }
      }
    }
  }
  return steps;
});

const HttpFailureSchema = z.object({ status: z.int().min(400).max(599) });

function sdkFailure(cause: unknown): ModelError {
  // The pinned Interactions SDK does not export its HTTP error constructors.
  const decoded = HttpFailureSchema.safeParse(cause);
  const status = decoded.success ? decoded.data.status : undefined;
  let kind: ModelError['kind'] = 'transport';
  if (status !== undefined) {
    kind =
      status === 401 || status === 403
        ? 'authentication'
        : 'provider-rejection';
  }
  return new ModelError({
    kind,
    message:
      cause instanceof Error ? cause.message : 'The Google transport failed.',
    ...(status === undefined ? {} : { status }),
    cause,
  });
}

const invocationInput = Effect.fn('llm.google.invocationInput')(function* (
  turn: ResolvedTurn,
  origin: ModelOrigin,
) {
  if (
    turn.protocol !== 'google-interactions' ||
    !sameModelOrigin(turn, origin)
  ) {
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'The prepared invocation belongs to another model or deployment.',
    });
  }
  const steps = yield* lowerMessages(turn.messages, origin);
  if (!turn.continuation) return steps;
  const continuation = turn.continuation;
  const prefix = turn.messages.slice(0, continuation.coveredMessages);
  const prefixSteps = yield* lowerMessages(prefix, origin);
  if (
    !turn.controls.store ||
    !sameModelOrigin(continuation.origin, origin) ||
    continuation.coveredMessages > turn.messages.length ||
    continuation.prefixFingerprint !==
      prefixFingerprint(origin, turn.system, prefix) ||
    continuation.anchor.coveredSteps !== prefixSteps.length ||
    turn.messages
      .slice(continuation.coveredMessages)
      .some((message) => message.role === 'assistant')
  ) {
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'The Google continuation does not cover this exact history and system input.',
    });
  }
  return steps.slice(continuation.anchor.coveredSteps);
});

/** Direct Gemini Interactions protocol; it owns neither history nor local tools. */
export function googleInteractionsModel(
  configuration: GoogleInteractionsConfiguration,
  transport: { readonly apiKey: string },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'google-interactions' || !transport.apiKey) {
    throw new TypeError(
      'Google Interactions requires its configuration and an explicit API key.',
    );
  }
  const origin: ModelOrigin = {
    protocol: 'google-interactions',
    codecVersion: 1,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
  };
  const client = new GoogleGenAI({
    enterprise: false,
    apiKey: transport.apiKey,
    apiVersion: 'v1beta',
    httpOptions: { baseUrl: config.deployment.endpoint },
  });

  const prepareTurn: Model['prepareTurn'] = Effect.fn('llm.google.prepareTurn')(
    function* (request) {
      const parsed = TurnRequestSchema.safeParse(request);
      if (!parsed.success) {
        return yield* new ModelError({
          kind: 'invalid-request',
          message: 'The canonical Google input is invalid.',
          cause: parsed.error,
        });
      }
      if (parsed.data.temperature !== undefined) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Google Interactions does not support temperature.',
        });
      }
      const turn = ResolvedTurnSchema.parse({
        ...origin,
        mode: 'foreground',
        system: parsed.data.system,
        messages: parsed.data.messages,
        tools: parsed.data.tools ?? [],
        continuation: parsed.data.continuation,
        controls: {
          maxOutputTokens:
            parsed.data.maxOutputTokens ?? config.defaults.maxOutputTokens,
          store: parsed.data.store ?? config.defaults.store,
          thinkingLevel:
            parsed.data.thinkingLevel ?? config.defaults.thinkingLevel,
        },
      });
      yield* invocationInput(turn, origin);
      return turn;
    },
  );

  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | null = null;
      return Stream.unwrap(
        Effect.gen(function* () {
          const parsed = ResolvedTurnSchema.safeParse(input);
          if (
            !parsed.success ||
            parsed.data.protocol !== 'google-interactions'
          ) {
            return yield* new ModelError({
              kind: 'unsupported',
              message: 'The prepared Google invocation is unsupported.',
            });
          }
          const turn = parsed.data;
          const inputSteps = yield* invocationInput(turn, origin);

          let reader: ReadableStreamDefaultReader<unknown> | undefined =
            undefined;
          // Finalizers are LIFO: abort the request before awaiting reader cleanup.
          yield* Effect.addFinalizer((exit) => {
            const body = reader;
            if (body === undefined) return Effect.void;
            // Preserve a primary failure or interruption, not a cleanup failure
            // after successful use. The request has already been aborted.
            const cancel = Exit.isSuccess(exit)
              ? Effect.promise(() => body.cancel())
              : Effect.tryPromise(() => body.cancel()).pipe(Effect.ignore);
            return cancel.pipe(
              Effect.ensuring(Effect.sync(() => body.releaseLock())),
            );
          });
          const signal = yield* Effect.abortSignal;
          const source = yield* Effect.tryPromise({
            try: () =>
              client.interactions.create(
                {
                  model: turn.requestedModel,
                  input: inputSteps,
                  system_instruction: turn.system,
                  store: turn.controls.store,
                  background: false,
                  stream: true,
                  tools: turn.tools.map((tool) => ({
                    type: 'function' as const,
                    ...tool,
                  })),
                  generation_config: {
                    max_output_tokens: turn.controls.maxOutputTokens,
                    thinking_level: turn.controls.thinkingLevel,
                    thinking_summaries: 'auto',
                    tool_choice: 'auto',
                  },
                  ...(turn.continuation
                    ? {
                        previous_interaction_id:
                          turn.continuation.anchor.interactionId,
                      }
                    : {}),
                },
                { maxRetries: 0, fetchOptions: { signal } },
              ),
            catch: sdkFailure,
          });
          reader = source.getReader();
          const body = reader;
          let completed: z.infer<typeof WireInteractionSchema> | undefined;
          let usage: z.infer<typeof WireUsageSchema> | undefined;
          const pending = new Map<
            number,
            {
              step: z.infer<typeof WireStepSchema>;
              argumentsText?: string;
              stopped: boolean;
            }
          >();

          const events = Stream.fromPull(
            Effect.succeed(
              Effect.tryPromise({
                try: () => body.read(),
                catch: sdkFailure,
              }).pipe(
                Effect.flatMap((next) =>
                  next.done
                    ? Cause.done()
                    : Effect.succeed([next.value] as const),
                ),
              ),
            ),
          ).pipe(
            Stream.mapEffect((raw) =>
              Effect.gen(function* () {
                const decoded = WireEventSchema.safeParse(raw);
                if (!decoded.success) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'Google returned malformed or unsupported stream data.',
                    responseId,
                    cause: decoded.error,
                  });
                }
                const event = decoded.data;
                if (completed) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'Google emitted data after its completed interaction.',
                  });
                }
                const progress: TurnEvent[] = [];
                if (
                  event.event_type === 'interaction.created' ||
                  event.event_type === 'interaction.completed'
                ) {
                  // Codec 1 takes content only from complete start/delta/stop cycles.
                  if (event.interaction.steps !== undefined) {
                    return yield* new ModelError({
                      kind: 'unsupported',
                      message:
                        'Google terminal step snapshots are not supported by this streaming codec.',
                      responseId,
                    });
                  }
                  if (
                    !event.interaction.id ||
                    (responseId !== undefined &&
                      responseId !== event.interaction.id)
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Google changed or omitted the interaction identity.',
                    });
                  }
                  responseId = event.interaction.id;
                  if (
                    event.interaction.model &&
                    returnedModel !== null &&
                    returnedModel !== event.interaction.model
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Google changed the returned model identity.',
                      responseId,
                    });
                  }
                  if (event.interaction.model)
                    returnedModel = event.interaction.model;
                  usage = event.interaction.usage ?? usage;
                  if (event.event_type === 'interaction.completed')
                    completed = event.interaction;
                } else if (event.event_type === 'interaction.status_update') {
                  if (
                    responseId !== undefined &&
                    responseId !== event.interaction_id
                  ) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Google changed the interaction identity.',
                    });
                  }
                  responseId = event.interaction_id;
                } else if (event.event_type === 'step.start') {
                  if (pending.has(event.index)) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Google reused an invalid step index.',
                    });
                  }
                  pending.set(event.index, {
                    step: structuredClone(event.step),
                    stopped: false,
                  });
                } else if (
                  event.event_type === 'step.stop' ||
                  event.event_type === 'step.delta'
                ) {
                  const slot = pending.get(event.index);
                  if (!slot || slot.stopped) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Google changed an absent or completed step.',
                    });
                  }
                  if (event.event_type === 'step.stop') {
                    slot.stopped = true;
                    usage = event.usage ?? usage;
                  } else {
                    usage = event.metadata?.total_usage ?? usage;
                    const delta = event.delta;
                    if (
                      delta.type === 'text' &&
                      slot.step.type === 'model_output'
                    ) {
                      const content = (slot.step.content ??= []);
                      const last = content.at(-1);
                      if (last?.type === 'text') last.text += delta.text;
                      else content.push({ type: 'text', text: delta.text });
                      progress.push({
                        kind: 'delta',
                        part: 'text',
                        text: delta.text,
                      });
                    } else if (
                      delta.type === 'thought_summary' &&
                      slot.step.type === 'thought' &&
                      delta.content?.type === 'text'
                    ) {
                      const summary = (slot.step.summary ??= []);
                      const last = summary.at(-1);
                      if (last?.type === 'text')
                        last.text += delta.content.text;
                      else
                        summary.push({
                          type: 'text',
                          text: delta.content.text,
                        });
                      progress.push({
                        kind: 'delta',
                        part: 'reasoning',
                        text: delta.content.text,
                      });
                    } else if (
                      delta.type === 'thought_signature' &&
                      slot.step.type === 'thought'
                    ) {
                      if (
                        slot.step.signature !== undefined &&
                        slot.step.signature !== delta.signature
                      ) {
                        return yield* new ModelError({
                          kind: 'malformed-output',
                          message:
                            'Google changed an existing thought signature.',
                          responseId,
                        });
                      }
                      slot.step.signature = delta.signature;
                    } else if (
                      delta.type === 'arguments_delta' &&
                      slot.step.type === 'function_call'
                    ) {
                      slot.argumentsText =
                        (slot.argumentsText ?? '') + delta.arguments;
                    } else {
                      return yield* new ModelError({
                        kind: 'unsupported',
                        message:
                          'Google emitted an unsupported or mismatched content delta.',
                      });
                    }
                  }
                } else {
                  return yield* new ModelError({
                    kind: 'provider-rejection',
                    message: 'Google reported a failed interaction.',
                    cause: event,
                  });
                }
                return progress;
              }),
            ),
            Stream.flattenIterable,
          );

          const terminal = Stream.fromEffect(
            Effect.gen(function* () {
              if (
                !completed ||
                !responseId ||
                (completed.status !== 'completed' &&
                  completed.status !== 'requires_action')
              ) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'Google ended without an authoritative completed turn.',
                });
              }
              const ordered = [...pending.entries()].toSorted(
                ([left], [right]) => left - right,
              );
              const responseSteps: z.infer<typeof WireStepSchema>[] = [];
              for (const [index, slot] of ordered) {
                if (!slot.stopped || index !== responseSteps.length) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'Google ended with an incomplete step sequence.',
                  });
                }
                if (
                  slot.step.type === 'function_call' &&
                  slot.argumentsText !== undefined
                ) {
                  slot.step.arguments = yield* Effect.try({
                    try: () => JSON.parse(slot.argumentsText!),
                    catch: (cause) =>
                      new ModelError({
                        kind: 'malformed-output',
                        message: 'Google emitted malformed tool arguments.',
                        cause,
                      }),
                  });
                }
                responseSteps.push(slot.step);
              }
              const content: TurnResult['content'][number][] = [];
              const callIds = new Set<string>();
              for (const step of responseSteps) {
                if (step.type === 'thought') {
                  const summary: Array<{ kind: 'text'; text: string }> = [];
                  for (const item of step.summary ?? []) {
                    summary.push({ kind: 'text', text: item.text });
                  }
                  content.push({
                    kind: 'reasoning',
                    summary,
                    evidence:
                      step.signature === undefined
                        ? null
                        : {
                            kind: 'google-interactions-thought-signature',
                            signature: step.signature,
                          },
                  });
                } else if (step.type === 'model_output') {
                  const text = step.content?.[0];
                  if (step.content?.length !== 1 || text?.type !== 'text') {
                    return yield* new ModelError({
                      kind: 'unsupported',
                      message: 'Google returned unsupported assistant content.',
                    });
                  }
                  content.push({ kind: 'text', text: text.text });
                } else if (step.type === 'function_call') {
                  if (step.arguments === undefined || callIds.has(step.id)) {
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Google returned missing arguments or duplicate provider call IDs.',
                    });
                  }
                  callIds.add(step.id);
                  content.push({
                    kind: 'local-call',
                    providerCallId: step.id,
                    name: step.name,
                    arguments: step.arguments,
                  });
                } else {
                  return yield* new ModelError({
                    kind: 'unsupported',
                    message:
                      'Google returned content outside the implemented canonical vocabulary.',
                  });
                }
              }
              if (
                (completed.status === 'requires_action') !==
                callIds.size > 0
              ) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'Google completion status disagrees with its local calls.',
                  responseId,
                });
              }
              const result = TurnResultSchema.safeParse({
                providerResponseId: responseId,
                requestedOrigin: origin,
                returnedModel,
                modelFingerprint: null,
                content,
                finishReason: callIds.size > 0 ? 'tool-calls' : 'stop',
                usage:
                  usage === undefined
                    ? null
                    : {
                        inputTokens: usage.total_input_tokens ?? null,
                        outputTokens: usage.total_output_tokens ?? null,
                        totalTokens: usage.total_tokens ?? null,
                        cachedInputTokens: usage.total_cached_tokens ?? null,
                        reasoningTokens: usage.total_thought_tokens ?? null,
                      },
              });
              if (!result.success) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message: 'Google returned invalid canonical output.',
                  cause: result.error,
                });
              }
              if (turn.controls.store) {
                const prefix: ResolvedTurn['messages'] = [
                  ...turn.messages,
                  { role: 'assistant', origin, content: result.data.content },
                ];
                const coveredSteps = yield* lowerMessages(prefix, origin);
                return {
                  kind: 'completed',
                  result: TurnResultSchema.parse({
                    ...result.data,
                    continuation: {
                      origin,
                      coveredMessages: prefix.length,
                      prefixFingerprint: prefixFingerprint(
                        origin,
                        turn.system,
                        prefix,
                      ),
                      anchor: {
                        interactionId: responseId,
                        coveredSteps: coveredSteps.length,
                      },
                    },
                  }),
                } as const;
              }
              return { kind: 'completed', result: result.data } as const;
            }),
          );
          return Stream.concat(events, terminal);
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

  const generateTurn: Model['generateTurn'] = Effect.fn(
    'llm.google.generateTurn',
  )(function* (turn) {
    const result = yield* Stream.runFold(
      streamTurn(turn),
      () => null as TurnResult | null,
      (result, event) => (event.kind === 'completed' ? event.result : result),
    );
    if (result === null)
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Google produced no completed result.',
      });
    return result;
  });
  return Object.freeze({ prepareTurn, streamTurn, generateTurn });
}
