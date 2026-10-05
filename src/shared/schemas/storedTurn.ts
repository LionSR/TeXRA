/**
 * The stored shape of a model turn and of canonical history
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §4),
 * owned by storage rather than by `@texra-ai/llm`. A provider SDK or enum
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
 * shapes and the package's (`src/agent/runtime/storedTurn.ts`).
 */
import { z } from 'zod';

import { JsonValueSchema } from './jsonValue';

/** Provider bytes, kept verbatim and never interpreted by storage. */
export const ProviderEvidenceSchema = z.strictObject({
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
const MediaFields = { mimeType: z.string().min(1), base64: z.string() };
const StoredInputPartSchema = z.discriminatedUnion('kind', [
  TextPartSchema,
  z.strictObject({
    kind: z.literal('image'),
    ...MediaFields,
    detail: z.string().min(1).optional(),
  }),
  z.strictObject({
    kind: z.enum(['audio', 'video', 'document']),
    ...MediaFields,
  }),
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
    providerResponseId: z.string().min(1),
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

/** One entry of canonical history. */
export const StoredMessageSchema = z.discriminatedUnion('role', [
  z.strictObject({
    role: z.literal('user'),
    content: z.array(StoredInputPartSchema).min(1).readonly(),
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
          content: z.array(StoredInputPartSchema).readonly(),
        }),
      )
      .min(1)
      .readonly(),
  }),
  /** A context update the run appended mid-conversation. */
  z.strictObject({ role: z.literal('system'), text: z.string().min(1) }),
]);

/** Accepted remote work: its identity, and the cursor the adapter observes
 *  it by. */
export const StoredOperationSchema = z.strictObject({
  origin: StoredOriginSchema,
  providerResponseId: z.string().min(1),
  evidence: ProviderEvidenceSchema,
});
