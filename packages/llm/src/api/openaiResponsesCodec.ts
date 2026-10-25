// Node imports
import { Buffer } from 'node:buffer';

// Third-party imports
import { Effect, Result, Schema, SchemaGetter, Stream, Struct } from 'effect';
import OpenAI from 'openai';

// Local imports - canonical model contract
import { ModelError, fillModelError, type RemoteOperation } from '../errors.js';
import { openaiFailure } from './openaiError.js';
import { parseInboundToolArguments, sdkStream } from './transport.js';
import {
  ResponsesUsageSchema,
  responsesUsage,
} from './openaiResponsesUsage.js';
import { assembleTurn, type AssemblyOptions } from './assembleTurn.js';
import type { TurnEvent } from '../turn.js';
import type { HttpTurnResult, InputPart, Part, PartEvent } from './parts.js';

type Append = Extract<PartEvent, { kind: 'append' }>;

// The codec is the lowest module of this split: the input lowering, the
// request surface and the entry all name the response origin, so it lives
// with the schemas that produce it.
export type ResponseOrigin = RemoteOperation['origin'];

const ItemStatusSchema = Schema.Literals([
  'in_progress',
  'completed',
  'incomplete',
]);
const ReasoningTextSchema = Schema.Struct({
  type: Schema.Literal('reasoning_text'),
  text: Schema.String,
});
const OutputItemSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('message'),
    id: Schema.String.check(Schema.isMinLength(1)),
    role: Schema.Literal('assistant'),
    status: ItemStatusSchema,
    phase: Schema.optional(
      Schema.NullOr(Schema.Literals(['commentary', 'final_answer'])),
    ),
    content: Schema.Array(
      Schema.Union([
        Schema.Struct({
          type: Schema.Literal('output_text'),
          text: Schema.String,
          // Unsupported annotations/log probabilities cannot disappear in
          // conversion; Zhipu omits the empty annotation list.
          annotations: Schema.optional(Schema.Array(Schema.Never)),
          logprobs: Schema.optional(Schema.NullOr(Schema.Array(Schema.Never))),
        }),
        Schema.Struct({
          type: Schema.Literal('refusal'),
          refusal: Schema.String,
        }),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('reasoning'),
    id: Schema.String.check(Schema.isMinLength(1)),
    status: Schema.optional(ItemStatusSchema),
    encrypted_content: Schema.optional(Schema.NullOr(Schema.String)),
    // Zhipu reports no summary and one reasoning-text object, not a list.
    summary: Schema.Array(
      Schema.Struct({
        type: Schema.Literal('summary_text'),
        text: Schema.String,
      }),
    ).pipe(Schema.withDecodingDefaultType(Effect.succeed([]))),
    content: Schema.optional(
      Schema.Union([
        Schema.Array(ReasoningTextSchema),
        ReasoningTextSchema.pipe(
          Schema.decodeTo(Schema.Array(ReasoningTextSchema), {
            decode: SchemaGetter.transform((part) => [part]),
            encode: SchemaGetter.forbidden(() => 'decode-only'),
          }),
        ),
      ]),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal('function_call'),
    id: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    status: Schema.optional(ItemStatusSchema),
    call_id: Schema.String.check(Schema.isMinLength(1)),
    name: Schema.String.check(Schema.isMinLength(1)),
    arguments: Schema.String,
  }),
]);
type OutputItem = typeof OutputItemSchema.Type;

export const ResponseSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  object: Schema.Literal('response'),
  model: Schema.String.check(Schema.isMinLength(1)),
  status: Schema.Literals([
    'queued',
    'in_progress',
    'completed',
    'failed',
    'cancelled',
    'incomplete',
  ]),
  output: Schema.Array(OutputItemSchema),
  usage: Schema.optional(Schema.NullOr(ResponsesUsageSchema)),
  error: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ code: Schema.String, message: Schema.String }),
    ),
  ),
  incomplete_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reason: Schema.Literals(['max_output_tokens', 'content_filter']),
      }),
    ),
  ),
});
type ResponseValue = typeof ResponseSchema.Type;

const malformed = (message: string, cause?: unknown) =>
  new ModelError({ kind: 'malformed-output', message, cause });
