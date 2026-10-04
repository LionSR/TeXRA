// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { Effect, Stream } from 'effect';
import OpenAI from 'openai';
import { z } from 'zod';

// Local imports - canonical model contract
import { ModelError, type RemoteOperation } from '../errors.js';
import { openaiFailure } from './openaiError.js';
import { parseInboundToolArguments, sdkStream } from './transport.js';
import {
  ResponsesUsageSchema,
  responsesUsage,
} from './openaiResponsesUsage.js';
import { assembleTurn, type AssemblyOptions } from './assembleTurn.js';
import type { ResolvedTurn, TurnEvent } from '../turn.js';
import type { HttpTurnResult, Part, PartEvent } from './parts.js';

type Append = Extract<PartEvent, { kind: 'append' }>;

// The codec is the lowest module of this split: the input lowering, the
// request surface and the entry all name the response origin, so it lives
// with the schemas that produce it.
export type ResponseOrigin = RemoteOperation['origin'];

const ItemStatusSchema = z.enum(['in_progress', 'completed', 'incomplete']);
const ReasoningTextSchema = z.strictObject({
  type: z.literal('reasoning_text'),
  text: z.string(),
});
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
          // Unsupported annotations/log probabilities cannot disappear in
          // conversion; Zhipu omits the empty annotation list.
          annotations: z.array(z.never()).optional(),
          logprobs: z.array(z.never()).nullish(),
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
    // Zhipu reports no summary and one reasoning-text object, not a list.
    summary: z
      .array(
        z.strictObject({ type: z.literal('summary_text'), text: z.string() }),
      )
      .default([]),
    content: z
      .union([
        z.array(ReasoningTextSchema),
        ReasoningTextSchema.transform((part) => [part]),
      ])
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
  usage: ResponsesUsageSchema.nullish(),
  error: z.object({ code: z.string(), message: z.string() }).nullish(),
  incomplete_details: z
    .object({ reason: z.enum(['max_output_tokens', 'content_filter']) })
    .nullish(),
});
type ResponseValue = z.infer<typeof ResponseSchema>;

/**
 * An item in canonical shape. An item still in progress opens a part whose
 * identity is final and whose content is not; it is never a result.
 */
const itemPart = (item: OutputItem): Part => {
  const status = item.status === 'in_progress' ? 'incomplete' : item.status;
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
          status: status ?? 'completed',
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
          ...(status !== undefined ? { status } : {}),
          ...(item.encrypted_content !== undefined
            ? { encryptedContent: item.encrypted_content }
            : {}),
        },
      };
    case 'function_call':
      return {
        kind: 'local-call',
        providerCallId: item.call_id,
        name: item.name,
        argumentsText: item.arguments,
        evidence: {
          kind: 'openai-responses-function-call',
          ...(item.id !== undefined ? { itemId: item.id } : {}),
          ...(item.status === 'completed' ? { status: item.status } : {}),
        },
      };
  }
};

/** A completed item; an unfinished one, or a call without JSON arguments, fails. */
const normalizeItem = Effect.fn('llm.responses.normalizeItem')(function* (
  item: OutputItem,
): Effect.fn.Return<Part, ModelError> {
  if (item.status === 'in_progress')
    return yield* new ModelError({
      kind: 'malformed-output',
      message: 'Unfinished model items cannot form a completed tool exchange.',
    });
  if (item.type === 'function_call') {
    if (item.status === 'incomplete')
      return yield* new ModelError({
        kind: 'malformed-output',
        message: 'Incomplete local calls are not dispatchable.',
      });
    yield* parseInboundToolArguments(item.arguments, 'The model');
  }
  return itemPart(item);
});

/**
 * A terminal snapshot as parts: its identity, usage and finish, with its
 * items as the provider's terminal statement of the content.
 */
export const terminalParts = Effect.fn('llm.responses.terminalParts')(
  function* (response: ResponseValue) {
    const incomplete = response.incomplete_details?.reason;
    const rejected = () =>
      new ModelError({
        kind: 'provider-rejection',
        message:
          response.error?.message ??
          `The model response ended with status ${response.status}.`,
        cause: response.error,
      });
    if (
      response.status !== 'completed' &&
      (response.status !== 'incomplete' || incomplete == null)
    )
      return yield* rejected();
    const snapshot = yield* Effect.forEach(response.output, normalizeItem);
    const calls = snapshot.some((item) => item.kind === 'local-call');
    // An incomplete response cannot leave a dispatchable call.
    if (response.status === 'incomplete' && calls) return yield* rejected();
    let finishReason: HttpTurnResult['finishReason'] = calls
      ? 'tool-calls'
      : 'stop';
    if (response.status === 'incomplete')
      finishReason =
        incomplete === 'max_output_tokens' ? 'length' : 'content-filter';
    return [
      { kind: 'identity', id: response.id, model: response.model },
      {
        kind: 'usage',
        usage: response.usage ? responsesUsage(response.usage) : null,
      },
      {
        kind: 'finish',
        finish: {
          finishReason,
          finishEvidence: {
            kind: 'openai-responses',
            status: response.status,
            incompleteReason: incomplete ?? null,
          },
        },
        snapshot,
      },
    ] satisfies PartEvent[];
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

const EventSchema = z.object({
  type: z.string(),
  sequence_number: z.int().nonnegative(),
});
export const ResponseEventSchema = EventSchema.extend({
  response: ResponseSchema,
});
const ItemEventSchema = EventSchema.extend({
  output_index: z.int().nonnegative(),
  item: OutputItemSchema,
});
const DeltaEventSchema = EventSchema.extend({
  item_id: z.string().min(1),
  output_index: z.int().nonnegative(),
  delta: z.string(),
  logprobs: z.array(z.never()).nullish(),
});

const SNAPSHOT_EVENTS = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  'response.completed',
  'response.incomplete',
  'response.failed',
]);
const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);
const DELTA_CHANNELS = new Map<string, Append['channel']>([
  ['response.output_text.delta', 'text'],
  ['response.refusal.delta', 'refusal'],
  ['response.reasoning_summary_text.delta', 'summary'],
  ['response.reasoning_text.delta', 'reasoning'],
]);
// Framing that owns no content: output_item.done carries the item.
const FRAMING_EVENTS = new Set([
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
]);

