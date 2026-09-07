// Node imports
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Cause, Clock, Effect, Exit, Stream, type Scope } from 'effect';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import { openaiFailure } from './openaiError.js';
import { prefixFingerprint } from './prefixFingerprint.js';
import {
  BackgroundSubmissionSchema,
  CancellationEvidenceSchema,
  ContinuationSchema,
  JsonObjectSchema,
  ModelConfigurationSchema,
  ModelError,
  ModelOriginSchema,
  ObservationPolicySchema,
  RemoteOperationSchema,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  sameModelOrigin,
  type Model,
  type ModelOrigin,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
  type BackgroundEvent,
  type BackgroundSubmission,
  type Continuation,
  type RemoteOperation,
} from './turn.js';

const ItemStatusSchema = z.enum(['in_progress', 'completed', 'incomplete']);
const OutputItemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('message'),
    id: z.string().min(1),
    role: z.literal('assistant'),
    status: ItemStatusSchema,
    phase: z.enum(['commentary', 'final_answer']).nullish(),
    content: z.array(
      z.discriminatedUnion('type', [
        z.strictObject({
          type: z.literal('output_text'),
          text: z.string(),
          // Unsupported annotations/log probabilities cannot disappear in conversion.
          annotations: z.array(z.never()),
          logprobs: z.array(z.never()).optional(),
        }),
        z.strictObject({ type: z.literal('refusal'), refusal: z.string() }),
      ]),
    ),
  }),
  z.strictObject({
    type: z.literal('reasoning'),
    id: z.string().min(1),
    status: ItemStatusSchema.optional(),
    encrypted_content: z.string().nullish(),
    summary: z.array(
      z.strictObject({ type: z.literal('summary_text'), text: z.string() }),
    ),
    content: z
      .array(
        z.strictObject({ type: z.literal('reasoning_text'), text: z.string() }),
      )
      .optional(),
  }),
  z.strictObject({
    type: z.literal('function_call'),
    id: z.string().min(1).optional(),
    status: ItemStatusSchema.optional(),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  }),
]);
type OutputItem = z.infer<typeof OutputItemSchema>;

function itemIdentity(item: OutputItem) {
  return {
    type: item.type,
    id: item.id,
    callId: item.type === 'function_call' ? item.call_id : undefined,
    name: item.type === 'function_call' ? item.name : undefined,
  };
}

/** A sparse terminal snapshot may omit evidence, but cannot revise a done item. */
function agreesWithCompleted(
  completed: TurnResult['content'][number],
  candidate: TurnResult['content'][number],
): boolean {
  if (completed.kind === 'message' && candidate.kind === 'message') {
    return (
      isDeepStrictEqual(completed.content, candidate.content) &&
      completed.evidence?.itemId === candidate.evidence?.itemId &&
      completed.evidence?.status === candidate.evidence?.status &&
      (candidate.evidence?.phase === undefined ||
        completed.evidence?.phase === candidate.evidence.phase)
    );
  }
  if (completed.kind === 'reasoning' && candidate.kind === 'reasoning') {
    if (
      completed.evidence?.kind !== 'openai-responses-reasoning' ||
      candidate.evidence?.kind !== 'openai-responses-reasoning'
    )
      return false;
    return (
      isDeepStrictEqual(completed.summary, candidate.summary) &&
      (candidate.content === undefined ||
        isDeepStrictEqual(completed.content, candidate.content)) &&
      completed.evidence.itemId === candidate.evidence.itemId &&
      (candidate.evidence.status === undefined ||
        completed.evidence.status === candidate.evidence.status) &&
      (candidate.evidence.encryptedContent === undefined ||
        completed.evidence.encryptedContent ===
          candidate.evidence.encryptedContent)
    );
  }
  if (completed.kind === 'local-call' && candidate.kind === 'local-call') {
    return (
      completed.providerCallId === candidate.providerCallId &&
      completed.name === candidate.name &&
      isDeepStrictEqual(completed.arguments, candidate.arguments) &&
      (candidate.evidence?.itemId === undefined ||
        completed.evidence?.itemId === candidate.evidence.itemId) &&
      (candidate.evidence?.status === undefined ||
        completed.evidence?.status === candidate.evidence.status)
    );
  }
  return false;
}

const UsageSchema = z.object({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  total_tokens: z.int().nonnegative(),
  input_tokens_details: z
    .object({ cached_tokens: z.int().nonnegative().nullish() })
    .nullish(),
  output_tokens_details: z
    .object({ reasoning_tokens: z.int().nonnegative().nullish() })
    .nullish(),
});
const ResponseSchema = z.object({
  id: z.string().min(1),
  object: z.literal('response'),
  model: z.string().min(1),
  status: z.enum([
    'queued',
    'in_progress',
    'completed',
    'failed',
    'cancelled',
    'incomplete',
  ]),
  output: z.array(OutputItemSchema),
  usage: UsageSchema.nullish(),
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
  incomplete_details: z
    .object({ reason: z.enum(['max_output_tokens', 'content_filter']) })
    .nullish(),
});
type ResponseValue = z.infer<typeof ResponseSchema>;