const decoded = <T>(
  result: Result.Result<T, Schema.SchemaError>,
  message: string,
) =>
  Result.isSuccess(result)
    ? Effect.succeed(result.success)
    : Effect.fail(malformed(message, result.failure));

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
        ...(item.content && {
          content: item.content.map(({ text }) => ({ kind: 'text', text })),
        }),
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
 * items for whatever no item event delivered.
 */
export const terminalParts = Effect.fn('llm.responses.terminalParts')(
  function* (response: ResponseValue, type: string) {
    if (response.status !== type.slice('response.'.length))
      return yield* malformed(
        'The terminal event and response status disagree.',
      );
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
    // A completed response states no reason, and its snapshot may list
    // only part of what streamed: the settled content decides.
    let finishReason: HttpTurnResult['finishReason'] | null = null;
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
  // A rejected terminal snapshot still names the response it reports.
  (effect, response) =>
    Effect.mapError(effect, (error) =>
      fillModelError(error, { responseId: response.id, model: response.model }),
    ),
);

/** Canonical image detail as the Responses vocabulary names it. */
const RESPONSES_IMAGE_DETAIL = {
  low: 'low',
  medium: 'auto',
  high: 'high',
  'ultra-high': 'high',
} as const satisfies Record<
  NonNullable<Extract<InputPart, { kind: 'image' }>['detail']>,
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
  part: InputPart,
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
  readonly accepted: boolean;
  readonly fileIdFor: (base64: string) => string | null;
}

const EventSchema = Schema.Struct({
  type: Schema.String,
  sequence_number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const ResponseEventSchema = EventSchema.mapFields(
  Struct.assign({
    response: ResponseSchema,
  }),
);
const ItemEventSchema = EventSchema.mapFields(
  Struct.assign({
    output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    item: OutputItemSchema,
  }),
);
const DeltaEventSchema = EventSchema.mapFields(
  Struct.assign({
    item_id: Schema.String.check(Schema.isMinLength(1)),
    output_index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    delta: Schema.String,
    logprobs: Schema.optional(Schema.NullOr(Schema.Array(Schema.Never))),
  }),
);

const TERMINAL_EVENTS = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
]);
const SNAPSHOT_EVENTS = new Set([
  'response.created',
  'response.queued',
  'response.in_progress',
  ...TERMINAL_EVENTS,
]);
const DELTA_CHANNELS = new Map<string, Append['channel']>([
  ['response.output_text.delta', 'text'],
  ['response.refusal.delta', 'refusal'],
  ['response.reasoning_summary_text.delta', 'summary'],
  ['response.reasoning_text.delta', 'reasoning'],
]);
// Events that own no content: framing (output_item.done carries the item) and
// the Codex backend's response.metadata notices (serving model, safety hints).
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
  'response.metadata',
]);

/** One decoded Responses event: its sequence, its parts, whether it settles. */
interface ResponseEventParts {
  readonly sequence: number;
  readonly parts: readonly PartEvent[];
  readonly terminal: boolean;
}

/**
 * The one Responses event decoder, for HTTP and WebSocket streams and for
 * observation: each event after `after`, in order, as parts.
 */
export function responsesWire(after: number) {
  let sequence = after;
  return (raw: unknown): Effect.Effect<ResponseEventParts, ModelError> =>
    Effect.gen(function* () {
      const header = Schema.decodeUnknownResult(EventSchema)(raw);
      if (
        !Result.isSuccess(header) ||
        header.success.sequence_number <= sequence
      )
        return yield* malformed(
          'The model emitted invalid or out-of-order events.',
        );
      sequence = header.success.sequence_number;
      const type = header.success.type;
      const at = (parts: readonly PartEvent[], terminal = false) => ({
        sequence,
        parts,
        terminal,
      });
      if (SNAPSHOT_EVENTS.has(type)) {
        const { response } = yield* decoded(
          Schema.decodeUnknownResult(ResponseEventSchema)(raw),
          'The response snapshot is malformed or unsupported.',
        );
        if (!TERMINAL_EVENTS.has(type))
          return at([
            { kind: 'identity', id: response.id, model: response.model },
          ]);
        return at(yield* terminalParts(response, type), true);
      }
      if (
        type === 'response.output_item.added' ||
        type === 'response.output_item.done'
      ) {
        const { output_index: index, item } = yield* decoded(
          Schema.decodeUnknownResult(ItemEventSchema)(raw),
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
          Schema.decodeUnknownResult(DeltaEventSchema)(raw),
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
