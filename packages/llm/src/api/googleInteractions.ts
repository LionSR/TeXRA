// Third-party imports
import { GoogleGenAI, type Interactions } from '@google/genai';
import { Clock, Effect, Result, Schema, Stream } from 'effect';

// Local imports - canonical model contract
import { prefixFingerprint } from './prefixFingerprint.js';
import {
  BackgroundEventSchema,
  BackgroundSubmissionSchema,
  completedTurn,
  decodeModelConfiguration,
  ResolvedTurnSchema,
  TurnResultSchema,
  type BackgroundEvent,
  type BackgroundSubmission,
  type GoogleInteractionsConfiguration,
  type Model,
  type ObservationPolicySchema,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from '../turn.js';
import { assembleTurn } from './assembleTurn.js';
import { decodeTurnRequest } from './turnInput.js';
import {
  COMPLETED_STATUSES,
  IN_FLIGHT_STATUSES,
  WireInteractionSchema,
  googleWire,
  snapshotParts,
} from './googleInteractionsWire.js';
import { systemUpdateText } from '../message.js';
import { originOf, sameModelOrigin } from '../protocol.js';
import {
  ModelError,
  RemoteOperationSchema,
  sdkModelError,
  boundOperation,
  confirmCancelled,
  fillModelError,
  type RemoteOperation,
} from '../errors.js';
import {
  admitObservation,
  ownedAbortSafeRequest,
  parseOutboundToolArguments,
  pullStream,
  readerAbortSignal,
} from './transport.js';
import type { InputPart } from './parts.js';
import type { ModelOrigin } from '../protocol.js';

const GOOGLE_PREFIX_DOMAIN = 'texra-google-interactions-prefix-v1';

const lowerInputPart = Effect.fn('llm.google.lowerInputPart')(function* (
  part: InputPart,
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

type LocalCall = Extract<TurnResult['content'][number], { kind: 'local-call' }>;
type ToolResult = Extract<
  ResolvedTurn['messages'][number],
  { role: 'tool' }
>['results'][number];

/**
 * One tool result as its function_result step. A function result takes text
 * and images alone; a document, audio or video the tool attached is returned
 * apart, named by its call, for the user turn that follows the results.
 */
const functionResult = Effect.fn('llm.google.functionResult')(function* (
  result: ToolResult,
  call: LocalCall,
) {
  const content: Array<Interactions.TextContent | Interactions.ImageContent> =
    [];
  const carried: Interactions.Content[] = [];
  for (const input of result.content) {
    const part = yield* lowerInputPart(input);
    if (part.type === 'text' || part.type === 'image') content.push(part);
    else carried.push({ type: 'text', text: `From ${call.name}:` }, part);
  }
  const step: Interactions.Step = {
    type: 'function_result',
    call_id: call.providerCallId,
    name: call.name,
    ...(result.status === 'error' ? { is_error: true } : {}),
    result: content,
  };
  return { step, carried };
});

/**
 * One assistant part as the steps that replay it. Another model's thoughts
 * are omitted (`ownThoughts` false), as the Anthropic and Chat codecs do;
 * each local call joins `calls`, the calls of this assistant turn, whose IDs
 * must be distinct.
 */
const modelSteps = Effect.fn('llm.google.modelSteps')(function* (
  part: TurnResult['content'][number],
  ownThoughts: boolean,
  calls: LocalCall[],
): Effect.fn.Return<Interactions.Step[], ModelError> {
  switch (part.kind) {
    case 'message':
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
      return [
        {
          type: 'model_output',
          content: part.content.map(({ text }) => ({ type: 'text', text })),
        },
      ];
    case 'reasoning':
      if (!ownThoughts) return [];
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
      return [
        {
          type: 'thought',
          summary: part.summary.map(({ text }) => ({ type: 'text', text })),
          ...(part.evidence ? { signature: part.evidence.signature } : {}),
        },
      ];
    case 'local-call':
      if (
        calls.some((call) => call.providerCallId === part.providerCallId) ||
        part.evidence !== undefined
      ) {
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Google calls require distinct original IDs without foreign item evidence.',
        });
      }
      calls.push(part);
      return [
        {
          type: 'function_call',
          id: part.providerCallId,
          name: part.name,
          arguments: yield* parseOutboundToolArguments(part.argumentsText),
        },
      ];
    default:
      return yield* new ModelError({
        kind: 'unsupported',
        message: 'Google Interactions cannot encode this canonical content.',
      });
  }
});

const lowerMessages = Effect.fn('llm.google.lowerMessages')(function* (
  messages: ResolvedTurn['messages'],
  origin: ModelOrigin,
) {
  const steps: Interactions.Step[] = [];
  let calls: LocalCall[] = [];
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
      const carried: Interactions.Content[] = [];
      for (const result of message.results) {
        // The canonical grammar guarantees adjacent, complete ordinals.
        const lowered = yield* functionResult(
          result,
          calls[result.callOrdinal],
        );
        steps.push(lowered.step);
        carried.push(...lowered.carried);
      }
      if (carried.length > 0)
        steps.push({ type: 'user_input', content: carried });
      calls = [];
    } else {
      calls = [];
      const ownThoughts = sameModelOrigin(message.origin, origin);
      for (const part of message.content)
        steps.push(...(yield* modelSteps(part, ownThoughts, calls)));
    }
  }
  return steps;
});

