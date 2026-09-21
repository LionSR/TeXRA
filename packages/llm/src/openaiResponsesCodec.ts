// Node imports
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Effect, Stream } from 'effect';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import {
  TurnResultSchema,
  type ResolvedTurn,
  type TurnEvent,
  type TurnResult,
} from './turn.js';
import {
  ModelError,
  enrichModelError,
  type RemoteOperation,
} from './errors.js';
import { openaiFailure } from './openaiError.js';
import { parseInboundToolArguments, pullStream } from './transport.js';

// The codec is the lowest module of this split: the input lowering, the
// request surface and the entry all name the response origin and the completed
// HTTP result, so they live with the schemas that produce them.
export type ResponseOrigin = RemoteOperation['origin'];
export type HttpTurnResult = Extract<
  TurnResult,
  { providerResponseId: string }
>;

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
export function agreesWithCompleted(
  completed: HttpTurnResult['content'][number],
  candidate: HttpTurnResult['content'][number],
): boolean {
  if (completed.kind === 'message' && candidate.kind === 'message') {
    if (
      completed.evidence?.kind !== 'openai-responses-message' ||
      candidate.evidence?.kind !== 'openai-responses-message'
    )
      return false;
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
    if (
      (completed.evidence !== undefined &&
        completed.evidence.kind !== 'openai-responses-function-call') ||
      (candidate.evidence !== undefined &&
        candidate.evidence.kind !== 'openai-responses-function-call')
    )
      return false;
    return (
      completed.providerCallId === candidate.providerCallId &&
      completed.name === candidate.name &&
      completed.argumentsText === candidate.argumentsText &&
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
export const ResponseSchema = z.object({
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

export const normalizeItem = Effect.fn('llm.responses.normalizeItem')(
  function* (
    item: OutputItem,
  ): Effect.fn.Return<HttpTurnResult['content'][number], ModelError> {
    if (item.status === 'in_progress') {
      return yield* new ModelError({
        kind: 'malformed-output',
        message:
          'Unfinished model items cannot form a completed tool exchange.',
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
        yield* parseInboundToolArguments(item.arguments, 'The model');
        return {
          kind: 'local-call',
          providerCallId: item.call_id,
          name: item.name,
          argumentsText: item.arguments,
          evidence: {
            kind: 'openai-responses-function-call',
            ...(item.id !== undefined ? { itemId: item.id } : {}),
            ...(item.status !== undefined ? { status: item.status } : {}),
          },
        };
      }
    }
  },
);

export const normalizeResponse = Effect.fn('llm.responses.normalizeResponse')(
  function* (
    response: ResponseValue,
    origin: ResponseOrigin,
    content: HttpTurnResult['content'],
  ) {
    let finishReason: HttpTurnResult['finishReason'];
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
      kind: 'http',
      providerResponseId: response.id,
      requestedOrigin: origin,
      returnedModel: response.model,
      modelFingerprint: null,
      content,
      finishReason,
      finishEvidence: {
        kind: 'openai-responses',
        status: response.status,
        incompleteReason: response.incomplete_details?.reason ?? null,
      },
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
    if (!result.success || result.data.providerResponseId === null) {
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'The model returned inconsistent completed content.',
        cause: result.success ? undefined : result.error,
      });
    }
    return result.data;
  },
);

/** Canonical image detail as the Responses vocabulary names it. */
const RESPONSES_IMAGE_DETAIL = {
  low: 'low',
  medium: 'auto',
  high: 'high',
  'ultra-high': 'high',
} as const satisfies Record<
  NonNullable<
    Extract<
      Extract<
        ResolvedTurn['messages'][number],
        { role: 'user' }
      >['content'][number],
      { kind: 'image' }
    >['detail']
  >,
  OpenAI.Responses.ResponseInputImage['detail']
>;

/**
 * The image formats sent to Responses. The pinned `openai` typings name no
 * input-image formats (only image generation's output formats), so this is
 * the conservative raster set; a GIF must also be a single frame. An exact
 * match on the lowercased MIME type also keeps a value carrying data-URL
 * delimiters out of the URL built from it.
 */
const RESPONSES_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

/**
 * How many image frames a GIF holds, by walking its blocks, or `null` when
 * the bytes are not a well-formed GIF. Only the structure is read: the
 * header, the optional colour tables, then extension and image blocks and
 * their data sub-blocks up to the trailer.
 */
function gifFrameCount(bytes: Uint8Array): number | null {
  const header = String.fromCharCode(...bytes.subarray(0, 6));
  if (bytes.length < 13 || (header !== 'GIF87a' && header !== 'GIF89a'))
    return null;
  const tableSize = (flags: number): number =>
    flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0;
  let offset = 13 + tableSize(bytes[10]!);
  const skipSubBlocks = (): boolean => {
    while (offset < bytes.length) {
      const size = bytes[offset]!;
      offset += 1;
      if (size === 0) return true;
      offset += size;
    }
    return false;
  };
  let frames = 0;
  while (offset < bytes.length) {
    const block = bytes[offset]!;
    if (block === 0x3b) return frames;
    if (block === 0x21) {
      offset += 2;
      if (!skipSubBlocks()) return null;
    } else if (block === 0x2c) {
      if (offset + 10 > bytes.length) return null;
      frames += 1;
      offset += 10 + tableSize(bytes[offset + 9]!) + 1;
      if (!skipSubBlocks()) return null;
    } else {
      return null;
    }
  }
  return null;
}

/**
 * One canonical input part as Responses content. Inline bytes travel as a
 * data URL; a document this binding already uploaded travels as its live
 * file id. An image outside the formats Responses takes is refused here,
 * before any request, rather than by the provider.
 */
export const responsesContent = Effect.fn('llm.responses.content')(function* (
  part: Extract<
    ResolvedTurn['messages'][number],
    { role: 'user' }
  >['content'][number],
  documents: DocumentAccess,
): Effect.fn.Return<OpenAI.Responses.ResponseInputContent, ModelError> {
  switch (part.kind) {
    case 'text':
      return { type: 'input_text', text: part.text };
    case 'image': {
      const mimeType = part.mimeType.toLowerCase();
      if (
        !RESPONSES_IMAGE_MIME_TYPES.has(mimeType) ||
        (mimeType === 'image/gif' &&
          gifFrameCount(Buffer.from(part.base64, 'base64')) !== 1)
      )
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'Responses takes PNG, JPEG, WEBP and single-frame GIF images; this image attachment is none of those.',
        });
      return {
        type: 'input_image',
        // No stated detail keeps the provider's own choice rather than
        // forcing high-detail cost; `medium` has no Responses counterpart.
        detail:
          part.detail === undefined
            ? 'auto'
            : RESPONSES_IMAGE_DETAIL[part.detail],
        image_url: `data:${mimeType};base64,${part.base64}`,
      };
    }
    case 'document': {
      if (!documents.accepted)
        return yield* new ModelError({
          kind: 'unsupported',
          message:
            'This Responses route takes no input files, so the document cannot be sent.',
        });
      const fileId = documents.fileIdFor(part.base64);
      if (fileId !== null) return { type: 'input_file', file_id: fileId };
      return {
        type: 'input_file',
        // OpenAI reads the type off the name when the bytes are inline, and
        // the canonical document part carries no name of its own.
        filename: `document.${part.mimeType.split('/').pop() ?? 'bin'}`,
        file_data: `data:${part.mimeType};base64,${part.base64}`,
      };
    }
    case 'audio':
    case 'video':
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'Responses takes text, images and documents, not audio or video.',
      });
  }
});

