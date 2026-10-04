// Third-party imports
import { GoogleGenAI, type Interactions } from '@google/genai';
import { Cause, Clock, Effect, Stream } from 'effect';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  admittedFingerprint,
  canChain,
  prefixFingerprint,
} from './prefixFingerprint.js';
import {
  BackgroundEventSchema,
  BackgroundSubmissionSchema,
  CancellationEvidenceSchema,
  completedTurn,
  ObservationPolicySchema,
  ModelConfigurationSchema,
  ResolvedTurnSchema,
  TurnResultSchema,
  type GoogleInteractionsConfiguration,
  type Model,
  type ResolvedTurn,
  type TurnResult,
} from '../turn.js';
import { assembleTurn } from './assembleTurn.js';
import { decodeTurnRequest } from './turnInput.js';
import { systemUpdateText } from '../message.js';
import { JsonObjectSchema, originOf, sameModelOrigin } from '../protocol.js';
import {
  ModelError,
  RemoteOperationSchema,
  sdkModelError,
  boundOperation,
  cancellationStatus,
  fillModelError,
  type RemoteOperation,
} from '../errors.js';
import {
  ownedAbortSafeRequest,
  parseOutboundToolArguments,
  pullStream,
  readerAbortSignal,
} from './transport.js';
import type { Part, PartEvent } from './parts.js';
import type { ModelOrigin } from '../protocol.js';