const HttpFailureSchema = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
});

function sdkFailure(cause: unknown): ModelError {
  // The pinned Interactions SDK does not export its HTTP error constructors.
  const decoded = Schema.decodeUnknownResult(HttpFailureSchema)(cause);
  return sdkModelError(
    cause,
    Result.isSuccess(decoded) ? { status: decoded.success.status } : undefined,
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

type GoogleTurn = Extract<ResolvedTurn, { protocol: 'google-interactions' }>;
type BackgroundTurn = Extract<ResolvedTurn, { mode: 'background' }>;

/** One bound Interactions deployment: its decoded route, origin and client. */
interface GoogleBinding {
  readonly config: GoogleInteractionsConfiguration;
  readonly origin: ModelOrigin;
  readonly client: GoogleGenAI;
}

/**
 * The completed turn with the stored anchor its next round chains on, if
 * any; foreground completion and background observation share it.
 */
const withContinuation = Effect.fn('llm.google.continuation')(function* (
  turn: GoogleTurn,
  result: TurnResult,
  origin: ModelOrigin,
): Effect.fn.Return<TurnResult, ModelError> {
  if (!turn.controls.store || result.providerResponseId === null) return result;
  const prefix: ResolvedTurn['messages'] = [
    ...turn.messages,
    { role: 'assistant', origin, content: result.content },
  ];
  const coveredSteps = yield* lowerMessages(prefix, origin);
  // With no output step, the next input joins the last user_input step.
  if (coveredSteps.at(-1)?.type === 'user_input') return result;
  return Schema.decodeUnknownSync(TurnResultSchema)({
    ...result,
    continuation: {
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
    },
  });
});

/** A background failure named by its operation and the model it ran on. */
const withOperation = (
  binding: GoogleBinding,
  operation: RemoteOperation,
  error: ModelError,
  returnedModel?: string,
) =>
  fillModelError(error, {
    operation,
    responseId: operation.providerResponseId,
    model: returnedModel ?? binding.config.requestedModel,
  });

const snapshot = Effect.fn('llm.google.snapshot')(function* (
  raw: unknown,
  operation: RemoteOperation,
) {
  const parsed = Schema.decodeUnknownResult(WireInteractionSchema)(raw);
  if (
    !Result.isSuccess(parsed) ||
    parsed.success.id !== operation.providerResponseId
  ) {
    return yield* new ModelError({
      kind: 'malformed-output',
      message:
        'Google returned a malformed or mismatched interaction snapshot.',
      cause: Result.isSuccess(parsed) ? undefined : parsed.failure,
    });
  }
  return parsed.success;
});

const completedSnapshot = Effect.fn('llm.google.completedSnapshot')(function* (
  interaction: typeof WireInteractionSchema.Type,
  origin: ModelOrigin,
) {
  if (!COMPLETED_STATUSES.includes(interaction.status)) {
    return yield* new ModelError({
      kind: ['failed', 'cancelled', 'incomplete', 'budget_exceeded'].includes(
        interaction.status,
      )
        ? 'provider-rejection'
        : 'malformed-output',
      message: `Google background interaction ended with status ${interaction.status}.`,
    });
  }
  const batch = yield* snapshotParts(interaction);
  return yield* completedTurn(
    assembleTurn(Stream.make(batch), { origin, provider: 'Google' }),
  );
});

const streamInteraction = (
  { config, origin, client }: GoogleBinding,
  turn: Extract<ResolvedTurn, { mode: 'foreground' }>,
): Stream.Stream<TurnEvent, ModelError> =>
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
      let reader: ReadableStreamDefaultReader<unknown> | undefined = undefined;
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
          Stream.mapEffect(googleWire(turn.controls.store)),
        ),
        {
          origin,
          provider: 'Google',
          allowMissingResponseId: !turn.controls.store,
          finalize: (result) => withContinuation(turn, result, origin),
        },
      );
    }).pipe(
      Effect.mapError((error) =>
        fillModelError(error, { model: config.requestedModel }),
      ),
    ),
  );