const normalizeItem = Effect.fn('llm.responses.normalizeItem')(function* (
  item: OutputItem,
): Effect.fn.Return<TurnResult['content'][number], ModelError> {
  if (item.status === 'in_progress') {
    return yield* new ModelError({
      kind: 'malformed-output',
      message: 'Unfinished model items cannot form a completed tool exchange.',
    });
  }
  switch (item.type) {
    case 'message':
      return {
        kind: 'message',
        content: item.content.map((part) =>
          part.type === 'output_text'
            ? { kind: 'text', text: part.text }
            : { kind: 'refusal', text: part.refusal },
        ),
        evidence: {
          kind: 'openai-responses-message',
          itemId: item.id,
          status: item.status,
          ...(item.phase !== undefined ? { phase: item.phase } : {}),
        },
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        summary: item.summary.map((part) => ({
          kind: 'text',
          text: part.text,
        })),
        ...(item.content !== undefined
          ? {
              content: item.content.map((part) => ({
                kind: 'text' as const,
                text: part.text,
              })),
            }
          : {}),
        evidence: {
          kind: 'openai-responses-reasoning',
          itemId: item.id,
          ...(item.status !== undefined ? { status: item.status } : {}),
          ...(item.encrypted_content !== undefined
            ? { encryptedContent: item.encrypted_content }
            : {}),
        },
      };
    case 'function_call': {
      if (item.status === 'incomplete') {
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Incomplete local calls are not dispatchable.',
        });
      }
      const args = yield* Effect.try({
        try: () => JsonObjectSchema.parse(JSON.parse(item.arguments)),
        catch: (cause) =>
          new ModelError({
            kind: 'malformed-output',
            message: 'The model returned invalid local-call arguments.',
            cause,
          }),
      });
      return {
        kind: 'local-call',
        providerCallId: item.call_id,
        name: item.name,
        arguments: args,
        evidence: {
          kind: 'openai-responses-function-call',
          ...(item.id !== undefined ? { itemId: item.id } : {}),
          ...(item.status !== undefined ? { status: item.status } : {}),
        },
      };
    }
  }
});

const normalizeResponse = Effect.fn('llm.responses.normalizeResponse')(
  function* (
    response: ResponseValue,
    origin: ModelOrigin,
    content: TurnResult['content'],
  ) {
    let finishReason: TurnResult['finishReason'];
    if (response.status === 'completed') {
      finishReason = content.some((item) => item.kind === 'local-call')
        ? 'tool-calls'
        : 'stop';
    } else if (
      response.status === 'incomplete' &&
      response.incomplete_details != null &&
      !content.some((item) => item.kind === 'local-call')
    ) {
      finishReason =
        response.incomplete_details.reason === 'max_output_tokens'
          ? 'length'
          : 'content-filter';
    } else {
      return yield* new ModelError({
        kind: 'provider-rejection',
        message:
          response.error?.message ??
          `The model response ended with status ${response.status}.`,
        cause: response.error,
      });
    }
    const result = TurnResultSchema.safeParse({
      providerResponseId: response.id,
      requestedOrigin: origin,
      returnedModel: response.model,
      modelFingerprint: null,
      content,
      finishReason,
      usage: response.usage
        ? {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
            totalTokens: response.usage.total_tokens,
            cachedInputTokens:
              response.usage.input_tokens_details?.cached_tokens ?? null,
            reasoningTokens:
              response.usage.output_tokens_details?.reasoning_tokens ?? null,
          }
        : null,
    });
    if (!result.success) {
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'The model returned inconsistent completed content.',
        cause: result.error,
      });
    }
    return result.data;
  },
);

const lowerInput = Effect.fn('llm.responses.lowerInput')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
) {
  const input: OpenAI.Responses.ResponseInput = [];
  let callIds: string[] = [];
  for (const message of turn.messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        const text: string[] = [];
        for (const part of result.content) {
          if (part.kind !== 'text') {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'This Responses implementation requires text tool results.',
            });
          }
          text.push(part.text);
        }
        input.push({
          type: 'function_call_output',
          call_id: callIds[result.callOrdinal],
          output:
            result.status === 'error'
              ? `Error: ${text.join('')}`
              : text.join(''),
        });
      }
      continue;
    }
    callIds = [];
    if (message.role === 'user') {
      const content: OpenAI.Responses.ResponseInputText[] = [];
      for (const part of message.content) {
        if (part.kind !== 'text') {
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'This Responses implementation requires text user input.',
          });
        }
        content.push({ type: 'input_text', text: part.text });
      }
      input.push({ role: 'user', content });
      continue;
    }
    for (const part of message.content) {
      if (part.evidence != null && !sameModelOrigin(message.origin, turn)) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Provider content evidence belongs to another model origin.',
        });
      }
      switch (part.kind) {
        case 'message': {
          if (part.evidence) {
            input.push({
              type: 'message',
              role: 'assistant',
              id: part.evidence.itemId,
              status: part.evidence.status,
              ...(part.evidence.phase !== undefined
                ? { phase: part.evidence.phase }
                : {}),
              content: part.content.map((child) =>
                child.kind === 'text'
                  ? { type: 'output_text', text: child.text, annotations: [] }
                  : { type: 'refusal', refusal: child.text },
              ),
            });
          } else {
            const text: string[] = [];
            for (const child of part.content) {
              if (child.kind !== 'text') {
                return yield* new ModelError({
                  kind: 'unsupported',
                  message:
                    'Responses refusal history requires its original message evidence.',
                });
              }
              text.push(child.text);
            }
            input.push({ role: 'assistant', content: text.join('') });
          }
          break;
        }
        case 'reasoning': {
          if (part.evidence?.kind !== 'openai-responses-reasoning') {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Responses reasoning requires its original provider evidence.',
            });
          }
          input.push({
            type: 'reasoning',
            id: part.evidence.itemId,
            summary: part.summary.map((child) => ({
              type: 'summary_text',
              text: child.text,
            })),
            ...(part.content !== undefined
              ? {
                  content: part.content.map((child) => ({
                    type: 'reasoning_text' as const,
                    text: child.text,
                  })),
                }
              : {}),
            ...(part.evidence.status !== undefined
              ? { status: part.evidence.status }
              : {}),
            ...(part.evidence.encryptedContent !== undefined
              ? { encrypted_content: part.evidence.encryptedContent }
              : {}),
          });
          break;
        }
        case 'local-call': {
          if (part.providerCallId === null) {
            return yield* new ModelError({
              kind: 'unsupported',
              message: 'Responses tool history requires original call IDs.',
            });
          }
          callIds.push(part.providerCallId);
          input.push({
            type: 'function_call',
            call_id: part.providerCallId,
            name: part.name,
            arguments: JSON.stringify(part.arguments),
            ...(part.evidence?.itemId !== undefined
              ? { id: part.evidence.itemId }
              : {}),
            ...(part.evidence?.status !== undefined
              ? { status: part.evidence.status }
              : {}),
          });
          break;
        }
      }
    }
  }
  const choice = turn.controls.toolChoice;
  if (
    choice !== 'auto' &&
    !turn.tools.some((tool) => tool.name === choice.name)
  ) {
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'The required tool must be present in the supplied definitions.',
    });
  }
  return input;
});

