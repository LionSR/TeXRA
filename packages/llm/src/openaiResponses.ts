// Node imports
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

// Third-party imports
import { Cause, Clock, Effect, Exit, Stream, type Scope } from 'effect';
import OpenAI from 'openai';
import { WebSocket, createWebSocketStream } from 'ws';
import { z } from 'zod';

// Local imports - canonical model contract
import { openaiFailure } from './openaiError.js';
import { admittedFingerprint, prefixFingerprint } from './prefixFingerprint.js';
import {
  BackgroundSubmissionSchema,
  CancellationEvidenceSchema,
  ContinuationSchema,
  InputTokenEstimateSchema,
  ModelConfigurationSchema,
  ModelError,
  authOrRejectionKind,
  enrichModelError,
  FILE_UPLOAD_LIFETIME_SECONDS,
  ownedAbortSafeRequest,
  pullStream,
  ObservationPolicySchema,
  parseInboundToolArguments,
  parseJsonOrModelError,
  RemoteOperationSchema,
  ResolvedTurnSchema,
  TurnRequestSchema,
  TurnResultSchema,
  sameModelOrigin,
  type Model,
  type OpenAIResponsesConfiguration,
  type ResolvedTurn,
  type TurnEvent,
  type TurnRequest,
  type TurnResult,
  type BackgroundEvent,
  type BackgroundSubmission,
  type Continuation,
  type RemoteOperation,
  completedTurn,
} from './turn.js';
import { uploadCache, type UploadCache } from './uploadCache.js';
import type { ResponseCreateParamsBase } from 'openai/resources/responses/responses';

type ResponseOrigin = RemoteOperation['origin'];
/**
 * What a Files API upload must return before its id is cached. The SDK's
 * type is not a check on the JSON, so a missing or empty id, or an expiry
 * that is not whole non-negative Unix seconds (absent means the file does
 * not expire), is a malformed response: the upload counts as failed and the
 * bytes are sent.
 */
const UploadedFileSchema = z.object({
  id: z.string().min(1),
  expires_at: z.int().nonnegative().nullish(),
});
type HttpTurnResult = Extract<TurnResult, { providerResponseId: string }>;

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
): Effect.fn.Return<HttpTurnResult['content'][number], ModelError> {
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
});