/** One decoded Responses event: its sequence, its parts, whether it settles. */
export interface ResponseEventParts {
  readonly sequence: number;
  readonly parts: readonly PartEvent[];
  readonly terminal: boolean;
}

const malformed = (message: string, cause?: unknown) =>
  new ModelError({ kind: 'malformed-output', message, cause });
const decoded = <T>(result: z.ZodSafeParseResult<T>, message: string) =>
  result.success
    ? Effect.succeed(result.data)
    : Effect.fail(malformed(message, result.error));

/**
 * The one Responses event decoder, for HTTP and WebSocket streams and for
 * observation: each event after `after`, in order, as parts.
 */
export function responsesWire(after: number) {
  let sequence = after;
  return (raw: unknown): Effect.Effect<ResponseEventParts, ModelError> =>
    Effect.gen(function* () {
      const header = EventSchema.safeParse(raw);
      if (!header.success || header.data.sequence_number <= sequence)
        return yield* malformed(
          'The model emitted invalid or out-of-order events.',
        );
      sequence = header.data.sequence_number;
      const type = header.data.type;
      const at = (parts: readonly PartEvent[], terminal = false) => ({
        sequence,
        parts,
        terminal,
      });
      if (SNAPSHOT_EVENTS.has(type)) {
        const { response } = yield* decoded(
          ResponseEventSchema.safeParse(raw),
          'The response snapshot is malformed or unsupported.',
        );
        if (!TERMINAL_EVENTS.has(type))
          return at([
            { kind: 'identity', id: response.id, model: response.model },
          ]);
        if (response.status !== type.slice('response.'.length))
          return yield* malformed(
            'The terminal event and response status disagree.',
          );
        return at(yield* terminalParts(response), true);
      }
      if (
        type === 'response.output_item.added' ||
        type === 'response.output_item.done'
      ) {
        const { output_index: index, item } = yield* decoded(
          ItemEventSchema.safeParse(raw),
          'The model returned unsupported output content.',
        );
        return at([
          type === 'response.output_item.added'
            ? { kind: 'open', index, part: itemPart(item) }
            : { kind: 'close', index, content: yield* normalizeItem(item) },
        ]);
      }
      const channel = DELTA_CHANNELS.get(type);
      if (channel !== undefined) {
        const delta = yield* decoded(
          DeltaEventSchema.safeParse(raw),
          'The model returned malformed progress content.',
        );
        return at([
          {
            kind: 'append',
            index: delta.output_index,
            channel,
            text: delta.delta,
            item: delta.item_id,
          },
        ]);
      }
      if (FRAMING_EVENTS.has(type)) return at([]);
      return yield* malformed(
        `The model returned an unsupported event: ${type}.`,
      );
    });
}

/** A foreground Responses stream, HTTP or WebSocket, as turn events. */
export const responseEvents = (
  chunks: Stream.Stream<unknown, ModelError>,
  origin: ResponseOrigin,
  finalize?: AssemblyOptions['finalize'],
): Stream.Stream<TurnEvent, ModelError> =>
  Stream.suspend(() =>
    assembleTurn(
      chunks.pipe(
        Stream.mapEffect(responsesWire(-1)),
        // The terminal snapshot settles the response; HTTP EOF is not a condition.
        Stream.takeUntil((event) => event.terminal),
        Stream.map((event) => event.parts),
      ),
      { origin, provider: 'The model', finalize },
    ),
  );

/** The Responses SDK's event stream: its failures classified the way both create and retrieve report them. */
export const sdkEvents = (
  source: AsyncIterable<unknown> & { readonly controller: AbortController },
  enrich: (error: ModelError) => ModelError,
) =>
  sdkStream(
    source,
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
    (cause) =>
      enrich(
        new ModelError({
          kind: 'transport',
          message: 'The model stream cleanup failed.',
          cause,
        }),
      ),
  );