/** Builds a stored HTTP response anchor from exact materialized admitted input. */
export const openaiResponsesContinuation = Effect.fn(
  'llm.responses.continuation',
)(function* (
  input: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  completed: TurnResult,
): Effect.fn.Return<Continuation | undefined, ModelError> {
  const parsedTurn = ResolvedTurnSchema.safeParse(input);
  const parsedResult = TurnResultSchema.safeParse(completed);
  if (
    !parsedTurn.success ||
    parsedTurn.data.protocol !== 'openai-responses' ||
    !parsedResult.success ||
    !sameModelOrigin(parsedTurn.data, parsedResult.data.requestedOrigin)
  )
    return yield* new ModelError({
      kind: 'invalid-request',
      message:
        'Continuation requires the original admitted input and matching completed output.',
    });
  const turn = parsedTurn.data;
  const result = parsedResult.data;
  // HTTP stored-response chaining is separate from temporary background retrieval.
  // https://developers.openai.com/api/docs/guides/conversation-state
  if (
    !turn.controls.store ||
    (result.finishReason !== 'stop' && result.finishReason !== 'tool-calls')
  )
    return undefined;
  const prefix: ResolvedTurn['messages'] = [
    ...turn.messages,
    {
      role: 'assistant',
      origin: result.requestedOrigin,
      content: result.content,
    },
  ];
  const encoded = yield* lowerInput({ ...turn, messages: prefix });
  return ContinuationSchema.parse({
    origin: result.requestedOrigin,
    coveredMessages: prefix.length,
    prefixFingerprint: prefixFingerprint(
      'texra-openai-responses-prefix-v1',
      result.requestedOrigin,
      turn.system,
      prefix,
    ),
    anchor: {
      responseId: result.providerResponseId,
      coveredItems: encoded.length,
    },
  });
});

const responseInput = Effect.fn('llm.responses.input')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
) {
  const input = yield* lowerInput(turn);
  const continuation = turn.continuation;
  if (!continuation) return { input };
  const prefix = turn.messages.slice(0, continuation.coveredMessages);
  const encodedPrefix = yield* lowerInput({ ...turn, messages: prefix });
  if (
    !sameModelOrigin(turn, continuation.origin) ||
    continuation.coveredMessages > turn.messages.length ||
    continuation.anchor.coveredItems !== encodedPrefix.length ||
    continuation.prefixFingerprint !==
      prefixFingerprint(
        'texra-openai-responses-prefix-v1',
        continuation.origin,
        turn.system,
        prefix,
      )
  )
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'Continuation does not cover the exact admitted prefix.',
    });
  return {
    input: input.slice(continuation.anchor.coveredItems),
    previous_response_id: continuation.anchor.responseId,
  };
});

const EventSchema = z.object({
  type: z.string(),
  sequence_number: z.int().nonnegative(),
});
const ResponseEventSchema = EventSchema.extend({ response: ResponseSchema });
const ItemEventSchema = EventSchema.extend({
  output_index: z.int().nonnegative(),
  item: OutputItemSchema,
});
const DeltaEventSchema = EventSchema.extend({
  item_id: z.string().min(1),
  output_index: z.int().nonnegative(),
  delta: z.string(),
  logprobs: z.array(z.never()).optional(),
});

