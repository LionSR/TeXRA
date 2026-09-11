// Third-party imports
import { GoogleGenAI, type Interactions } from '@google/genai';
import { Cause, Clock, Effect, Exit, Stream } from 'effect';
import { z } from 'zod';

// Local imports - canonical model contract
import { prefixFingerprint } from './prefixFingerprint.js';
import {
  BackgroundEventSchema,
  BackgroundSubmissionSchema,
  CancellationEvidenceSchema,
  ObservationPolicySchema,
  RemoteOperationSchema,
  JsonObjectSchema,
  ModelConfigurationSchema,
  ModelError,
  readerAbortSignal,
  ResolvedTurnSchema,
  sameModelOrigin,
  TurnRequestSchema,
  TurnResultSchema,
  type GoogleInteractionsConfiguration,
  type Model,
  type ModelOrigin,
  type RemoteOperation,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
  completedTurn,
} from './turn.js';

// SDK stream parsing does not validate the JSON values it returns.
const WireTextSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string(),
});
const WireCompletedStepSchema = z.discriminatedUnion('type', [
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
    arguments: JsonObjectSchema.optional(),
  }),
]);
// A stream start announces a call; its arguments arrive in subsequent deltas.
const WireStepSchema = WireCompletedStepSchema.refine(
  (step) =>
    step.type !== 'function_call' ||
    step.arguments === undefined ||
    Object.keys(step.arguments).length === 0,
);
const WireUsageSchema = z.object({
  total_input_tokens: z.int().nonnegative().optional(),
  total_output_tokens: z.int().nonnegative().optional(),
  total_tokens: z.int().nonnegative().optional(),
  total_cached_tokens: z.int().nonnegative().optional(),
  total_thought_tokens: z.int().nonnegative().optional(),
  total_tool_use_tokens: z.int().nonnegative().optional(),
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

const lowerInputPart = Effect.fn('llm.google.lowerInputPart')(function* (
  part: Extract<
    ResolvedTurn['messages'][number],
    { role: 'user' }
  >['content'][number],
) {
  if (part.kind === 'text') {
    return { type: 'text', text: part.text } satisfies Interactions.TextContent;
  }
  const mimeType = part.mimeType.split(';', 1)[0].trim().toLowerCase();
  if (part.kind !== 'document' && !mimeType.startsWith(`${part.kind}/`)) {
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'Google media kind disagrees with its MIME type.',
    });
  }
  const data = { data: part.base64, mime_type: part.mimeType };
  switch (part.kind) {
    case 'image': {
      const resolution =
        part.detail === 'ultra-high' ? 'ultra_high' : part.detail;
      return {
        type: 'image',
        ...data,
        ...(resolution === undefined ? {} : { resolution }),
      } satisfies Interactions.ImageContent;
    }
    case 'audio':
      if (['audio/l16', 'audio/alaw', 'audio/mulaw'].includes(mimeType)) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Raw Google audio requires channel and sample-rate metadata outside the implemented input vocabulary.',
        });
      }
      return { type: 'audio', ...data } satisfies Interactions.AudioContent;
    case 'video':
      return {
        type: 'video',
        ...data,
        // Agentic processing requires additional signed hosted-result content.
        processing: 'static',
      } satisfies Interactions.VideoContent;
    case 'document':
      return {
        type: 'document',
        ...data,
      } satisfies Interactions.DocumentContent;
  }
});

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
        content: yield* Effect.forEach(message.content, lowerInputPart),
      });
    } else if (message.role === 'tool') {
      for (const result of message.results) {
        const call = calls[result.callOrdinal];
        if (call === undefined) {
          return yield* new ModelError({
            kind: 'unsupported',
            message:
              'A Google tool result requires its original provider call ID.',
          });
        }
        const content: Array<
          Interactions.TextContent | Interactions.ImageContent
        > = [];
        for (const input of result.content) {
          const part = yield* lowerInputPart(input);
          if (part.type !== 'text' && part.type !== 'image') {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Google tool results support only text and image content.',
            });
          }
          content.push(part);
        }
        steps.push({
          type: 'function_result',
          call_id: call.providerCallId,
          name: call.name,
          ...(result.status === 'error' ? { is_error: true } : {}),
          result: content,
        });
      }
      calls = [];
    } else {
      calls = [];
      const ids = new Set<string>();
      for (const part of message.content) {
        switch (part.kind) {
          case 'message': {
            if (
              part.evidence !== undefined ||
              part.content.some((child) => child.kind !== 'text')
            ) {
              return yield* new ModelError({
                kind: 'unsupported',
                message:
                  'Google requires ordinary text message groups without foreign item evidence.',
              });
            }
            steps.push({
              type: 'model_output',
              content: part.content.map(({ text }) => ({ type: 'text', text })),
            });
            break;
          }
          case 'reasoning':
            if (
              !sameModelOrigin(message.origin, origin) ||
              part.content !== undefined ||
              (part.evidence !== null &&
                part.evidence.kind !== 'google-interactions-thought-signature')
            ) {
              return yield* new ModelError({
                kind: 'unsupported',
                message:
                  'Google reasoning requires its original binding and supported thought evidence.',
              });
            }
            steps.push({
              type: 'thought',
              summary: part.summary.map(({ text }) => ({ type: 'text', text })),
              ...(part.evidence ? { signature: part.evidence.signature } : {}),
            });
            break;
          case 'local-call':
            if (ids.has(part.providerCallId) || part.evidence !== undefined) {
              return yield* new ModelError({
                kind: 'unsupported',
                message:
                  'Google calls require distinct original IDs without foreign item evidence.',
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
  if (cause instanceof SyntaxError) kind = 'malformed-output';
  else if (status !== undefined) {
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

/** Join the SDK request after abort; independent cleanup failures remain defects. */
function ownedRequest<A>(
  request: (signal: AbortSignal) => Promise<A>,
  classify: (cause: unknown) => ModelError = sdkFailure,
  deadline?: { readonly duration: number; readonly error: ModelError },
): Effect.Effect<A, ModelError> {
  return Effect.suspend(() => {
    let pending: Promise<A> | undefined;
    let requestSignal: AbortSignal | undefined;
    const wait = Effect.tryPromise({
      try: (signal) => {
        requestSignal = signal;
        pending = request(signal);
        return pending;
      },
      catch: classify,
    });
    // Keep joining outside the timeout race: losing fibers' cleanup causes are
    // otherwise discarded by the pinned Effect race implementation.
    return (
      deadline === undefined
        ? wait
        : wait.pipe(
            Effect.timeoutOrElse({
              duration: deadline.duration,
              orElse: () => Effect.fail(deadline.error),
            }),
          )
    ).pipe(
      Effect.onExit((exit) => {
        if (pending === undefined) return Effect.void;
        const operation = pending;
        return Effect.tryPromise({
          try: () => operation,
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) => {
            if (
              Exit.isFailure(exit) &&
              (exit.cause.reasons.some(
                (reason) =>
                  Cause.isFailReason(reason) &&
                  reason.error instanceof ModelError &&
                  reason.error.cause === cause,
              ) ||
                (requestSignal?.aborted &&
                  cause instanceof DOMException &&
                  cause.name === 'AbortError'))
            ) {
              return Effect.void;
            }
            return Effect.die(classify(cause));
          }),
          Effect.asVoid,
        );
      }),
    );
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
  const toolChoice = turn.controls.toolChoice;
  if (
    toolChoice !== 'auto' &&
    !turn.tools.some((tool) => tool.name === toolChoice.name)
  ) {
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The selected Google tool is not defined in this invocation.',
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
      prefixFingerprint(
        'texra-google-interactions-prefix-v1',
        origin,
        turn.system,
        prefix,
      ) ||
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

function createInput(
  turn: Extract<ResolvedTurn, { protocol: 'google-interactions' }>,
  inputSteps: Interactions.Step[],
) {
  return {
    model: turn.requestedModel,
    input: inputSteps,
    system_instruction: turn.system,
    store: turn.controls.store,
    tools: turn.tools.map((tool) => ({
      type: 'function' as const,
      ...tool,
    })),
    generation_config: {
      max_output_tokens: turn.controls.maxOutputTokens,
      thinking_level: turn.controls.thinkingLevel,
      thinking_summaries: 'auto',
      tool_choice:
        turn.controls.toolChoice === 'auto'
          ? 'auto'
          : {
              allowed_tools: {
                mode: 'any',
                tools: [turn.controls.toolChoice.name],
              },
            },
    },
    ...(turn.continuation
      ? {
          previous_interaction_id: turn.continuation.anchor.interactionId,
        }
      : {}),
  } satisfies Omit<
    Interactions.CreateModelInteractionParamsNonStreaming,
    'stream' | 'background'
  >;
}

/**
 * A completed step carrying the exact argument bytes when they were observed.
 * The stream delivers tool arguments as text deltas, so it keeps them; a
 * background snapshot returns only the SDK's parse of them and keeps none.
 */
type ObservedStep = z.infer<typeof WireCompletedStepSchema> & {
  readonly argumentsText?: string;
};

const normalizeCompleted = Effect.fn('llm.google.normalizeCompleted')(
  function* (
    interaction: z.infer<typeof WireInteractionSchema>,
    responseSteps: readonly ObservedStep[],
    origin: ModelOrigin,
  ) {
    const usage = interaction.usage;
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
        content.push({
          kind: 'message',
          content: [{ kind: 'text', text: text.text }],
        });
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
          // A background snapshot hands back the SDK's parse with no bytes
          // behind it, so its text is re-encoded from that parse.
          argumentsText: step.argumentsText ?? JSON.stringify(step.arguments),
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
    if ((interaction.status === 'requires_action') !== callIds.size > 0) {
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Google completion status disagrees with its local calls.',
        responseId: interaction.id,
      });
    }
    const result = TurnResultSchema.safeParse({
      kind: 'http',
      providerResponseId: interaction.id,
      requestedOrigin: origin,
      returnedModel: interaction.model ?? null,
      modelFingerprint: null,
      content,
      finishReason:
        interaction.status === 'requires_action' ? 'tool-calls' : 'stop',
      finishEvidence: {
        kind: 'google-interactions',
        status: interaction.status,
        // The Interactions resource reports no reason for ending, so the
        // status is the whole of what Google says about the outcome.
        terminalReason: null,
      },
      usage:
        usage === undefined
          ? null
          : {
              inputTokens: usage.total_input_tokens ?? null,
              outputTokens: usage.total_output_tokens ?? null,
              totalTokens: usage.total_tokens ?? null,
              cachedInputTokens: usage.total_cached_tokens ?? null,
              reasoningTokens: usage.total_thought_tokens ?? null,
              providerUsage: {
                kind: 'google',
                toolUsePromptTokens: usage.total_tool_use_tokens ?? null,
              },
            },
    });
    if (!result.success) {
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Google returned invalid canonical output.',
        cause: result.error,
      });
    }
    return result.data;
  },
);

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
      if (parsed.data.parallelToolCalls !== undefined) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Google parallel-call control is not implemented.',
        });
      }
      if (
        parsed.data.reasoning !== undefined ||
        parsed.data.serviceTier !== undefined ||
        parsed.data.thinking !== undefined ||
        parsed.data.effort !== undefined ||
        parsed.data.cache !== undefined ||
        parsed.data.stopSequences !== undefined ||
        (parsed.data.continuation !== undefined &&
          parsed.data.continuation.origin.protocol !== 'google-interactions')
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Google does not support the supplied protocol controls.',
        });
      }
      const mode = parsed.data.mode ?? 'foreground';
      if (
        mode === 'background' &&
        (config.background !== 'supported' ||
          !(parsed.data.store ?? config.defaults.store))
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Google background execution requires an enabled route and store:true.',
        });
      }
      const turn = ResolvedTurnSchema.parse({
        ...origin,
        mode,
        system: parsed.data.system,
        messages: parsed.data.messages,
        tools: parsed.data.tools ?? [],
        continuation: parsed.data.continuation,
        controls: {
          toolChoice: parsed.data.toolChoice ?? 'auto',
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
      const enrich = (error: ModelError) =>
        new ModelError({
          ...error,
          message: error.message,
          cause: error.cause,
          responseId,
          model: returnedModel ?? config.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const parsed = ResolvedTurnSchema.safeParse(input);
          if (
            !parsed.success ||
            parsed.data.protocol !== 'google-interactions' ||
            parsed.data.mode !== 'foreground'
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
          const signal = yield* readerAbortSignal(() => reader);
          const source = yield* Effect.tryPromise({
            try: () =>
              client.interactions.create(
                {
                  ...createInput(turn, inputSteps),
                  background: false,
                  stream: true,
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
                const hadIdentity = responseId !== undefined;
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
                } else if (
                  responseId === undefined &&
                  event.event_type !== 'error'
                ) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'Google emitted content before identifying its interaction.',
                  });
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
                  if (
                    event.step.type === 'thought' ||
                    event.step.type === 'model_output'
                  )
                    progress.push({
                      kind: 'phase',
                      part:
                        event.step.type === 'thought' ? 'reasoning' : 'text',
                      boundary: 'start',
                      providerItemIndex: event.index,
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
                    if (
                      slot.step.type === 'thought' ||
                      slot.step.type === 'model_output'
                    )
                      progress.push({
                        kind: 'phase',
                        part:
                          slot.step.type === 'thought' ? 'reasoning' : 'text',
                        boundary: 'end',
                        providerItemIndex: event.index,
                      });
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
                        providerItemIndex: event.index,
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
                        providerItemIndex: event.index,
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
                if (!hadIdentity && responseId !== undefined)
                  progress.unshift({
                    kind: 'identified',
                    providerResponseId: responseId,
                    requestedOrigin: origin,
                    returnedModel,
                  });
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
              const responseSteps: ObservedStep[] = [];
              for (const [index, slot] of ordered) {
                if (!slot.stopped || index !== responseSteps.length) {
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'Google ended with an incomplete step sequence.',
                  });
                }
                const argumentsText = slot.argumentsText;
                if (
                  slot.step.type === 'function_call' &&
                  argumentsText !== undefined
                ) {
                  responseSteps.push({
                    ...slot.step,
                    arguments: yield* Effect.try({
                      try: () => JSON.parse(argumentsText),
                      catch: (cause) =>
                        new ModelError({
                          kind: 'malformed-output',
                          message: 'Google emitted malformed tool arguments.',
                          cause,
                        }),
                    }),
                    argumentsText,
                  });
                  continue;
                }
                responseSteps.push(slot.step);
              }
              const result = yield* normalizeCompleted(
                {
                  ...completed,
                  id: responseId,
                  model: returnedModel ?? undefined,
                  usage,
                },
                responseSteps,
                origin,
              );
              if (turn.controls.store) {
                const prefix: ResolvedTurn['messages'] = [
                  ...turn.messages,
                  { role: 'assistant', origin, content: result.content },
                ];
                const coveredSteps = yield* lowerMessages(prefix, origin);
                return {
                  kind: 'completed',
                  result: TurnResultSchema.parse({
                    ...result,
                    continuation: {
                      origin,
                      coveredMessages: prefix.length,
                      prefixFingerprint: prefixFingerprint(
                        'texra-google-interactions-prefix-v1',
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
              return { kind: 'completed', result: result } as const;
            }),
          );
          return Stream.concat(events, terminal).pipe(Stream.mapError(enrich));
        }).pipe(Effect.mapError(enrich)),
      );
    });

  const generateTurn: Model['generateTurn'] = (turn) =>
    completedTurn(streamTurn(turn));
  const boundOperation = Effect.fn('llm.google.boundOperation')(function* (
    input: RemoteOperation,
  ) {
    const parsed = RemoteOperationSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.origin.protocol !== 'google-interactions' ||
      !sameModelOrigin(parsed.data.origin, origin)
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The remote operation belongs to another model binding.',
      });
    }
    return parsed.data;
  });

  const snapshot = Effect.fn('llm.google.snapshot')(function* (
    raw: unknown,
    operation: RemoteOperation,
  ) {
    const parsed = WireInteractionSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== operation.providerResponseId) {
      return yield* new ModelError({
        kind: 'malformed-output',
        message:
          'Google returned a malformed or mismatched interaction snapshot.',
        cause: parsed.success ? undefined : parsed.error,
      });
    }
    return parsed.data;
  });
  const completedSnapshot = Effect.fn('llm.google.completedSnapshot')(
    function* (interaction: z.infer<typeof WireInteractionSchema>) {
      if (
        interaction.status !== 'completed' &&
        interaction.status !== 'requires_action'
      ) {
        return yield* new ModelError({
          kind: [
            'failed',
            'cancelled',
            'incomplete',
            'budget_exceeded',
          ].includes(interaction.status)
            ? 'provider-rejection'
            : 'malformed-output',
          message: `Google background interaction ended with status ${interaction.status}.`,
        });
      }
      const steps = z
        .array(WireCompletedStepSchema)
        .safeParse(interaction.steps);
      if (!steps.success) {
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Google returned malformed or unsupported completed steps.',
          cause: steps.error,
        });
      }
      return yield* normalizeCompleted(interaction, steps.data, origin);
    },
  );
  const withOperation = (
    operation: RemoteOperation,
    error: ModelError,
    returnedModel?: string,
  ) =>
    new ModelError({
      ...error,
      message: error.message,
      cause: error.cause,
      operation,
      responseId: operation.providerResponseId,
      model: returnedModel ?? error.model ?? config.requestedModel,
    });
  const submit: NonNullable<Model['background']>['submit'] = Effect.fn(
    'llm.google.submit',
  )(function* (input) {
    let operation: RemoteOperation | undefined;
    return yield* Effect.gen(function* () {
      const parsed = ResolvedTurnSchema.safeParse(input);
      if (
        !parsed.success ||
        parsed.data.protocol !== 'google-interactions' ||
        parsed.data.mode !== 'background' ||
        config.background !== 'supported' ||
        !parsed.data.controls.store
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Google background execution requires an enabled route and store:true.',
        });
      }
      const turn = parsed.data;
      const inputSteps = yield* invocationInput(turn, origin);
      const raw = yield* ownedRequest((signal) =>
        client.interactions.create(
          { ...createInput(turn, inputSteps), background: true, stream: false },
          { maxRetries: 0, fetchOptions: { signal } },
        ),
      );
      // Retain a real accepted identifier even if later snapshot validation fails.
      const identity = z.object({ id: z.string().min(1) }).safeParse(raw);
      if (!identity.success)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Google returned no background interaction identifier.',
          cause: identity.error,
        });
      operation = RemoteOperationSchema.parse({
        origin,
        providerResponseId: identity.data.id,
        afterSequence: null,
      });
      const interaction = yield* snapshot(raw, operation);
      if (
        interaction.status === 'queued' ||
        interaction.status === 'in_progress'
      ) {
        return BackgroundSubmissionSchema.parse({
          kind: 'accepted',
          operation,
          returnedModel: interaction.model ?? null,
        });
      }
      return BackgroundSubmissionSchema.parse({
        kind: 'completed',
        result: yield* completedSnapshot(interaction),
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(cause, (error) =>
            operation === undefined ? error : withOperation(operation, error),
          ),
        ),
      ),
    );
  });
  const observe: NonNullable<Model['background']>['observe'] = (
    input,
    policy,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const operation = yield* boundOperation(input);
        const parsedPolicy = ObservationPolicySchema.safeParse(policy);
        if (!parsedPolicy.success)
          return yield* new ModelError({
            kind: 'invalid-request',
            message: 'The observation deadline is invalid.',
            cause: parsedPolicy.error,
            operation,
          });
        const deadline = new ModelError({
          kind: 'observation-deadline',
          message: 'The original observation deadline has expired.',
          operation,
          responseId: operation.providerResponseId,
        });
        if (parsedPolicy.data.deadlineAtMs <= (yield* Clock.currentTimeMillis))
          return yield* deadline;
        let returnedModel: string | undefined;
        const completion = Effect.gen(function* () {
          while (true) {
            // Consumer delay and prior polls consume the original deadline.
            const remaining =
              parsedPolicy.data.deadlineAtMs - (yield* Clock.currentTimeMillis);
            if (remaining <= 0) return yield* deadline;
            const raw = yield* ownedRequest(
              (signal) =>
                client.interactions.get(
                  operation.providerResponseId,
                  { stream: false, include_input: false },
                  { maxRetries: 0, fetchOptions: { signal } },
                ),
              (cause) =>
                withOperation(operation, sdkFailure(cause), returnedModel),
              { duration: remaining, error: deadline },
            );
            const interaction = yield* snapshot(raw, operation);
            if (interaction.model !== undefined) {
              if (
                returnedModel !== undefined &&
                returnedModel !== interaction.model
              ) {
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'Google changed the returned model for an accepted interaction.',
                });
              }
              returnedModel = interaction.model;
            }
            if (
              interaction.status !== 'queued' &&
              interaction.status !== 'in_progress'
            ) {
              return BackgroundEventSchema.parse({
                kind: 'completed',
                afterSequence: null,
                result: yield* completedSnapshot({
                  ...interaction,
                  model: returnedModel,
                }),
              });
            }
            yield* Effect.sleep(
              Math.min(
                5_000,
                Math.max(
                  0,
                  parsedPolicy.data.deadlineAtMs -
                    (yield* Clock.currentTimeMillis),
                ),
              ),
            );
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.failCause(
              Cause.map(cause, (error) =>
                withOperation(operation, error, returnedModel),
              ),
            ),
          ),
        );
        return Stream.concat(
          Stream.succeed(
            BackgroundEventSchema.parse({
              kind: 'identified',
              afterSequence: null,
              providerResponseId: operation.providerResponseId,
              requestedOrigin: origin,
              returnedModel: null,
            }),
          ),
          Stream.fromEffect(completion),
        );
      }),
    );
  const cancel: NonNullable<Model['background']>['cancel'] = Effect.fn(
    'llm.google.cancel',
  )(function* (input) {
    const operation = yield* boundOperation(input);
    return yield* Effect.gen(function* () {
      const raw = yield* ownedRequest(
        (signal) =>
          client.interactions.cancel(operation.providerResponseId, undefined, {
            maxRetries: 0,
            fetchOptions: { signal },
          }),
        (cause) => withOperation(operation, sdkFailure(cause)),
      );
      const interaction = yield* snapshot(raw, operation);
      const identity = {
        providerResponseId: operation.providerResponseId,
        requestedOrigin: origin,
        returnedModel: interaction.model ?? null,
      };
      if (interaction.status === 'cancelled')
        return CancellationEvidenceSchema.parse({
          ...identity,
          kind: 'confirmed-cancelled',
        });
      if (
        [
          'completed',
          'requires_action',
          'failed',
          'incomplete',
          'budget_exceeded',
        ].includes(interaction.status)
      )
        return CancellationEvidenceSchema.parse({
          ...identity,
          kind: 'observed-terminal',
          status: interaction.status,
        });
      if (
        interaction.status === 'queued' ||
        interaction.status === 'in_progress'
      )
        return CancellationEvidenceSchema.parse({
          ...identity,
          kind: 'unconfirmed',
          status: interaction.status,
        });
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Google returned an unknown cancellation status.',
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(cause, (error) => withOperation(operation, error)),
        ),
      ),
    );
  });

  const estimateInputTokens: NonNullable<Model['estimateInputTokens']> =
    Effect.fn('llm.google.estimateInputTokens')(function* (input) {
      const parsed = ResolvedTurnSchema.safeParse(input);
      if (
        !parsed.success ||
        parsed.data.protocol !== 'google-interactions' ||
        parsed.data.mode !== 'foreground'
      )
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'The prepared Google count invocation is unsupported.',
        });
      const turn = parsed.data;
      yield* invocationInput(turn, origin);
      const message = turn.messages[0];
      if (
        turn.continuation !== undefined ||
        turn.tools.length !== 0 ||
        turn.messages.length !== 1 ||
        message?.role !== 'user' ||
        !message.content.every((part) => part.kind === 'text')
      )
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Google counting supports one initial text-only user message and optional system text.',
        });
      const parts = message.content.map((part) => ({ text: part.text }));
      const response = yield* ownedRequest((signal) =>
        client.models.countTokens({
          model: turn.requestedModel,
          // Preserve the existing converted-content estimate, not a claim
          // to count the full Interactions request or its thinking controls.
          contents: [
            ...(turn.system === undefined
              ? []
              : [{ role: 'system', parts: [{ text: turn.system }] }]),
            { role: 'user', parts },
          ],
          config: {
            abortSignal: signal,
            httpOptions: { retryOptions: { attempts: 1 } },
          },
        }),
      );
      const count = z
        .object({ totalTokens: z.int().nonnegative() })
        .safeParse(response);
      if (!count.success)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Google returned no valid input token estimate.',
          cause: count.error,
        });
      return Object.freeze({
        inputTokens: count.data.totalTokens,
        coverage: 'google-converted-content' as const,
      });
    });
  return Object.freeze({
    prepareTurn,
    streamTurn,
    generateTurn,
    ...(config.background === 'supported'
      ? { background: Object.freeze({ submit, observe, cancel }) }
      : {}),
    ...(config.supportsInputTokenEstimation ? { estimateInputTokens } : {}),
  });
}