export const GOOGLE_PREFIX_DOMAIN = 'texra-google-interactions-prefix-v1';

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
/** Wire statuses that report an interaction still working, not a terminal outcome. */
const IN_FLIGHT_STATUSES: readonly string[] = ['queued', 'in_progress'];
/** Wire statuses of a turn that completed, with or without local calls. */
const COMPLETED_STATUSES: readonly string[] = ['completed', 'requires_action'];
const WireEventSchema = z.discriminatedUnion('event_type', [
  z.object({
    event_type: z.literal('interaction.created'),
    interaction: WireInteractionSchema.omit({ status: true }),
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
    if (message.role === 'system' || message.role === 'user') {
      const content =
        message.role === 'system'
          ? [{ type: 'text' as const, text: systemUpdateText(message.text) }]
          : yield* Effect.forEach(message.content, lowerInputPart);
      // A context update and the user turn beside it are one user turn.
      const previous = steps.at(-1);
      if (previous?.type === 'user_input')
        previous.content = [...(previous.content ?? []), ...content];
      else steps.push({ type: 'user_input', content });
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
            // Omit another model's thoughts, as the Anthropic and Chat codecs do.
            if (!sameModelOrigin(message.origin, origin)) break;
            if (
              part.content !== undefined ||
              (part.evidence !== null &&
                part.evidence.kind !== 'google-interactions-thought-signature')
            ) {
              return yield* new ModelError({
                kind: 'unsupported',
                message: 'Google reasoning needs supported thought evidence.',
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
              arguments: yield* parseOutboundToolArguments(part.argumentsText),
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
  return sdkModelError(
    cause,
    decoded.success ? { status: decoded.data.status } : undefined,
    'The Google transport failed.',
  );
}

/** Google's abort signature: the SDK surfaces cancellation as a bare DOMException. */
const googleAbortMatch = (cause: unknown, signal: AbortSignal): boolean =>
  signal.aborted &&
  cause instanceof DOMException &&
  cause.name === 'AbortError';

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
      prefixFingerprint(GOOGLE_PREFIX_DOMAIN, origin, turn.system, prefix) ||
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
 * The canonical part a step opens, from a stream start or a snapshot. A
 * snapshot hands back the SDK's parse of a call's arguments, with no bytes
 * behind it, so its text is re-encoded from that parse; a streamed call's
 * argument deltas replace it.
 */
const stepPart = Effect.fn('llm.google.stepPart')(function* (
  step: z.infer<typeof WireCompletedStepSchema>,
): Effect.fn.Return<Part, ModelError> {
  switch (step.type) {
    case 'thought':
      return {
        kind: 'reasoning',
        summary: (step.summary ?? []).map(({ text }) => ({
          kind: 'text',
          text,
        })),
        evidence:
          step.signature === undefined
            ? null
            : {
                kind: 'google-interactions-thought-signature',
                signature: step.signature,
              },
      };
    case 'model_output':
      if ((step.content?.length ?? 0) > 1)
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Google returned unsupported assistant content.',
        });
      return {
        kind: 'message',
        content: (step.content ?? []).map(({ text }) => ({
          kind: 'text',
          text,
        })),
      };
    case 'function_call':
      return {
        kind: 'local-call',
        providerCallId: step.id,
        name: step.name,
        argumentsText:
          step.arguments === undefined ? '' : JSON.stringify(step.arguments),
      };
  }
});

/** A reported usage receipt; an absent one leaves the last in place. */
const usageParts = (
  usage: z.infer<typeof WireUsageSchema> | undefined,
): PartEvent[] =>
  usage === undefined
    ? []
    : [
        {
          kind: 'usage',
          usage: {
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
        },
      ];

/** What a completed interaction reports: its identity, usage and finish. */
const interactionEnd = (
  interaction: z.infer<typeof WireInteractionSchema>,
): PartEvent[] => [
  { kind: 'identity', id: interaction.id, model: interaction.model ?? null },
  ...usageParts(interaction.usage),
  {
    kind: 'finish',
    finish: {
      finishReason:
        interaction.status === 'requires_action' ? 'tool-calls' : 'stop',
      // The Interactions resource reports no reason for ending, so the
      // status is the whole of what Google says about the outcome.
      finishEvidence: {
        kind: 'google-interactions',
        status: interaction.status,
        terminalReason: null,
      },
    },
  },
];

/** A step delta as the part it grows: text, summary, signature or arguments. */
function deltaPart(
  index: number,
  delta: Extract<
    z.infer<typeof WireEventSchema>,
    { event_type: 'step.delta' }
  >['delta'],
): PartEvent {
  switch (delta.type) {
    case 'text':
      return { kind: 'append', index, channel: 'text', text: delta.text };
    case 'thought_summary':
      return {
        kind: 'append',
        index,
        channel: 'summary',
        text: delta.content.text,
      };
    case 'arguments_delta':
      return {
        kind: 'append',
        index,
        channel: 'arguments',
        text: delta.arguments,
      };
    case 'thought_signature':
      return {
        kind: 'evidence',
        index,
        evidence: {
          kind: 'google-interactions-thought-signature',
          signature: delta.signature,
        },
      };
  }
}

/** One streamed Interactions event as parts; nothing follows completion. */
function googleWire() {
  let done = false;
  const fail = (
    message: string,
    kind: ModelError['kind'] = 'malformed-output',
  ) => Effect.fail(new ModelError({ kind, message }));
  return (raw: unknown): Effect.Effect<PartEvent[], ModelError> =>
    Effect.gen(function* () {
      const decoded = WireEventSchema.safeParse(raw);
      if (!decoded.success)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Google returned malformed or unsupported stream data.',
          cause: decoded.error,
        });
      const event = decoded.data;
      if (done)
        return yield* fail(
          'Google emitted data after its completed interaction.',
        );
      switch (event.event_type) {
        case 'interaction.created':
        case 'interaction.completed': {
          const interaction = event.interaction;
          // The stream takes content only from complete start/delta/stop cycles.
          if (interaction.steps !== undefined)
            return yield* fail(
              'Google terminal step snapshots are not supported by this streaming codec.',
              'unsupported',
            );
          if (event.event_type === 'interaction.created')
            return [
              {
                kind: 'identity',
                id: interaction.id,
                model: interaction.model ?? null,
              },
              ...usageParts(interaction.usage),
            ];
          done = true;
          if (!COMPLETED_STATUSES.includes(event.interaction.status))
            return yield* fail(
              'Google ended without an authoritative completed turn.',
            );
          return interactionEnd(event.interaction);
        }
        case 'interaction.status_update':
          return [{ kind: 'identity', id: event.interaction_id, model: null }];
        case 'error':
          return yield* new ModelError({
            kind: 'provider-rejection',
            message: 'Google reported a failed interaction.',
            cause: event,
          });
        case 'step.start':
          return [
            {
              kind: 'open',
              index: event.index,
              part: yield* stepPart(event.step),
            },
          ];
        case 'step.stop':
          return [
            ...usageParts(event.usage),
            { kind: 'close', index: event.index },
          ];
        case 'step.delta':
          return [
            ...usageParts(event.metadata?.total_usage),
            deltaPart(event.index, event.delta),
          ];
      }
    });
}

/**
 * Builds only the stored anchor a completed turn leaves for its next round.
 * Foreground completion and background observation share it, so an observed
 * turn chains on `previous_interaction_id` exactly as a streamed one does.
 */
const googleContinuation = Effect.fn('llm.google.continuation')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'google-interactions' }>,
  result: TurnResult,
  origin: ModelOrigin,
) {
  if (!turn.controls.store || result.providerResponseId === null)
    return undefined;
  const prefix: ResolvedTurn['messages'] = [
    ...turn.messages,
    { role: 'assistant', origin, content: result.content },
  ];
  const coveredSteps = yield* lowerMessages(prefix, origin);
  // A turn that left no step of its own covers nothing past the input:
  // the next user input would lower into the covered user_input step.
  if (coveredSteps.at(-1)?.type === 'user_input') return undefined;
  return {
    origin,
    coveredMessages: prefix.length,
    prefixFingerprint: prefixFingerprint(
      GOOGLE_PREFIX_DOMAIN,
      origin,
      turn.system,
      prefix,
    ),
    anchor: {
      interactionId: result.providerResponseId,
      coveredSteps: coveredSteps.length,
    },
  };
});

/** Direct Gemini Interactions protocol; it owns neither history nor local tools. */
export function googleInteractionsModel(
  configuration: GoogleInteractionsConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'google-interactions' || !transport.apiKey) {
    throw new TypeError(
      'Google Interactions requires its configuration and an explicit API key.',
    );
  }
  const origin = originOf(config);
  const client = new GoogleGenAI({
    enterprise: false,
    apiKey: transport.apiKey,
    apiVersion: 'v1beta',
    httpOptions: {
      baseUrl: config.deployment.endpoint,
      fetch: transport.fetch,
    },
  });

  const prepareTurn: Model['prepareTurn'] = Effect.fn('llm.google.prepareTurn')(
    function* (request) {
      const authored = yield* decodeTurnRequest(
        request,
        'The canonical Google input is invalid.',
      );
      if (
        authored.continuation !== undefined &&
        authored.continuation.origin.protocol !== 'google-interactions'
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message: 'Google does not support the supplied protocol controls.',
        });
      }
      const mode = authored.mode ?? 'foreground';
      if (
        mode === 'background' &&
        (config.background !== 'supported' ||
          !(authored.store ?? config.defaults.store))
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
        system: authored.system,
        messages: authored.messages,
        tools: authored.tools ?? [],
        continuation: authored.continuation,
        controls: {
          toolChoice: authored.toolChoice ?? 'auto',
          maxOutputTokens:
            authored.maxOutputTokens ?? config.defaults.maxOutputTokens,
          store: authored.store ?? config.defaults.store,
          thinkingLevel: config.defaults.thinkingLevel,
        },
      });
      yield* invocationInput(turn, origin);
      return turn;
    },
  );

  const streamTurn: Model['streamTurn'] = (turn) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (
          turn.protocol !== 'google-interactions' ||
          turn.mode !== 'foreground'
        ) {
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'The prepared Google invocation is unsupported.',
          });
        }
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
        return assembleTurn(
          pullStream(() => body.read(), sdkFailure).pipe(
            Stream.mapEffect(googleWire()),
          ),
          {
            origin,
            provider: 'Google',
            finalize: (result) => withContinuation(turn, result),
          },
        );
      }).pipe(
        Effect.mapError((error) =>
          fillModelError(error, { model: config.requestedModel }),
        ),
      ),
    );
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
      const parts = yield* Effect.forEach(steps.data, (step, index) =>
        Effect.map(stepPart(step), (part): PartEvent[] => [
          { kind: 'open', index, part },
          { kind: 'close', index },
        ]),
      );
      // The identity leads, so a failing step names the returned model.
      const [identity, ...end] = interactionEnd(interaction);
      const batch = [identity, ...parts.flat(), ...end];
      return yield* completedTurn(
        assembleTurn(Stream.make(batch), { origin, provider: 'Google' }),
      );
    },
  );
  /** A completed turn with the anchor its next round chains on, if any. */
  const withContinuation = (
    turn: Extract<ResolvedTurn, { protocol: 'google-interactions' }>,
    result: TurnResult,
  ) =>
    googleContinuation(turn, result, origin).pipe(
      Effect.map((continuation) =>
        continuation
          ? TurnResultSchema.parse({ ...result, continuation })
          : result,
      ),
    );
  const withOperation = (
    operation: RemoteOperation,
    error: ModelError,
    returnedModel?: string,
  ) =>
    fillModelError(error, {
      operation,
      responseId: operation.providerResponseId,
      model: returnedModel ?? config.requestedModel,
    });
  const submit: NonNullable<Model['background']>['submit'] = Effect.fn(
    'llm.google.submit',
  )(function* (turn) {
    let operation: RemoteOperation | undefined;
    return yield* Effect.gen(function* () {
      if (
        turn.protocol !== 'google-interactions' ||
        turn.mode !== 'background' ||
        config.background !== 'supported' ||
        !turn.controls.store
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Google background execution requires an enabled route and store:true.',
        });
      }
      const inputSteps = yield* invocationInput(turn, origin);
      const raw = yield* ownedAbortSafeRequest(
        (signal) =>
          client.interactions.create(
            {
              ...createInput(turn, inputSteps),
              background: true,
              stream: false,
            },
            { maxRetries: 0, fetchOptions: { signal } },
          ),
        sdkFailure,
        { isAbortMatch: googleAbortMatch },
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
        admittedFingerprint: admittedFingerprint(GOOGLE_PREFIX_DOMAIN, turn),
        store: turn.controls.store,
      });
      const interaction = yield* snapshot(raw, operation);
      if (IN_FLIGHT_STATUSES.includes(interaction.status)) {
        return BackgroundSubmissionSchema.parse({
          kind: 'accepted',
          operation,
          returnedModel: interaction.model ?? null,
        });
      }
      return BackgroundSubmissionSchema.parse({
        kind: 'completed',
        result: yield* withContinuation(
          turn,
          yield* completedSnapshot(interaction),
        ),
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
    turn,
    input,
    policy,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const operation = yield* boundOperation(input, origin);
        if (
          turn.protocol !== 'google-interactions' ||
          turn.mode !== 'background' ||
          !sameModelOrigin(turn, operation.origin)
        ) {
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'The admitted turn belongs to another model binding.',
            operation,
          });
        }
        const chain = yield* canChain(GOOGLE_PREFIX_DOMAIN, turn, operation);
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
            const raw = yield* ownedAbortSafeRequest(
              (signal) =>
                client.interactions.get(
                  operation.providerResponseId,
                  { stream: false, include_input: false },
                  { maxRetries: 0, fetchOptions: { signal } },
                ),
              (cause) =>
                withOperation(operation, sdkFailure(cause), returnedModel),
              {
                isAbortMatch: googleAbortMatch,
                deadline: { duration: remaining, error: deadline },
              },
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
            if (!IN_FLIGHT_STATUSES.includes(interaction.status)) {
              const result = yield* completedSnapshot({
                ...interaction,
                model: returnedModel,
              });
              return BackgroundEventSchema.parse({
                kind: 'completed',
                afterSequence: null,
                result: chain ? yield* withContinuation(turn, result) : result,
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
    const operation = yield* boundOperation(input, origin);
    return yield* Effect.gen(function* () {
      const raw = yield* ownedAbortSafeRequest(
        (signal) =>
          client.interactions.cancel(operation.providerResponseId, undefined, {
            maxRetries: 0,
            fetchOptions: { signal },
          }),
        (cause) => withOperation(operation, sdkFailure(cause)),
        { isAbortMatch: googleAbortMatch },
      );
      const interaction = yield* snapshot(raw, operation);
      const evidence = CancellationEvidenceSchema.safeParse({
        providerResponseId: operation.providerResponseId,
        requestedOrigin: origin,
        returnedModel: interaction.model ?? null,
        ...cancellationStatus(interaction.status),
      });
      if (evidence.success) return evidence.data;
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
  return Object.freeze({
    prepareTurn,
    streamTurn,
    ...(config.background === 'supported'
      ? { background: Object.freeze({ submit, observe, cancel }) }
      : {}),
  });
}