/** Owns only the foreign iterator lifetime shared by create and retrieve. */
const sdkEvents = Effect.fn('llm.responses.sdkEvents')(function* (
  source: AsyncIterable<unknown> & { readonly controller: AbortController },
  enrich: (error: ModelError) => ModelError,
) {
  const iterator = yield* Effect.acquireRelease(
    Effect.sync(() => source[Symbol.asyncIterator]()),
    (iterator) =>
      Effect.gen(function* () {
        source.controller.abort();
        if (!iterator.return) return;
        const close = Effect.tryPromise({
          try: () => iterator.return!(),
          catch: (cause) =>
            enrich(
              new ModelError({
                kind: 'transport',
                message: 'The model stream cleanup failed.',
                cause,
              }),
            ),
        });
        yield* close.pipe(Effect.orDie);
      }),
  );
  return Stream.fromPull(
    Effect.succeed(
      Effect.tryPromise({
        try: () => iterator.next(),
        catch: (cause) =>
          enrich(
            cause instanceof SyntaxError
              ? new ModelError({
                  kind: 'malformed-output',
                  message: 'The model returned malformed stream data.',
                  cause,
                })
              : openaiFailure(cause),
          ),
      }).pipe(
        Effect.flatMap((next) =>
          next.done ? Cause.done() : Effect.succeed([next.value] as const),
        ),
      ),
    ),
  );
});