/**
 * The document access one lowering consults: whether the route takes input
 * files at all, and the live file id this binding already holds for some
 * bytes, read against one clock reading for the whole lowering.
 */
export interface DocumentAccess {
  /** The route takes input files at all. */
  readonly accepted: boolean;
  /** The live file id this binding holds for some bytes, or `null`. */
  readonly fileIdFor: (base64: string) => string | null;
}

export const EventSchema = z.object({
  type: z.string(),
  sequence_number: z.int().nonnegative(),
});
export const ResponseEventSchema = EventSchema.extend({
  response: ResponseSchema,
});
export const ItemEventSchema = EventSchema.extend({
  output_index: z.int().nonnegative(),
  item: OutputItemSchema,
});
export const DeltaEventSchema = EventSchema.extend({
  item_id: z.string().min(1),
  output_index: z.int().nonnegative(),
  delta: z.string(),
  logprobs: z.array(z.never()).optional(),
});

/** One canonical foreground decoder for HTTP and WebSocket response events. */
export function responseEvents(
  chunks: Stream.Stream<unknown, ModelError>,
  origin: ResponseOrigin,
): Stream.Stream<TurnEvent, ModelError> {
  return Stream.suspend(() => {
    let responseId: string | undefined;
    let returnedModel: string | undefined;
    const enrich = (error: ModelError) =>
      enrichModelError(error, {
        responseId,
        model: returnedModel ?? origin.requestedModel,
      });
    const items = new Map<
      number,
      {
        identity: ReturnType<typeof itemIdentity>;
        done?: HttpTurnResult['content'][number];
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
              message: 'The model emitted invalid or out-of-order events.',
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
                message: 'The response snapshot is malformed or unsupported.',
                cause: decoded.error,
              });
            const response = decoded.data.response;
            if (
              (responseId !== undefined && responseId !== response.id) ||
              (returnedModel !== undefined && returnedModel !== response.model)
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
                  message: 'The terminal event and response status disagree.',
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
            if (previous && !isDeepStrictEqual(previous.identity, identity))
              return yield* new ModelError({
                kind: 'malformed-output',
                message:
                  'The model changed an output item identity or completed content.',
              });
            if (type === 'response.output_item.done') {
              const done = yield* normalizeItem(item);
              if (previous?.done && !agreesWithCompleted(previous.done, done))
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
                  message: 'The model added the same output position twice.',
                });
              items.set(index, { identity });
            }
            return item.type === 'function_call'
              ? []
              : [
                  {
                    kind: 'phase',
                    part: item.type === 'reasoning' ? 'reasoning' : 'text',
                    boundary:
                      type === 'response.output_item.added' ? 'start' : 'end',
                    providerItemIndex: index,
                  },
                ];
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
                message: 'Progress does not belong to an open output item.',
              });
            let part: 'text' | 'refusal' | 'reasoning' = 'reasoning';
            if (type === 'response.output_text.delta') part = 'text';
            if (type === 'response.refusal.delta') part = 'refusal';
            return [
              {
                kind: 'delta' as const,
                part,
                text: decoded.data.delta,
                providerItemIndex: decoded.data.output_index,
              },
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
            message: 'The model stream ended without a terminal response.',
          });
        if (terminal.status === 'failed')
          return yield* new ModelError({
            kind: 'provider-rejection',
            message: terminal.error?.message ?? 'The model response failed.',
            cause: terminal.error,
          });
        const output: HttpTurnResult['content'][number][] = [];
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
              (match[1].done && !agreesWithCompleted(match[1].done, normalized))
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
        return { kind: 'completed' as const, result };
      }),
    );
    return Stream.concat(progress, completion).pipe(Stream.mapError(enrich));
  });
}

/** Owns only the foreign iterator lifetime shared by create and retrieve. */
export const sdkEvents = Effect.fn('llm.responses.sdkEvents')(function* (
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
  return pullStream(
    () => iterator.next(),
    (cause) =>
      enrich(
        cause instanceof SyntaxError
          ? new ModelError({
              kind: 'malformed-output',
              message: 'The model returned malformed stream data.',
              cause,
            })
          : openaiFailure(cause),
      ),
  );
});