const submitInteraction = Effect.fn('llm.google.submit')(function* (
  binding: GoogleBinding,
  turn: BackgroundTurn,
): Effect.fn.Return<BackgroundSubmission, ModelError> {
  const { config, origin, client } = binding;
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
    const identity = Schema.decodeUnknownResult(
      Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1)) }),
    )(raw);
    if (!Result.isSuccess(identity))
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Google returned no background interaction identifier.',
        cause: identity.failure,
      });
    operation = Schema.decodeUnknownSync(RemoteOperationSchema)({
      origin,
      providerResponseId: identity.success.id,
      afterSequence: null,
    });
    const interaction = yield* snapshot(raw, operation);
    if (IN_FLIGHT_STATUSES.includes(interaction.status)) {
      return Schema.decodeUnknownSync(BackgroundSubmissionSchema)({
        kind: 'accepted',
        operation,
        returnedModel: interaction.model ?? null,
      });
    }
    return Schema.decodeUnknownSync(BackgroundSubmissionSchema)({
      kind: 'completed',
      result: yield* withContinuation(
        turn,
        yield* completedSnapshot(interaction, origin),
        origin,
      ),
    });
  }).pipe(
    Effect.mapError((error) =>
      operation === undefined
        ? error
        : withOperation(binding, operation, error),
    ),
  );
});

const observeInteraction = (
  binding: GoogleBinding,
  admitted: BackgroundTurn,
  input: RemoteOperation,
  policy: typeof ObservationPolicySchema.Type,
): Stream.Stream<BackgroundEvent, ModelError> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { origin, client } = binding;
      const { turn, operation, deadlineAtMs, deadline } =
        yield* admitObservation(
          'google-interactions',
          origin,
          admitted,
          input,
          policy,
        );
      let returnedModel: string | undefined;
      const completion = Effect.gen(function* () {
        while (true) {
          // Consumer delay and prior polls consume the original deadline.
          const remaining = deadlineAtMs - (yield* Clock.currentTimeMillis);
          if (remaining <= 0) return yield* deadline;
          const raw = yield* ownedAbortSafeRequest(
            (signal) =>
              client.interactions.get(
                operation.providerResponseId,
                { stream: false, include_input: false },
                { maxRetries: 0, fetchOptions: { signal } },
              ),
            (cause) =>
              withOperation(
                binding,
                operation,
                sdkFailure(cause),
                returnedModel,
              ),
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
            const result = yield* completedSnapshot(
              { ...interaction, model: returnedModel },
              origin,
            );
            return Schema.decodeUnknownSync(BackgroundEventSchema)({
              kind: 'completed',
              afterSequence: null,
              result: yield* withContinuation(turn, result, origin),
            });
          }
          yield* Effect.sleep(
            Math.min(
              5_000,
              Math.max(0, deadlineAtMs - (yield* Clock.currentTimeMillis)),
            ),
          );
        }
      }).pipe(
        Effect.mapError((error) =>
          withOperation(binding, operation, error, returnedModel),
        ),
      );
      return Stream.concat(
        Stream.succeed(
          Schema.decodeUnknownSync(BackgroundEventSchema)({
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

const cancelInteraction = Effect.fn('llm.google.cancel')(function* (
  binding: GoogleBinding,
  input: RemoteOperation,
) {
  const operation = yield* boundOperation(input, binding.origin);
  return yield* Effect.gen(function* () {
    const raw = yield* ownedAbortSafeRequest(
      (signal) =>
        binding.client.interactions.cancel(
          operation.providerResponseId,
          undefined,
          { maxRetries: 0, fetchOptions: { signal } },
        ),
      (cause) => withOperation(binding, operation, sdkFailure(cause)),
      { isAbortMatch: googleAbortMatch },
    );
    const interaction = yield* snapshot(raw, operation);
    return yield* confirmCancelled(operation, interaction.status);
  }).pipe(Effect.mapError((error) => withOperation(binding, operation, error)));
});

/** Direct Gemini Interactions protocol; it owns neither history nor local tools. */
export function googleInteractionsModel(
  configuration: GoogleInteractionsConfiguration,
  transport: { readonly apiKey: string; readonly fetch?: typeof fetch },
): Model {
  const config = decodeModelConfiguration(configuration);
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
  const binding: GoogleBinding = { config, origin, client };

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
      const turn = Schema.decodeUnknownSync(ResolvedTurnSchema)({
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
    streamInteraction(binding, turn);
  const background: NonNullable<Model['background']> = {
    submit: (turn) => submitInteraction(binding, turn),
    observe: (turn, operation, policy) =>
      observeInteraction(binding, turn, operation, policy),
    cancel: (operation) => cancelInteraction(binding, operation),
  };
  return Object.freeze({
    prepareTurn,
    streamTurn,
    ...(config.background === 'supported'
      ? { background: Object.freeze(background) }
      : {}),
  });
}