const normalizeResponse = Effect.fn('llm.responses.normalizeResponse')(
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
const responsesContent = Effect.fn('llm.responses.content')(function* (
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
interface DocumentAccess {
  /** The route takes input files at all. */
  readonly accepted: boolean;
  /** The live file id this binding holds for some bytes, or `null`. */
  readonly fileIdFor: (base64: string) => string | null;
}

const documentAccess = Effect.fn('llm.responses.documentAccess')(function* (
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const nowMs = yield* Clock.currentTimeMillis;
  return {
    accepted: config.supportsDocumentInput,
    fileIdFor: (base64: string) =>
      uploads === null ? null : uploads.fileIdFor(base64, nowMs),
  } satisfies DocumentAccess;
});

/**
 * The items one admitted message lowers to: one per tool result, one per
 * user message, one per assistant content part. A continuation's covered
 * prefix is counted with this instead of lowered, so the bytes it covers
 * are never materialized again; a count that drifts from the lowering fails
 * the continuation's `coveredItems` check loudly.
 */
const loweredItemCount = (
  message: Extract<
    ResolvedTurn,
    { protocol: 'openai-responses' }
  >['messages'][number],
): number => {
  if (message.role === 'tool') return message.results.length;
  return message.role === 'user' ? 1 : message.content.length;
};

/**
 * The call ids one message leaves for the next tool message, replayed
 * without lowering: any non-tool message resets the run, and an assistant
 * message then appends its local calls. A continuation's suffix lowers
 * against the ids its covered prefix left.
 */
const replayCallIds = (
  message: Extract<
    ResolvedTurn,
    { protocol: 'openai-responses' }
  >['messages'][number],
  callIds: string[],
): void => {
  if (message.role === 'tool') return;
  callIds.length = 0;
  if (message.role !== 'assistant') return;
  for (const part of message.content) {
    if (part.kind === 'local-call') callIds.push(part.providerCallId);
  }
};

/**
 * The messages as Responses input items. `callIds` is the mutable call-id
 * run the loop keeps: seeded with the ids a covered prefix left when
 * lowering only a continuation's suffix.
 */
const lowerMessages = Effect.fn('llm.responses.lowerMessages')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  messages: Extract<ResolvedTurn, { protocol: 'openai-responses' }>['messages'],
  documents: DocumentAccess,
  callIds: string[],
) {
  const content = (part: Parameters<typeof responsesContent>[0]) =>
    responsesContent(part, documents);
  const input: OpenAI.Responses.ResponseInput = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      for (const result of message.results) {
        // A settlement that carries only text keeps the plain string output
        // the API has always taken. Attachments keep `result.content` order
        // so a label still sits next to the file it names.
        let output: string | OpenAI.Responses.ResponseInputContent[];
        if (result.content.every((part) => part.kind === 'text')) {
          const text = result.content.map((part) => part.text).join('');
          output = result.status === 'error' ? `Error: ${text}` : text;
        } else {
          const lowered = yield* Effect.forEach(result.content, content);
          output =
            result.status === 'error'
              ? [{ type: 'input_text' as const, text: 'Error: ' }, ...lowered]
              : lowered;
        }
        input.push({
          type: 'function_call_output',
          call_id: callIds[result.callOrdinal],
          output,
        });
      }
      continue;
    }
    callIds.length = 0;
    if (message.role === 'user') {
      input.push({
        role: 'user',
        content: yield* Effect.forEach(message.content, content),
      });
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
        case 'file-annotation':
        case 'url-citation':
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'Responses cannot replay foreign provider annotations.',
          });
        case 'message': {
          if (part.evidence) {
            if (part.evidence.kind !== 'openai-responses-message') {
              return yield* new ModelError({
                kind: 'unsupported',
                message: 'Responses cannot replay foreign message evidence.',
              });
            }
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
          if (
            part.evidence !== undefined &&
            part.evidence.kind !== 'openai-responses-function-call'
          ) {
            return yield* new ModelError({
              kind: 'unsupported',
              message:
                'Responses tool history requires local calls without foreign evidence.',
            });
          }
          callIds.push(part.providerCallId);
          input.push({
            type: 'function_call',
            call_id: part.providerCallId,
            name: part.name,
            arguments: part.argumentsText,
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
  return input;
});

/** The required tool must be among the supplied definitions. */
const checkToolChoice = (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
): Effect.Effect<void, ModelError> => {
  const choice = turn.controls.toolChoice;
  return choice === 'auto' ||
    turn.tools.some((tool) => tool.name === choice.name)
    ? Effect.void
    : Effect.fail(
        new ModelError({
          kind: 'invalid-request',
          message:
            'The required tool must be present in the supplied definitions.',
        }),
      );
};

const lowerInput = Effect.fn('llm.responses.lowerInput')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const documents = yield* documentAccess(config, uploads);
  const input = yield* lowerMessages(turn, turn.messages, documents, []);
  yield* checkToolChoice(turn);
  return input;
});

export const RESPONSES_PREFIX_DOMAIN = 'texra-openai-responses-prefix-v1';

/** Builds only a stored anchor, using the same selected configuration as admission. */
export const openaiResponsesContinuation = Effect.fn(
  'llm.responses.continuation',
)(function* (
  configuration: OpenAIResponsesConfiguration,
  input: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  completed: TurnResult,
): Effect.fn.Return<Continuation | undefined, ModelError> {
  const parsedConfiguration = ModelConfigurationSchema.safeParse(configuration);
  const parsedTurn = ResolvedTurnSchema.safeParse(input);
  const parsedResult = TurnResultSchema.safeParse(completed);
  if (
    !parsedConfiguration.success ||
    parsedConfiguration.data.protocol !== 'openai-responses' ||
    !parsedTurn.success ||
    parsedTurn.data.protocol !== 'openai-responses' ||
    !parsedResult.success ||
    parsedResult.data.providerResponseId === null ||
    !sameModelOrigin(parsedTurn.data, parsedResult.data.requestedOrigin) ||
    !sameModelOrigin(parsedTurn.data, {
      ...parsedConfiguration.data,
      codecVersion: 1,
    })
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
    !parsedConfiguration.data.supportsResponseChaining ||
    !parsedConfiguration.data.supportsStorage ||
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
  return ContinuationSchema.parse({
    origin: result.requestedOrigin,
    coveredMessages: prefix.length,
    prefixFingerprint: prefixFingerprint(
      RESPONSES_PREFIX_DOMAIN,
      result.requestedOrigin,
      turn.system,
      prefix,
    ),
    anchor: {
      kind: 'stored',
      responseId: result.providerResponseId,
      // Counted, not lowered: the covered prefix is never materialized
      // again, and the same count validates the continuation later.
      coveredItems: prefix.reduce(
        (count, message) => count + loweredItemCount(message),
        0,
      ),
    },
  });
});

const responseInput = Effect.fn('llm.responses.input')(function* (
  turn: Extract<ResolvedTurn, { protocol: 'openai-responses' }>,
  config: OpenAIResponsesConfiguration,
  uploads: UploadCache | null,
) {
  const continuation = turn.continuation;
  if (!continuation) return { input: yield* lowerInput(turn, config, uploads) };
  const prefix = turn.messages.slice(0, continuation.coveredMessages);
  if (
    !sameModelOrigin(turn, continuation.origin) ||
    continuation.coveredMessages > turn.messages.length ||
    continuation.anchor.coveredItems !==
      prefix.reduce((count, message) => count + loweredItemCount(message), 0) ||
    continuation.prefixFingerprint !==
      prefixFingerprint(
        RESPONSES_PREFIX_DOMAIN,
        continuation.origin,
        turn.system,
        prefix,
      )
  )
    return yield* new ModelError({
      kind: 'invalid-request',
      message: 'Continuation does not cover the exact admitted prefix.',
    });
  // The stored response already holds the covered prefix, so only the
  // uncovered suffix is lowered: a covered document's bytes are never
  // materialized again. The suffix still lowers against the call ids the
  // prefix's last assistant message left.
  const callIds: string[] = [];
  for (const message of prefix) replayCallIds(message, callIds);
  const documents = yield* documentAccess(config, uploads);
  const input = yield* lowerMessages(
    turn,
    turn.messages.slice(continuation.coveredMessages),
    documents,
    callIds,
  );
  yield* checkToolChoice(turn);
  return {
    input,
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

/** One canonical foreground decoder for HTTP and WebSocket response events. */
function responseEvents(
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

type ResponsesTransport = Extract<
  ResolvedTurn,
  { protocol: 'openai-responses'; mode: 'foreground' }
>['transport'];

/** Resolves controls before admission; no transport request is made here. */
const prepareResponsesTurn = Effect.fn('llm.responses.prepareTurn')(function* (
  config: OpenAIResponsesConfiguration,
  origin: ResponseOrigin,
  transport: ResponsesTransport,
  request: TurnRequest,
  uploads: UploadCache | null,
) {
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
    author.stopSequences !== undefined ||
    (author.continuation !== undefined &&
      author.continuation.origin.protocol !== 'openai-responses') ||
    (author.mode === 'background' &&
      (config.background !== 'supported' || transport.kind !== 'http')) ||
    (!config.supportsTemperature && author.temperature !== undefined) ||
    (!config.supportsMaxOutputTokens && author.maxOutputTokens !== undefined) ||
    (!config.supportsStorage && author.store === true)
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
    transport,
    system:
      config.instructions.kind === 'required'
        ? author.system?.trim() || config.instructions.fallback
        : author.system,
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
  yield* responseParameters(
    config,
    origin,
    transport,
    turn,
    turn.mode,
    uploads,
  );
  return turn;
});

/** Validates the admitted binding and lowers one request without transport flags. */
const responseParameters = Effect.fn('llm.responses.parameters')(function* (
  config: OpenAIResponsesConfiguration,
  origin: ResponseOrigin,
  transport: ResponsesTransport,
  input: ResolvedTurn,
  mode: 'foreground' | 'background',
  uploads: UploadCache | null,
) {
  const parsed = ResolvedTurnSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.protocol !== 'openai-responses' ||
    parsed.data.mode !== mode ||
    !isDeepStrictEqual(parsed.data.transport, transport) ||
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
  if (
    (!config.supportsTemperature && turn.controls.temperature !== null) ||
    (!config.supportsMaxOutputTokens &&
      turn.controls.maxOutputTokens !== null) ||
    (!config.supportsStorage && turn.controls.store) ||
    (config.instructions.kind === 'required' && !turn.system?.trim()) ||
    (turn.controls.reasoning?.effort != null &&
      !config.allowedReasoningEfforts.includes(
        turn.controls.reasoning.effort,
      )) ||
    (turn.continuation !== undefined && !config.supportsResponseChaining)
  )
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The prepared controls are unsupported by the selected route.',
    });
  const wireInput = yield* responseInput(turn, config, uploads);
  const reasoning = turn.controls.reasoning;
  const parameters: ResponseCreateParamsBase = {
    model: turn.requestedModel,
    ...wireInput,
    ...(turn.system !== undefined ? { instructions: turn.system } : {}),
    ...(turn.controls.maxOutputTokens !== null
      ? { max_output_tokens: turn.controls.maxOutputTokens }
      : {}),
    store: turn.controls.store,
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
            ...(reasoning.effort !== null ? { effort: reasoning.effort } : {}),
            ...(reasoning.mode !== null ? { mode: reasoning.mode } : {}),
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
  };
  return { turn, parameters };
});

/** OpenAI's abort signature: the raw abort reason, or the SDK's wrapper around it. */
const openaiAbortMatch = (cause: unknown, signal: AbortSignal): boolean =>
  cause === signal.reason ||
  (cause instanceof OpenAI.APIUserAbortError && cause.cause === signal.reason);

/** Counts only the initial text input; the caller owns admission and retry policy. */
const estimateResponseInput = Effect.fn('llm.responses.estimateInputTokens')(
  function* (
    config: OpenAIResponsesConfiguration,
    origin: ResponseOrigin,
    transport: ResponsesTransport,
    client: OpenAI,
    input: Extract<ResolvedTurn, { mode: 'foreground' }>,
  ) {
    // Estimation admits a single text message, so no file id can apply.
    const { turn, parameters } = yield* responseParameters(
      config,
      origin,
      transport,
      input,
      'foreground',
      null,
    );
    if (
      turn.continuation !== undefined ||
      turn.tools.length !== 0 ||
      turn.messages.length !== 1 ||
      turn.messages[0]?.role !== 'user' ||
      turn.messages[0].content.some((part) => part.kind !== 'text')
    )
      return yield* new ModelError({
        kind: 'unsupported',
        message:
          'Input estimation supports one initial text-only user message without tools or continuation.',
      });

    let requestId: string | undefined;
    const enrich = (error: ModelError) =>
      enrichModelError(error, {
        requestId: error.requestId ?? requestId,
        model: error.model ?? origin.requestedModel,
      });
    const raw = yield* ownedAbortSafeRequest(
      (signal) =>
        client.responses.inputTokens
          .count(
            {
              model: parameters.model,
              input: parameters.input,
              ...(parameters.instructions !== undefined
                ? { instructions: parameters.instructions }
                : {}),
              ...(parameters.reasoning !== undefined
                ? { reasoning: parameters.reasoning }
                : {}),
            },
            { signal, maxRetries: 0 },
          )
          .asResponse()
          .then((response) => {
            requestId = response.headers.get('x-request-id') ?? undefined;
            return response.json() as Promise<unknown>;
          }),
      (cause) =>
        enrich(
          cause instanceof SyntaxError
            ? new ModelError({
                kind: 'malformed-output',
                message: 'The input token count returned malformed JSON.',
                cause,
              })
            : openaiFailure(cause),
        ),
      {
        isAbortMatch: openaiAbortMatch,
        cleanupFailure: (cause) =>
          enrich(
            new ModelError({
              kind: 'transport',
              message:
                'The input token count failed while joining its request.',
              cause,
            }),
          ),
      },
    );
    const parsed = z
      .object({
        object: z.literal('response.input_tokens'),
        input_tokens: InputTokenEstimateSchema.unwrap().shape.inputTokens,
      })
      .safeParse(raw);
    if (!parsed.success)
      return yield* enrich(
        new ModelError({
          kind: 'malformed-output',
          message: 'The input token count returned an invalid receipt.',
          cause: parsed.error,
        }),
      );
    return InputTokenEstimateSchema.parse({
      inputTokens: parsed.data.input_tokens,
      coverage: 'responses-input',
    });
  },
);

const ResponseAuthenticationSchema = z.discriminatedUnion('kind', [
  z
    .strictObject({
      kind: z.literal('api-key'),
      apiKey: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/),
    })
    .readonly(),
  z
    .strictObject({
      kind: z.literal('codex'),
      accessToken: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/),
      accountId: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+$/)
        .nullable(),
    })
    .readonly(),
]);

/** Secrets are captured together and never become prepared request controls. */
function responseAuthentication(
  input: z.infer<typeof ResponseAuthenticationSchema>,
) {
  if (process.env.OPENAI_CUSTOM_HEADERS)
    throw new ModelError({
      kind: 'unsupported',
      message:
        'Ambient OpenAI headers cannot override the selected deployment.',
    });
  const authentication = ResponseAuthenticationSchema.parse(input);
  return authentication.kind === 'api-key'
    ? { token: authentication.apiKey, headers: {} }
    : {
        token: authentication.accessToken,
        headers: {
          ...(authentication.accountId !== null
            ? { 'chatgpt-account-id': authentication.accountId }
            : {}),
          originator: 'texra',
          'openai-beta': 'responses=experimental',
        },
      };
}

/** Direct Responses operations, with no application model adapter. */
export function openaiResponsesModel(
  configuration: OpenAIResponsesConfiguration,
  transport: {
    readonly authentication: z.infer<typeof ResponseAuthenticationSchema>;
    readonly fetch?: typeof fetch;
  },
): Model {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openai-responses') {
    throw new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  }
  const origin = Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1,
  } satisfies ResponseOrigin);
  const authentication = responseAuthentication(transport.authentication);
  const client = new OpenAI({
    apiKey: authentication.token,
    defaultHeaders: authentication.headers,
    baseURL: config.deployment.endpoint,
    fetch: transport.fetch,
    maxRetries: 0,
    organization: null,
    project: null,
    logLevel: 'off',
  });
  // Uploads need a files endpoint and a stable account: an API-key binding.
  // A subscription token rotates and its backend serves no files endpoint.
  const uploads =
    transport.authentication.kind === 'api-key'
      ? uploadCache({
          send: (upload) =>
            Effect.gen(function* () {
              const uploaded = yield* Effect.tryPromise({
                try: async (signal) =>
                  client.files.create(
                    {
                      file: await OpenAI.toFile(
                        Buffer.from(upload.base64, 'base64'),
                        upload.filename,
                        { type: upload.mimeType },
                      ),
                      purpose: 'user_data',
                      expires_after: {
                        anchor: 'created_at',
                        seconds: FILE_UPLOAD_LIFETIME_SECONDS,
                      },
                    },
                    { signal },
                  ),
                catch: (cause) =>
                  enrichModelError(openaiFailure(cause), {
                    model: origin.requestedModel,
                  }),
              });
              const parsed = UploadedFileSchema.safeParse(uploaded);
              if (!parsed.success)
                return yield* new ModelError({
                  kind: 'malformed-output',
                  message:
                    'OpenAI returned an upload without a usable file id.',
                  model: origin.requestedModel,
                  cause: parsed.error,
                });
              return {
                fileId: parsed.data.id,
                expiresAtMs:
                  parsed.data.expires_at == null
                    ? null
                    : parsed.data.expires_at * 1000,
              };
            }),
          // A 404 means the provider already expired the file.
          remove: (fileId) =>
            Effect.tryPromise({
              try: (signal) => client.files.delete(fileId, { signal }),
              catch: (cause) =>
                enrichModelError(openaiFailure(cause), {
                  model: origin.requestedModel,
                }),
            }).pipe(
              Effect.asVoid,
              Effect.catchTag('ModelError', (error) =>
                error.status === 404 ? Effect.void : Effect.fail(error),
              ),
            ),
        })
      : null;
  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, { kind: 'http' }, request, uploads);

  const createResponse = Effect.fn('llm.responses.create')(function* (
    input: ResolvedTurn,
    mode: 'foreground' | 'background',
  ) {
    const { turn, parameters } = yield* responseParameters(
      config,
      origin,
      { kind: 'http' },
      input,
      mode,
      uploads,
    );
    const signal = yield* Effect.abortSignal;
    const opened = yield* Effect.tryPromise({
      try: () =>
        client.responses
          .create(
            {
              ...parameters,
              stream: true,
              ...(mode === 'background' ? { background: true } : {}),
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
      let requestId: string | undefined;
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      const enrich = (error: ModelError) =>
        enrichModelError(error, {
          requestId: error.requestId ?? requestId,
          responseId: error.responseId ?? responseId,
          model: error.model ?? returnedModel ?? config.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const { turn, opened } = yield* createResponse(input, 'foreground');
          requestId = opened.request_id ?? undefined;
          const chunks = yield* sdkEvents(opened.data, enrich);
          return responseEvents(chunks, origin).pipe(
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                if (event.kind === 'identified') {
                  responseId = event.providerResponseId;
                  returnedModel = event.returnedModel ?? undefined;
                }
                if (event.kind !== 'completed') return event;
                const continuation = yield* openaiResponsesContinuation(
                  config,
                  turn,
                  event.result,
                );
                return {
                  ...event,
                  result: continuation
                    ? TurnResultSchema.parse({ ...event.result, continuation })
                    : event.result,
                };
              }),
            ),
            Stream.mapError(enrich),
          );
        }).pipe(Effect.mapError(enrich)),
      );
    });
  const generateTurn: Model['generateTurn'] = (turn) =>
    completedTurn(streamTurn(turn));

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
      enrichModelError(error, {
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
          admittedFingerprint: admittedFingerprint(
            RESPONSES_PREFIX_DOMAIN,
            turn,
          ),
          store: turn.controls.store,
        });
        if (
          (type === 'response.completed' && response.status === 'completed') ||
          (type === 'response.incomplete' && response.status === 'incomplete')
        ) {
          const content = yield* Effect.forEach(response.output, normalizeItem);
          const result = yield* normalizeResponse(response, origin, content);
          const continuation = yield* openaiResponsesContinuation(
            config,
            turn,
            result,
          );
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
    admitted,
    input,
    policy,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const operation = yield* boundOperation(input);
        const parsedTurn = ResolvedTurnSchema.safeParse(admitted);
        if (
          !parsedTurn.success ||
          parsedTurn.data.protocol !== 'openai-responses' ||
          parsedTurn.data.mode !== 'background' ||
          !sameModelOrigin(parsedTurn.data, operation.origin)
        )
          return yield* new ModelError({
            kind: 'unsupported',
            message: 'The admitted turn belongs to another model binding.',
          });
        const turn = parsedTurn.data;
        // The operation records what the provider was actually given. A
        // resume rebuilds the turn from the caller's current system text, so
        // a drifted rebuild still gets its result but must leave no anchor:
        // the next round then resends the transcript instead of chaining on
        // instructions the answer never saw.
        // The admitted storage mode is part of what makes an anchor safe: a
        // turn re-derived stored for a temporary operation must not chain.
        const chains =
          turn.controls.store === operation.store &&
          admittedFingerprint(RESPONSES_PREFIX_DOMAIN, turn) ===
            operation.admittedFingerprint;
        if (!chains) {
          yield* Effect.logWarning(
            `The admitted inputs of background operation ${operation.providerResponseId} changed since it was accepted; its completion leaves no continuation.`,
          );
        }
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
          enrichModelError(error, {
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
              HttpTurnResult['content'][number]
            >();
            let terminal:
              | {
                  readonly result: HttpTurnResult;
                  readonly afterSequence: number;
                }
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
                        providerItemIndex: parsed.data.output_index,
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
                    return parsed.data.item.type === 'function_call'
                      ? [{ kind: 'cursor', afterSequence }]
                      : [
                          {
                            kind: 'phase',
                            part:
                              parsed.data.item.type === 'reasoning'
                                ? 'reasoning'
                                : 'text',
                            boundary:
                              type === 'response.output_item.added'
                                ? 'start'
                                : 'end',
                            providerItemIndex: parsed.data.output_index,
                            afterSequence,
                          },
                        ];
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
                  // The same anchor the foreground completion builds: an
                  // observed turn chains on `previous_response_id` too.
                  const continuation = chains
                    ? yield* openaiResponsesContinuation(
                        config,
                        turn,
                        terminal.result,
                      )
                    : undefined;
                  return {
                    kind: 'completed',
                    afterSequence: terminal.afterSequence,
                    result: continuation
                      ? { ...terminal.result, continuation }
                      : terminal.result,
                  };
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
    let requestId: string | undefined;
    const enrich = (error: ModelError) =>
      enrichModelError(error, {
        operation,
        responseId: operation.providerResponseId,
        requestId: error.requestId ?? requestId,
      });
    return yield* Effect.gen(function* () {
      const raw = yield* ownedAbortSafeRequest(
        (signal) =>
          client.responses
            .cancel(operation.providerResponseId, { signal })
            .asResponse()
            .then((response) => {
              requestId = response.headers.get('x-request-id') ?? undefined;
              return response.json() as Promise<unknown>;
            }),
        (cause) =>
          enrich(
            cause instanceof SyntaxError
              ? new ModelError({
                  kind: 'malformed-output',
                  message: 'Cancellation returned malformed JSON.',
                  cause,
                })
              : openaiFailure(cause),
          ),
        {
          isAbortMatch: openaiAbortMatch,
          cleanupFailure: (cause) =>
            enrich(
              new ModelError({
                kind: 'transport',
                message: 'Cancellation failed while joining its request.',
                cause,
              }),
            ),
        },
      );
      // Cancellation cannot request encrypted output includes. Report status only.
      const parsed = ResponseSchema.pick({
        id: true,
        object: true,
        model: true,
        status: true,
      }).safeParse(raw);
      if (!parsed.success || parsed.data.id !== operation.providerResponseId)
        return yield* new ModelError({
          kind: 'malformed-output',
          message: 'Cancellation returned invalid response identity or status.',
          requestId,
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
      Effect.catchCause((cause) => Effect.failCause(Cause.map(cause, enrich))),
    );
  });

  return Object.freeze({
    prepareTurn,
    streamTurn,
    generateTurn,
    ...(uploads !== null
      ? {
          uploadFile: uploads.uploadFile,
          releaseUploads: uploads.releaseUploads,
        }
      : {}),
    ...(config.supportsInputTokenEstimation
      ? {
          estimateInputTokens: (
            input: Extract<ResolvedTurn, { mode: 'foreground' }>,
          ) =>
            estimateResponseInput(
              config,
              origin,
              { kind: 'http' },
              client,
              input,
            ),
        }
      : {}),
    ...(config.background === 'supported'
      ? { background: Object.freeze({ submit, observe, cancel }) }
      : {}),
  });
}

const WebSocketEnvelopeSchema = z.object({
  type: z.string(),
  // This acquisition owns the implicit lane, not a multiplexed connection.
  stream_id: z.never().optional(),
});
const WebSocketErrorSchema = z.union([
  z.object({
    type: z.literal('error'),
    status: z.int().optional(),
    error: z.object({
      type: z.string(),
      code: z.string().nullable(),
      message: z.string(),
      param: z.string().nullish(),
    }),
  }),
  z
    .object({
      type: z.literal('error'),
      sequence_number: z.int().nonnegative(),
      code: z.string().nullable(),
      message: z.string(),
      param: z.string().nullable(),
    })
    .transform((error) => ({ error, status: undefined })),
]);

/** Acquires one physical connection; invalidation requires explicit reacquisition. */
export const openaiResponsesWebSocketModel = Effect.fn(
  'llm.responses.webSocketModel',
)(function* (
  configuration: OpenAIResponsesConfiguration,
  authentication: z.infer<typeof ResponseAuthenticationSchema>,
): Effect.fn.Return<Model, ModelError, Scope.Scope> {
  const config = ModelConfigurationSchema.parse(configuration);
  if (config.protocol !== 'openai-responses')
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'This model implements the Responses protocol.',
    });
  const origin = Object.freeze({
    protocol: config.protocol,
    requestedModel: config.requestedModel,
    deployment: config.deployment,
    codecVersion: 1,
  } satisfies ResponseOrigin);
  const selected = yield* Effect.try({
    try: () => responseAuthentication(authentication),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      cause instanceof ModelError ? Effect.fail(cause) : Effect.die(cause),
    ),
  );
  const countClient = config.supportsInputTokenEstimation
    ? new OpenAI({
        apiKey: selected.token,
        defaultHeaders: selected.headers,
        baseURL: config.deployment.endpoint,
        maxRetries: 0,
        organization: null,
        project: null,
        logLevel: 'off',
      })
    : undefined;
  const endpoint = new URL(config.deployment.endpoint);
  if (endpoint.username || endpoint.password)
    return yield* new ModelError({
      kind: 'unsupported',
      message:
        'Responses endpoint credentials cannot override the selected authentication.',
    });
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, '')}/responses`;
  if (endpoint.protocol === 'https:') endpoint.protocol = 'wss:';
  else if (endpoint.protocol === 'http:') endpoint.protocol = 'ws:';
  else
    return yield* new ModelError({
      kind: 'unsupported',
      message: 'The Responses endpoint must use HTTP or HTTPS.',
    });
  const transport = { kind: 'websocket' as const, connectionId: randomUUID() };
  const openedAt = yield* Clock.currentTimeMillis;
  const closed = new ModelError({
    kind: 'transport',
    message:
      'The Responses connection is no longer usable; reacquire and admit a new turn.',
  });
  let invalid: ModelError | undefined;
  let phase: 'idle' | 'reading' | 'draining' = 'idle';
  let pendingRead: Promise<IteratorResult<unknown>> | undefined;
  let latestResponseId: string | undefined;

  const failure = (cause: unknown) =>
    cause instanceof ModelError
      ? cause
      : new ModelError({
          kind: 'transport',
          message: 'The Responses WebSocket failed.',
          cause,
        });
  const join = (pending: Promise<unknown>, exit: Exit.Exit<unknown, unknown>) =>
    Effect.tryPromise({ try: () => pending, catch: (cause) => cause }).pipe(
      Effect.catch((cause) => {
        const repeated =
          Exit.isFailure(exit) &&
          exit.cause.reasons.some(
            (reason) =>
              (Cause.isFailReason(reason) &&
                (reason.error === cause ||
                  (reason.error instanceof ModelError &&
                    reason.error.cause === cause))) ||
              (Cause.isDieReason(reason) && reason.defect === cause),
          );
        return cause === closed || repeated ? Effect.void : Effect.die(cause);
      }),
      Effect.asVoid,
    );
  const resource = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new WebSocket(endpoint, {
        headers: {
          Authorization: `Bearer ${selected.token}`,
          ...selected.headers,
        },
        followRedirects: false,
      });
      const reader = createWebSocketStream(socket, {
        readableObjectMode: true,
      });
      // This listener records failures while idle as well as during a pending read.
      reader.on('error', (cause) => {
        invalid ??= failure(cause);
      });
      socket.once('close', () => {
        invalid ??= closed;
      });
      return {
        socket,
        reader,
        iterator: reader[Symbol.asyncIterator]() as AsyncIterator<unknown>,
      };
    }),
    ({ socket, reader, iterator }, exit) =>
      Effect.gen(function* () {
        invalid ??= closed;
        reader.destroy(closed);
        yield* join(
          iterator.return ? iterator.return() : Promise.resolve(),
          exit,
        ).pipe(
          Effect.ensuring(
            Effect.callback<void>((resume) => {
              if (socket.readyState === WebSocket.CLOSED) resume(Effect.void);
              else socket.once('close', () => resume(Effect.void));
            }),
          ),
        );
      }),
  );
  const { socket, reader, iterator } = resource;
  const invalidate = (error: ModelError) => {
    invalid ??= error;
    reader.destroy(invalid);
  };
  // The sole consumer decodes frames; this synchronous guard only invalidates idle traffic.
  socket.on('message', () => {
    if (phase !== 'reading')
      invalidate(
        new ModelError({
          kind: 'malformed-output',
          message:
            'The Responses connection received data without an active turn.',
        }),
      );
  });
  yield* Effect.callback<void, ModelError>((resume) => {
    const remove = () => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('unexpected-response', onUnexpected);
    };
    const onOpen = () => {
      remove();
      resume(Effect.void);
    };
    const onError = (cause: Error) => {
      remove();
      resume(Effect.fail(invalid ?? failure(cause)));
    };
    const onUnexpected = (
      request: import('node:http').ClientRequest,
      response: import('node:http').IncomingMessage,
    ) => {
      const status = response.statusCode;
      const error = new ModelError({
        kind: authOrRejectionKind(status),
        message: `The Responses WebSocket handshake was rejected${status === undefined ? '' : ` (${status})`}.`,
        status,
        requestId:
          typeof response.headers['x-request-id'] === 'string'
            ? response.headers['x-request-id']
            : undefined,
      });
      remove();
      invalid = error;
      response.destroy();
      request.destroy();
      reader.destroy();
      resume(Effect.fail(error));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('unexpected-response', onUnexpected);
    return Effect.sync(remove);
  });
  yield* Effect.gen(function* () {
    while (!invalid) {
      yield* Effect.sleep(30_000);
      if (!invalid)
        yield* Effect.callback<void>((resume) => {
          socket.ping((cause: Error | undefined) => {
            if (cause) invalidate(failure(cause));
            resume(Effect.void);
          });
        });
    }
  }).pipe(Effect.forkScoped);

  const prepareTurn: Model['prepareTurn'] = (request) =>
    prepareResponsesTurn(config, origin, transport, request, null);
  const streamTurn: Model['streamTurn'] = (input) =>
    Stream.suspend(() => {
      let responseId: string | undefined;
      let returnedModel: string | undefined;
      let completed = false;
      const enrich = (error: ModelError) =>
        enrichModelError(error, {
          responseId: error.responseId ?? responseId,
          model: error.model ?? returnedModel ?? config.requestedModel,
        });
      return Stream.unwrap(
        Effect.gen(function* () {
          const { turn, parameters } = yield* responseParameters(
            config,
            origin,
            transport,
            input,
            'foreground',
            null,
          );
          const now = yield* Clock.currentTimeMillis;
          yield* Effect.acquireRelease(
            Effect.suspend(() => {
              if (invalid) return Effect.fail(invalid);
              if (phase !== 'idle')
                return Effect.fail(
                  new ModelError({
                    kind: 'unsupported',
                    message:
                      'This Responses connection already has an active turn.',
                  }),
                );
              if (now - openedAt >= 55 * 60_000) {
                invalidate(closed);
                return Effect.fail(closed);
              }
              phase = 'reading';
              return Effect.void;
            }),
            (_, exit) =>
              Effect.gen(function* () {
                if (!completed || Exit.isFailure(exit)) invalidate(closed);
                if (pendingRead) yield* join(pendingRead, exit);
                pendingRead = undefined;
                if (!invalid) phase = 'idle';
              }),
          );
          yield* Effect.callback<void, ModelError>((resume) => {
            socket.send(
              JSON.stringify({
                type: 'response.create',
                ...parameters,
                ...(config.webSocketStreamParameter === 'required'
                  ? { stream: true }
                  : {}),
              }),
              (cause) =>
                resume(cause ? Effect.fail(failure(cause)) : Effect.void),
            );
          });
          const chunks = Stream.fromPull(
            Effect.succeed(
              Effect.gen(function* () {
                pendingRead = iterator.next();
                const next = yield* Effect.tryPromise({
                  try: () => pendingRead!,
                  catch: failure,
                });
                pendingRead = undefined;
                if (next.done) return yield* closed;
                if (typeof next.value !== 'string')
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The Responses connection returned a binary frame.',
                  });
                const raw = yield* parseJsonOrModelError(
                  next.value as string,
                  (cause) =>
                    new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The Responses connection returned invalid JSON.',
                      cause,
                    }),
                );
                const envelope = WebSocketEnvelopeSchema.safeParse(raw);
                if (!envelope.success)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The Responses event does not belong to the implicit lane.',
                    cause: envelope.error,
                  });
                if (envelope.data.type === 'error') {
                  const rejected = WebSocketErrorSchema.safeParse(raw);
                  if (!rejected.success)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The Responses connection returned a malformed error.',
                      cause: rejected.error,
                    });
                  return yield* new ModelError({
                    kind: authOrRejectionKind(rejected.data.status),
                    message: rejected.data.error.message,
                    status: rejected.data.status,
                    cause: rejected.data.error,
                  });
                }
                return [raw] as const;
              }),
            ),
          );
          return responseEvents(chunks, origin).pipe(
            Stream.mapEffect((event) =>
              Effect.gen(function* () {
                if (event.kind === 'identified') {
                  if (event.providerResponseId === latestResponseId)
                    return yield* new ModelError({
                      kind: 'malformed-output',
                      message:
                        'The Responses connection repeated its preceding response identity.',
                    });
                  responseId = event.providerResponseId;
                  returnedModel = event.returnedModel ?? undefined;
                }
                if (event.kind !== 'completed') return event;
                phase = 'draining';
                if (reader.readableLength > 0)
                  return yield* new ModelError({
                    kind: 'malformed-output',
                    message:
                      'The Responses connection buffered data beyond its terminal event.',
                  });
                latestResponseId = event.result.providerResponseId ?? undefined;
                const continuation = yield* openaiResponsesContinuation(
                  config,
                  turn,
                  event.result,
                );
                completed = true;
                return {
                  ...event,
                  result: continuation
                    ? TurnResultSchema.parse({ ...event.result, continuation })
                    : event.result,
                };
              }),
            ),
            Stream.mapError(enrich),
          );
        }).pipe(Effect.mapError(enrich)),
      );
    });
  const generateTurn: Model['generateTurn'] = (turn) =>
    completedTurn(streamTurn(turn));
  return Object.freeze({
    prepareTurn,
    streamTurn,
    generateTurn,
    ...(countClient
      ? {
          estimateInputTokens: Effect.fn(
            'llm.responses.webSocketEstimateInputTokens',
          )(function* (input: Extract<ResolvedTurn, { mode: 'foreground' }>) {
            if (invalid) return yield* invalid;
            if ((yield* Clock.currentTimeMillis) - openedAt >= 55 * 60_000)
              return yield* closed;
            return yield* estimateResponseInput(
              config,
              origin,
              transport,
              countClient,
              input,
            );
          }),
        }
      : {}),
  });
});