/** Direct Responses operations, with no application model adapter. */
export function openaiResponsesModel(
  configuration: OpenAIResponsesConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openai-responses') {
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  }
  const origin = ModelOriginSchema.parse({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1,
  });
  if (process.env.OPENAI_CUSTOM_HEADERS) {
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Ambient OpenAI headers cannot override the selected deployment.',
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
  const prepareTurn: Model['prepareTurn'] = Effect.fn(
    'llm.responses.prepareTurn',
  )(function* (request) {
    const parsed = TurnRequestSchema.safeParse(request);
    if (!parsed.success)
      return yield* new ModelError({
        kind: 'invalid-request',
        message: 'The model input is invalid.',
        cause: parsed.error,
      });
    const author = parsed.data;
    if (
      author.thinkingLevel !== undefined ||
      author.thinking !== undefined ||
      author.effort !== undefined ||
      author.cache !== undefined ||
      author.inferenceGeo !== undefined ||
      author.stopSequences !== undefined ||
      (author.continuation !== undefined &&
        author.continuation.origin.protocol !== 'openai-responses') ||
      (author.serviceTier != null && author.serviceTier !== 'fast') ||
      (author.mode === 'background' && config.background !== 'supported') ||
      (!config.supportsTemperature && author.temperature !== undefined)
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The model does not support the requested controls or continuation.',
      });
    }
    const turn = ResolvedTurnSchema.parse({
      ...origin,
      mode: author.mode ?? 'foreground',
      system: author.system,
      messages: author.messages,
      tools: author.tools ?? [],
      continuation: author.continuation,
      controls: {
        temperature: config.supportsTemperature
          ? (author.temperature ?? config.defaults.temperature)
          : null,
        maxOutputTokens:
          author.maxOutputTokens ?? config.defaults.maxOutputTokens,
        store: author.store ?? config.defaults.store,
        parallelToolCalls:
          author.parallelToolCalls ?? config.defaults.parallelToolCalls,
        toolChoice: author.toolChoice ?? 'auto',
        reasoning:
          author.reasoning === undefined
            ? config.defaults.reasoning
            : author.reasoning,
        serviceTier:
          author.serviceTier === undefined
            ? config.defaults.serviceTier
            : author.serviceTier,
      },
    });
    if (turn.protocol !== 'openai-responses')
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The prepared protocol changed.',
      });
    yield* responseInput(turn);
    return turn;
  });

  const createResponse = Effect.fn('llm.responses.create')(function* (
    input: ResolvedTurn,
    mode: 'foreground' | 'background',
  ) {
    const parsed = ResolvedTurnSchema.safeParse(input);
    if (
      !parsed.success ||
      parsed.data.protocol !== 'openai-responses' ||
      parsed.data.mode !== mode ||
      !sameModelOrigin(parsed.data, origin) ||
      (mode === 'background' && config.background !== 'supported')
    ) {
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'The prepared invocation belongs to another model, protocol or execution mode.',
      });
    }
    const turn = parsed.data;
    if (!config.supportsTemperature && turn.controls.temperature !== null)
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'This model does not support temperature.',
      });
    const wireInput = yield* responseInput(turn);
    const reasoning = turn.controls.reasoning;
    const signal = yield* Effect.abortSignal;
    const opened = yield* Effect.tryPromise({
      try: () =>
        client.responses
          .create(
            {
              model: turn.requestedModel,
              ...wireInput,
              ...(turn.system !== undefined
                ? { instructions: turn.system }
                : {}),
              max_output_tokens: turn.controls.maxOutputTokens,
              store: turn.controls.store,
              stream: true,
              background: mode === 'background',
              include: ['reasoning.encrypted_content'],
              ...(turn.controls.temperature !== null
                ? { temperature: turn.controls.temperature }
                : {}),
              ...(turn.controls.serviceTier !== null
                ? { service_tier: turn.controls.serviceTier }
                : {}),
              ...(reasoning !== null
                ? {
                    reasoning: {
                      ...(reasoning.effort !== null
                        ? { effort: reasoning.effort }
                        : {}),
                      ...(reasoning.mode !== null
                        ? { mode: reasoning.mode }
                        : {}),
                      ...(reasoning.summary !== null
                        ? { summary: reasoning.summary }
                        : {}),
                    },
                  }
                : {}),
              ...(turn.tools.length > 0
                ? {
                    tools: turn.tools.map((tool) => ({
                      type: 'function' as const,
                      ...tool,
                      strict: false,
                    })),
                    parallel_tool_calls: turn.controls.parallelToolCalls,
                    tool_choice:
                      turn.controls.toolChoice === 'auto'
                        ? ('auto' as const)
                        : {
                            type: 'function' as const,
                            name: turn.controls.toolChoice.name,
                          },
                  }
                : {}),
            },
            { signal },
          )
          .withResponse(),
      catch: openaiFailure,
    });
    return { turn, opened };
  });

  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      let requestId: string | undefined;
      const enrich = (error: ModelError) =>
        new ModelError({
          ...error,
          message: error.message,
          cause: error.cause,
          requestId: error.requestId ?? requestId,
          responseId,
          model: returnedModel ?? config.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const { turn, opened } = yield* createResponse(input, 'foreground');
          requestId = opened.request_id ?? undefined;
          const chunks = yield* sdkEvents(opened.data, enrich);
          const items = new Map<
            number,
            {
              identity: ReturnType<typeof itemIdentity>;
              done?: TurnResult['content'][number];
            }
          >();
          let terminal: ResponseValue | undefined;
          let sequence = -1;
          const progress = chunks.pipe(
            Stream.mapEffect((raw) =>
              Effect.gen(function* (): Effect.fn.Return<
                readonly TurnEvent[],
                ModelError
              > {
                const header = EventSchema.safeParse(raw);
                if (!header.success || header.data.sequence_number <= sequence)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The model emitted invalid or out-of-order events.',
                  });
                sequence = header.data.sequence_number;
                const type = header.data.type;
                if (
                  [
                    'response.created',
                    'response.queued',
                    'response.in_progress',
                    'response.completed',
                    'response.incomplete',
                    'response.failed',
                  ].includes(type)
                ) {
                  const decoded = ResponseEventSchema.safeParse(raw);
                  if (!decoded.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The response snapshot is malformed or unsupported.',
                      cause: decoded.error,
                    });
                  const response = decoded.data.response;
                  if (
                    (responseId !== undefined && responseId !== response.id) ||
                    (returnedModel !== undefined &&
                      returnedModel !== response.model)
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'The model changed its response identity.',
                    });
                  const firstIdentity = responseId === undefined;
                  responseId = response.id;
                  returnedModel = response.model;
                  if (
                    type === 'response.completed' ||
                    type === 'response.incomplete' ||
                    type === 'response.failed'
                  ) {
                    const expected = type.slice('response.'.length);
                    if (response.status !== expected)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'The terminal event and response status disagree.',
                      });
                    terminal = response;
                  }
                  return firstIdentity
                    ? [
                        {
                          kind: 'identified' as const,
                          providerResponseId: response.id,
                          requestedOrigin: origin,
                          returnedModel: response.model,
                        },
                      ]
                    : [];
                }
                if (responseId === undefined)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: 'Model content arrived before response identity.',
                  });
                if (
                  type === 'response.output_item.added' ||
                  type === 'response.output_item.done'
                ) {
                  const decoded = ItemEventSchema.safeParse(raw);
                  if (!decoded.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'The model returned unsupported output content.',
                      cause: decoded.error,
                    });
                  const { output_index: index, item } = decoded.data;
                  const previous = items.get(index);
                  const identity = itemIdentity(item);
                  if (
                    previous &&
                    !isDeepStrictEqual(previous.identity, identity)
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The model changed an output item identity or completed content.',
                    });
                  if (type === 'response.output_item.done') {
                    const done = yield* normalizeItem(item);
                    if (
                      previous?.done &&
                      !agreesWithCompleted(previous.done, done)
                    )
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'The model changed completed output content.',
                      });
                    items.set(index, {
                      identity,
                      done: previous?.done ?? done,
                    });
                  } else {
                    if (previous)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'The model added the same output position twice.',
                      });
                    items.set(index, { identity });
                  }
                  return [];
                }
                if (
                  [
                    'response.output_text.delta',
                    'response.refusal.delta',
                    'response.reasoning_summary_text.delta',
                    'response.reasoning_text.delta',
                  ].includes(type)
                ) {
                  const decoded = DeltaEventSchema.safeParse(raw);
                  if (!decoded.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'The model returned malformed progress content.',
                      cause: decoded.error,
                    });
                  const item = items.get(decoded.data.output_index);
                  if (
                    !item ||
                    item.done ||
                    item.identity.id !== decoded.data.item_id ||
                    item.identity.type !==
                      (type === 'response.output_text.delta' ||
                      type === 'response.refusal.delta'
                        ? 'message'
                        : 'reasoning')
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Progress does not belong to an open output item.',
                    });
                  let part: 'text' | 'refusal' | 'reasoning' = 'reasoning';
                  if (type === 'response.output_text.delta') part = 'text';
                  if (type === 'response.refusal.delta') part = 'refusal';
                  return [
                    { kind: 'delta' as const, part, text: decoded.data.delta },
                  ];
                }
                // These framing events do not own terminal content; output_item.done does.
                if (
                  [
                    'response.content_part.added',
                    'response.content_part.done',
                    'response.output_text.done',
                    'response.refusal.done',
                    'response.reasoning_summary_part.added',
                    'response.reasoning_summary_part.done',
                    'response.reasoning_summary_text.done',
                    'response.reasoning_text.done',
                    'response.function_call_arguments.delta',
                    'response.function_call_arguments.done',
                  ].includes(type)
                )
                  return [];
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message: `The model returned an unsupported event: ${type}.`,
                });
              }),
            ),
            Stream.takeUntil(() => terminal !== undefined),
            Stream.flattenIterable,
          );
          const completion = Stream.fromEffect(
            Effect.gen(function* () {
              if (!terminal)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'The model stream ended without a terminal response.',
                });
              if (terminal.status === 'failed')
                return yield* new ModelError({
                  kind: 'provider-rejection',
                  message:
                    terminal.error?.message ?? 'The model response failed.',
                  cause: terminal.error,
                });
              const output: TurnResult['content'][number][] = [];
              if (items.size > 0) {
                const ordered = [...items].toSorted(
                  ([left], [right]) => left - right,
                );
                for (const [ordinal, [index]] of ordered.entries()) {
                  if (ordinal !== index)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'The model omitted an output position.',
                    });
                }
                let previousIndex = -1;
                for (const item of terminal.output) {
                  const match = ordered.find(([, candidate]) =>
                    item.id !== undefined
                      ? candidate.identity.id === item.id
                      : candidate.identity.type === 'function_call' &&
                        item.type === 'function_call' &&
                        candidate.identity.callId === item.call_id,
                  );
                  const normalized = yield* normalizeItem(item);
                  if (
                    !match ||
                    match[0] <= previousIndex ||
                    match[1].identity.type !== item.type ||
                    (item.type === 'function_call' &&
                      (match[1].identity.callId !== item.call_id ||
                        match[1].identity.name !== item.name)) ||
                    (match[1].done &&
                      !agreesWithCompleted(match[1].done, normalized))
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The terminal snapshot conflicts with completed output items.',
                    });
                  previousIndex = match[0];
                  match[1].done ??= normalized;
                }
                for (const [, item] of ordered) {
                  if (!item.done)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'The model left an output item unfinished.',
                    });
                  output.push(item.done);
                }
              } else {
                output.push(
                  ...(yield* Effect.forEach(terminal.output, normalizeItem)),
                );
              }
              const result = yield* normalizeResponse(terminal, origin, output);
              const continuation = yield* openaiResponsesContinuation(
                turn,
                result,
              );
              return {
                kind: 'completed' as const,
                result: continuation
                  ? TurnResultSchema.parse({ ...result, continuation })
                  : result,
              };
            }),
          );
          return Stream.concat(progress, completion).pipe(
            Stream.mapError(enrich),
          );
        }).pipe(Effect.mapError(enrich)),
      );
    });
  const generateTurn: Model['generateTurn'] = Effect.fn(
    'llm.responses.generateTurn',
  )(function* (turn) {
    const result = yield* Stream.runFold(
      streamTurn(turn),
      () => null as TurnResult | null,
      (current, event) => (event.kind === 'completed' ? event.result : current),
    );
    if (result === null)
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'The model stream produced no completed result.',
      });
    return result;
  });

  const boundOperation = Effect.fn('llm.responses.boundOperation')(function* (
    input: RemoteOperation,
  ) {
    const parsed = RemoteOperationSchema.safeParse(input);
    if (!parsed.success || !sameModelOrigin(parsed.data.origin, origin))
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'The remote operation belongs to another model binding.',
      });
    return parsed.data;
  });

  const submit: NonNullable<Model['background']>['submit'] = Effect.fn(
    'llm.responses.submit',
  )(function* (input) {
    let operation: RemoteOperation | undefined;
    let returnedModel: string | undefined;
    let requestId: string | undefined;
    const enrich = (error: ModelError) =>
      new ModelError({
        ...error,
        message: error.message,
        cause: error.cause,
        operation,
        responseId: operation?.providerResponseId,
        requestId: error.requestId ?? requestId,
        model: returnedModel ?? config.requestedModel,
      });
    return yield* Effect.scoped(
      Effect.gen(function* (): Effect.fn.Return<
        BackgroundSubmission,
        ModelError,
        Scope.Scope
      > {
        const { turn, opened } = yield* createResponse(input, 'background');
        requestId = opened.request_id ?? undefined;
        const source = opened.data;
        const iterator = yield* Effect.acquireRelease(
          Effect.sync(() => source[Symbol.asyncIterator]()),
          (iterator, exit) =>
            Effect.gen(function* () {
              const close = iterator.return
                ? Effect.tryPromise({
                    try: () => iterator.return!(),
                    catch: (cause) =>
                      enrich(
                        new ModelError({
                          kind: 'transport',
                          message: 'Background submission cleanup failed.',
                          cause,
                        }),
                      ),
                  })
                : Effect.void;
              if (Exit.isSuccess(exit)) {
                // After the single read, no next() is pending. Let the SDK join
                // its body cancellation before aborting the detached request.
                yield* close.pipe(
                  Effect.orDie,
                  Effect.ensuring(Effect.sync(() => source.controller.abort())),
                );
              } else {
                source.controller.abort();
                yield* close.pipe(Effect.orDie);
              }
            }),
        );
        const first = yield* Effect.tryPromise({
          try: () => iterator.next(),
          catch: (cause) =>
            cause instanceof SyntaxError
              ? new ModelError({
                  kind: 'malformed-output',
                  message: 'The model returned malformed stream data.',
                  cause,
                })
              : openaiFailure(cause),
        });
        if (first.done)
          return yield* new ModelError({
            kind: 'malformed-output',
            message: 'Background submission ended without acceptance evidence.',
          });
        const parsed = ResponseEventSchema.safeParse(first.value);
        if (!parsed.success)
          return yield* new ModelError({
            kind: 'malformed-output',
            message: 'Background acceptance is malformed.',
            cause: parsed.error,
          });
        const { response, type, sequence_number } = parsed.data;
        returnedModel = response.model;
        operation = RemoteOperationSchema.parse({
          origin,
          providerResponseId: response.id,
          afterSequence: sequence_number,
        });
        if (
          (type === 'response.completed' && response.status === 'completed') ||
          (type === 'response.incomplete' && response.status === 'incomplete')
        ) {
          const content = yield* Effect.forEach(response.output, normalizeItem);
          const result = yield* normalizeResponse(response, origin, content);
          const continuation = yield* openaiResponsesContinuation(turn, result);
          return BackgroundSubmissionSchema.parse({
            kind: 'completed',
            result: continuation ? { ...result, continuation } : result,
          });
        }
        if (
          ![
            'response.created',
            'response.queued',
            'response.in_progress',
          ].includes(type) ||
          !['queued', 'in_progress'].includes(response.status)
        ) {
          return yield* new ModelError({
            kind:
              response.status === 'failed'
                ? 'provider-rejection'
                : 'malformed-output',
            message:
              response.error?.message ??
              'The provider did not acknowledge background work.',
            cause: response.error,
          });
        }
        return BackgroundSubmissionSchema.parse({
          kind: 'accepted',
          operation,
          returnedModel,
        });
      }).pipe(Effect.mapError(enrich)),
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
          });
        const remaining =
          parsedPolicy.data.deadlineAtMs - (yield* Clock.currentTimeMillis);
        const deadline = new ModelError({
          kind: 'observation-deadline',
          message: 'The original observation deadline has expired.',
          operation,
          responseId: operation.providerResponseId,
        });
        if (remaining <= 0) return yield* deadline;
        let returnedModel: string | undefined;
        let requestId: string | undefined;
        const enrich = (error: ModelError) =>
          new ModelError({
            ...error,
            message: error.message,
            cause: error.cause,
            operation,
            responseId: operation.providerResponseId,
            requestId: error.requestId ?? requestId,
            model: returnedModel ?? config.requestedModel,
          });
        return Stream.unwrap(
          Effect.gen(function* () {
            const signal = yield* Effect.abortSignal;
            const opened = yield* Effect.tryPromise({
              try: () =>
                client.responses
                  .retrieve(
                    operation.providerResponseId,
                    {
                      stream: true,
                      ...(operation.afterSequence !== null
                        ? { starting_after: operation.afterSequence }
                        : {}),
                      include: ['reasoning.encrypted_content'],
                    },
                    { signal },
                  )
                  .withResponse(),
              catch: openaiFailure,
            }).pipe(
              Effect.timeoutOrElse({
                duration: remaining,
                orElse: () => Effect.fail(enrich(deadline)),
              }),
            );
            requestId = opened.request_id ?? undefined;
            const events = yield* sdkEvents(opened.data, enrich);
            const readTimeRemaining = Math.max(
              0,
              parsedPolicy.data.deadlineAtMs - (yield* Clock.currentTimeMillis),
            );
            let sequence = operation.afterSequence ?? -1;
            const completedItems = new Map<
              number,
              TurnResult['content'][number]
            >();
            let terminal:
              | { readonly result: TurnResult; readonly afterSequence: number }
              | undefined;
            const progress = events.pipe(
              Stream.mapEffect((raw) =>
                Effect.gen(function* (): Effect.fn.Return<
                  readonly BackgroundEvent[],
                  ModelError
                > {
                  const header = EventSchema.safeParse(raw);
                  if (
                    !header.success ||
                    header.data.sequence_number <= sequence
                  )
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'Observation emitted invalid or out-of-order events.',
                    });
                  const { type, sequence_number: afterSequence } = header.data;
                  sequence = afterSequence;
                  if (
                    [
                      'response.created',
                      'response.queued',
                      'response.in_progress',
                      'response.completed',
                      'response.incomplete',
                      'response.failed',
                    ].includes(type)
                  ) {
                    const parsed = ResponseEventSchema.safeParse(raw);
                    if (!parsed.success)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'The observed response is malformed.',
                        cause: parsed.error,
                      });
                    const response = parsed.data.response;
                    if (
                      response.id !== operation.providerResponseId ||
                      (returnedModel !== undefined &&
                        returnedModel !== response.model)
                    )
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message:
                          'Observation changed the remote response identity.',
                      });
                    const firstIdentity = returnedModel === undefined;
                    returnedModel = response.model;
                    if (
                      [
                        'response.completed',
                        'response.incomplete',
                        'response.failed',
                      ].includes(type)
                    ) {
                      if (response.status !== type.slice('response.'.length))
                        return yield* new ModelError({
                          kind: 'malformed-output',
                          message:
                            'The observed terminal event and status disagree.',
                        });
                      if (response.status === 'failed')
                        return yield* new ModelError({
                          kind: 'provider-rejection',
                          message:
                            response.error?.message ??
                            'The background response failed.',
                          cause: response.error,
                        });
                      const content = yield* Effect.forEach(
                        response.output,
                        normalizeItem,
                      );
                      for (const [index, completed] of completedItems) {
                        const observed = content[index];
                        if (
                          !observed ||
                          !agreesWithCompleted(completed, observed)
                        )
                          return yield* new ModelError({
                            kind: 'malformed-output',
                            message:
                              'The full observed terminal snapshot omits or contradicts completed output.',
                          });
                        content[index] = completed;
                      }
                      terminal = {
                        result: yield* normalizeResponse(
                          response,
                          origin,
                          content,
                        ),
                        afterSequence,
                      };
                      // The terminal cursor is delivered only with its authoritative result below.
                      return [];
                    }
                    return firstIdentity
                      ? [
                          {
                            kind: 'identified',
                            providerResponseId: response.id,
                            requestedOrigin: origin,
                            returnedModel,
                            afterSequence,
                          },
                        ]
                      : [{ kind: 'cursor', afterSequence }];
                  }
                  if (
                    [
                      'response.output_text.delta',
                      'response.refusal.delta',
                      'response.reasoning_summary_text.delta',
                      'response.reasoning_text.delta',
                    ].includes(type)
                  ) {
                    const parsed = DeltaEventSchema.safeParse(raw);
                    if (!parsed.success)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'Observed progress is malformed.',
                        cause: parsed.error,
                      });
                    let part: 'text' | 'refusal' | 'reasoning' = 'reasoning';
                    if (type === 'response.output_text.delta') part = 'text';
                    if (type === 'response.refusal.delta') part = 'refusal';
                    return [
                      {
                        kind: 'delta',
                        part,
                        text: parsed.data.delta,
                        afterSequence,
                      },
                    ];
                  }
                  if (
                    type === 'response.output_item.added' ||
                    type === 'response.output_item.done'
                  ) {
                    const parsed = ItemEventSchema.safeParse(raw);
                    if (!parsed.success)
                      return yield* new ModelError({
                        kind: 'malformed-output',
                        message: 'Observed output content is unsupported.',
                        cause: parsed.error,
                      });
                    if (type === 'response.output_item.done') {
                      const index = parsed.data.output_index;
                      if (completedItems.has(index))
                        return yield* new ModelError({
                          kind: 'malformed-output',
                          message:
                            'Observation completed the same output position twice.',
                        });
                      completedItems.set(
                        index,
                        yield* normalizeItem(parsed.data.item),
                      );
                    }
                    return [{ kind: 'cursor', afterSequence }];
                  }
                  if (
                    [
                      'response.content_part.added',
                      'response.content_part.done',
                      'response.output_text.done',
                      'response.refusal.done',
                      'response.reasoning_summary_part.added',
                      'response.reasoning_summary_part.done',
                      'response.reasoning_summary_text.done',
                      'response.reasoning_text.done',
                      'response.function_call_arguments.delta',
                      'response.function_call_arguments.done',
                    ].includes(type)
                  )
                    return [{ kind: 'cursor', afterSequence }];
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message: `Unsupported observation event: ${type}.`,
                  });
                }),
              ),
              Stream.takeUntil(() => terminal !== undefined),
              Stream.flattenIterable,
            );
            return Stream.concat(
              progress,
              Stream.fromEffect(
                Effect.gen(function* (): Effect.fn.Return<
                  BackgroundEvent,
                  ModelError
                > {
                  if (!terminal)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message: 'Observation ended without a terminal response.',
                    });
                  return { kind: 'completed', ...terminal };
                }),
              ),
            ).pipe(
              Stream.mapError(enrich),
              Stream.interruptWhen(
                Effect.sleep(readTimeRemaining).pipe(
                  Effect.andThen(() => Effect.fail(enrich(deadline))),
                ),
              ),
            );
          }).pipe(Effect.mapError(enrich)),
        );
      }),
    );

  const cancel: NonNullable<Model['background']>['cancel'] = Effect.fn(
    'llm.responses.cancel',
  )(function* (input) {
    const operation = yield* boundOperation(input);
    return yield* Effect.gen(function* () {
      const opened = yield* Effect.tryPromise({
        try: (signal) =>
          client.responses
            .cancel(operation.providerResponseId, { signal })
            .withResponse(),
        catch: openaiFailure,
      });
      // Cancellation cannot request encrypted output includes. Report status only.
      const parsed = ResponseSchema.pick({
        id: true,
        object: true,
        model: true,
        status: true,
      }).safeParse(opened.data);
      if (!parsed.success || parsed.data.id !== operation.providerResponseId)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Cancellation returned invalid response identity or status.',
          requestId: opened.request_id ?? undefined,
        });
      const {
        status,
        id: providerResponseId,
        model: returnedModel,
      } = parsed.data;
      const identity = {
        providerResponseId,
        requestedOrigin: origin,
        returnedModel,
      };
      if (status === 'cancelled')
        return CancellationEvidenceSchema.parse({
          ...identity,
          kind: 'confirmed-cancelled',
        });
      if (status === 'queued' || status === 'in_progress')
        return CancellationEvidenceSchema.parse({
          ...identity,
          kind: 'unconfirmed',
          status,
        });
      return CancellationEvidenceSchema.parse({
        ...identity,
        kind: 'observed-terminal',
        status,
      });
    }).pipe(
      Effect.mapError(
        (error) =>
          new ModelError({
            ...error,
            message: error.message,
            cause: error.cause,
            operation,
            responseId: operation.providerResponseId,
          }),
      ),
    );
  });

  return Object.freeze({
    prepareTurn,
    streamTurn,
    generateTurn,
    ...(config.background === 'supported'
      ? { background: Object.freeze({ submit, observe, cancel }) }
      : {}),
  });
}
