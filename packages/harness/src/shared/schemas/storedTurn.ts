/**
 * The stored shape of a model turn and of canonical history, owned by
 * storage rather than by `@texra-ai/llm`. A provider SDK or enum
 * change in the package is then no stored format change.
 *
 * What the runtime branches on is strict here: content part kinds and their
 * text or arguments, call identities, the finish reason, token counts, the
 * origin and the provider's response id. What only a provider adapter reads
 * back (finish, refusal and usage evidence, part signatures, encrypted
 * reasoning, continuations, a remote operation's cursor) is
 * {@link ProviderEvidenceSchema}: bytes this store keeps and never interprets.
 * The package parses them when it replays to its own protocol, and refuses
 * another protocol's evidence there. `RunHistory` converts between these
 * shapes and the package's.
 */
import { z } from 'zod';

import { JsonValueSchema } from './jsonValue';
import { Sha256Schema } from './offeredTools';

/** Provider bytes, kept verbatim and never interpreted by storage. */
const ProviderEvidenceSchema = z.strictObject({
  kind: z.string().min(1),
  data: z.record(z.string(), JsonValueSchema),
});

/** Every wire surface a stored turn or usage record names. */
export const StoredProtocolSchema = z.enum([
  'google-interactions',
  'openai-responses',
  'anthropic-messages',
  'openrouter-chat',
  'vscode-lm',
]);

/** The selected binding: protocol, deployment and model, never a secret. */
export const StoredOriginSchema = z.strictObject({
  protocol: StoredProtocolSchema,
  requestedModel: z.string().min(1),
  deployment: z.union([
    z.strictObject({
      endpoint: z.string().min(1),
      credentialScope: z.string().min(1),
    }),
    z.strictObject({ vendor: z.string(), version: z.string() }),
  ]),
  codecVersion: z.int().positive(),
});

const TextPartSchema = z.strictObject({
  kind: z.literal('text'),
  text: z.string(),
});
/** The part kinds that carry media bytes. */
export const MEDIA_PART_KINDS = [
  'image',
  'audio',
  'video',
  'document',
] as const;
/**
 * A media part as history holds it: its bytes by address, never inline.
 * `digest` is the session store's blob address of the part's base64 text
 * (`blobAddress` in `@utils/core/idHash`, the address the row codec stores
 * a string under); every reader of the history sees the address, and only
 * the invocation resolves it, right before the provider call.
 */
const MediaAddress = { mimeType: z.string().min(1), digest: Sha256Schema };
const StoredInputPartSchema = z.discriminatedUnion('kind', [
  TextPartSchema,
  z.strictObject({
    kind: z.literal('image'),
    ...MediaAddress,
    detail: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.enum(['audio', 'video', 'document']),
    ...MediaAddress,
  }),
]);
export type StoredInputPart = z.infer<typeof StoredInputPartSchema>;
/** A media part with its bytes by address. */
export type StoredMediaPart = Exclude<StoredInputPart, { kind: 'text' }>;
/** The same part as a draft may carry it: with its base64 in hand, which the
 *  row codec stores under its address at write, so no committed row holds
 *  media bytes. */
const MediaBytes = { mimeType: z.string().min(1), base64: z.string() };
const MediaBytesPartSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('image'),
    ...MediaBytes,
    detail: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.enum(['audio', 'video', 'document']),
    ...MediaBytes,
  }),
]);
const StoredInputPartDraftSchema = z.union([
  StoredInputPartSchema,
  MediaBytesPartSchema,
]);

const StoredContentSchema = z
  .array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('message'),
        content: z
          .array(
            z.strictObject({
              kind: z.enum(['text', 'refusal']),
              text: z.string(),
            }),
          )
          .readonly(),
        evidence: ProviderEvidenceSchema.optional(),
      }),
      z.strictObject({
        kind: z.literal('reasoning'),
        summary: z.array(TextPartSchema).readonly(),
        content: z.array(TextPartSchema).readonly().optional(),
        evidence: ProviderEvidenceSchema.nullable(),
      }),
      z.strictObject({
        kind: z.literal('local-call'),
        providerCallId: z.string().min(1),
        name: z.string().min(1),
        /** The provider's exact returned bytes, never a parse of them. */
        argumentsText: z.string(),
        evidence: ProviderEvidenceSchema.optional(),
      }),
    ]),
  )
  .readonly();

const TokenCount = z.int().nonnegative().nullable();

/** One completed provider turn. An editor turn reports no provider facts. */
export const StoredTurnSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('http'),
    providerResponseId: z.string().min(1).nullable(),
    requestedOrigin: StoredOriginSchema,
    returnedModel: z.string().min(1).nullable(),
    modelFingerprint: z.string().nullable(),
    content: StoredContentSchema,
    finishReason: z.enum([
      'stop',
      'length',
      'content-filter',
      'tool-calls',
      'stop-sequence',
      'refusal',
      'context-window-exceeded',
    ]),
    stopSequence: z.string().optional(),
    finishEvidence: ProviderEvidenceSchema.optional(),
    refusalEvidence: ProviderEvidenceSchema.nullable().optional(),
    usage: z
      .strictObject({
        inputTokens: TokenCount,
        outputTokens: TokenCount,
        totalTokens: TokenCount,
        cachedInputTokens: TokenCount,
        reasoningTokens: TokenCount,
        providerUsage: ProviderEvidenceSchema.optional(),
      })
      .nullable(),
    continuation: ProviderEvidenceSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('editor'),
    requestedOrigin: StoredOriginSchema,
    providerResponseId: z.null(),
    returnedModel: z.null(),
    modelFingerprint: z.null(),
    finishReason: z.null(),
    usage: z.null(),
    content: StoredContentSchema,
  }),
]);

/** One entry of canonical history, its input parts of `part`. */
const storedMessageSchema = <P extends z.ZodType>(part: P) =>
  z.discriminatedUnion('role', [
    z.strictObject({
      role: z.literal('user'),
      content: z.array(part).min(1).readonly(),
    }),
    z.strictObject({
      role: z.literal('assistant'),
      /** `null`: no model produced it (a call the application handed down). */
      origin: StoredOriginSchema.nullable(),
      content: StoredContentSchema,
    }),
    z.strictObject({
      role: z.literal('tool'),
      results: z
        .array(
          z.strictObject({
            callOrdinal: z.int().nonnegative(),
            status: z.enum(['success', 'error']),
            content: z.array(part).readonly(),
          }),
        )
        .min(1)
        .readonly(),
    }),
    /** A context update the run appended mid-conversation. */
    z.strictObject({ role: z.literal('system'), text: z.string().min(1) }),
  ]);
/** One entry of canonical history as a committed row holds it. */
export const StoredMessageSchema = storedMessageSchema(StoredInputPartSchema);
export type StoredMessage = z.infer<typeof StoredMessageSchema>;
/** One entry as a draft carries it: a media part may still hold its bytes. */
export const StoredMessageDraftSchema = storedMessageSchema(
  StoredInputPartDraftSchema,
);
export type StoredMessageDraft = z.infer<typeof StoredMessageDraftSchema>;

/** Accepted remote work: its identity, and the cursor the adapter observes
 *  it by. */
export const StoredOperationSchema = z.strictObject({
  origin: StoredOriginSchema,
  providerResponseId: z.string().min(1),
  evidence: ProviderEvidenceSchema,
});
