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
import { Schema } from 'effect';

import { JsonValueSchema } from './jsonValue';
import { Sha256Schema } from './offeredTools';

/** Provider bytes, kept verbatim and never interpreted by storage. */
const ProviderEvidenceSchema = Schema.Struct({
  kind: Schema.NonEmptyString,
  data: Schema.Record(Schema.String, JsonValueSchema),
});

/** Every wire surface a stored turn or usage record names. */
export const StoredProtocolSchema = Schema.Literals([
  'google-interactions',
  'openai-responses',
  'anthropic-messages',
]);

/** The selected binding: protocol, deployment and model, never a secret. */
export const StoredOriginSchema = Schema.Struct({
  protocol: StoredProtocolSchema,
  requestedModel: Schema.NonEmptyString,
  deployment: Schema.Struct({
    endpoint: Schema.NonEmptyString,
    credentialScope: Schema.NonEmptyString,
  }),
  codecVersion: Schema.Int.check(Schema.isGreaterThan(0)),
});

const TextPartSchema = Schema.Struct({
  kind: Schema.Literal('text'),
  text: Schema.String,
});
/**
 * A media part as history holds it: its bytes by address, never inline.
 * `digest` is the session store's blob address of the part's base64 text
 * (`blobAddress` in `@utils/core/idHash`): every reader of the history sees
 * the address, and only the invocation resolves it, right before the
 * provider call (`agent/runtime/storedTurn.ts`).
 */
const MediaAddress = {
  mimeType: Schema.NonEmptyString,
  digest: Sha256Schema,
};
const StoredInputPartSchema = Schema.Union([
  TextPartSchema,
  Schema.Struct({
    kind: Schema.Literal('image'),
    ...MediaAddress,
    detail: Schema.optional(Schema.NonEmptyString),
  }),
  Schema.Struct({
    kind: Schema.Literals(['audio', 'video', 'document']),
    ...MediaAddress,
  }),
]);
/** One part of a stored user or tool-result message. */
export type StoredInputPart = typeof StoredInputPartSchema.Type;
/** A media part: its bytes by address. */
export type StoredMediaPart = Exclude<StoredInputPart, { kind: 'text' }>;

const StoredContentSchema = Schema.Array(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('message'),
      content: Schema.Array(
        Schema.Struct({
          kind: Schema.Literals(['text', 'refusal']),
          text: Schema.String,
        }),
      ),
      evidence: Schema.optional(ProviderEvidenceSchema),
    }),
    Schema.Struct({
      kind: Schema.Literal('reasoning'),
      summary: Schema.Array(TextPartSchema),
      content: Schema.optional(Schema.Array(TextPartSchema)),
      evidence: Schema.NullOr(ProviderEvidenceSchema),
    }),
    Schema.Struct({
      kind: Schema.Literal('local-call'),
      providerCallId: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      /** The provider's exact returned bytes, never a parse of them. */
      argumentsText: Schema.String,
      evidence: Schema.optional(ProviderEvidenceSchema),
    }),
  ]),
);

const TokenCount = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
);

/** One completed provider turn. */
export const StoredTurnSchema = Schema.Struct({
  kind: Schema.Literal('http'),
  providerResponseId: Schema.NullOr(Schema.NonEmptyString),
  requestedOrigin: StoredOriginSchema,
  returnedModel: Schema.NullOr(Schema.NonEmptyString),
  modelFingerprint: Schema.NullOr(Schema.String),
  content: StoredContentSchema,
  finishReason: Schema.Literals([
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'stop-sequence',
    'refusal',
    'context-window-exceeded',
  ]),
  stopSequence: Schema.optional(Schema.String),
  finishEvidence: Schema.optional(ProviderEvidenceSchema),
  refusalEvidence: Schema.optional(Schema.NullOr(ProviderEvidenceSchema)),
  usage: Schema.NullOr(
    Schema.Struct({
      inputTokens: TokenCount,
      outputTokens: TokenCount,
      totalTokens: TokenCount,
      cachedInputTokens: TokenCount,
      reasoningTokens: TokenCount,
      providerUsage: Schema.optional(ProviderEvidenceSchema),
    }),
  ),
  continuation: Schema.optional(ProviderEvidenceSchema),
});

/** One entry of canonical history. */
export const StoredMessageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal('user'),
    content: Schema.Array(StoredInputPartSchema).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    role: Schema.Literal('assistant'),
    /** `null`: no model produced it (a call the application handed down). */
    origin: Schema.NullOr(StoredOriginSchema),
    content: StoredContentSchema,
  }),
  Schema.Struct({
    role: Schema.Literal('tool'),
    results: Schema.Array(
      Schema.Struct({
        callOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        status: Schema.Literals(['success', 'error']),
        content: Schema.Array(StoredInputPartSchema),
      }),
    ).check(Schema.isMinLength(1)),
  }),
  /** A context update the run appended mid-conversation. */
  Schema.Struct({
    role: Schema.Literal('system'),
    text: Schema.NonEmptyString,
  }),
]);
/** One entry of canonical history, as a committed row holds it. */
export type StoredMessage = typeof StoredMessageSchema.Type;

/** Accepted remote work: its identity, and the cursor the adapter observes
 *  it by. */
export const StoredOperationSchema = Schema.Struct({
  origin: StoredOriginSchema,
  providerResponseId: Schema.NonEmptyString,
  evidence: ProviderEvidenceSchema,
});
