// Third-party imports
import { Result, Schema, Struct } from 'effect';

// Local imports - canonical protocol binding
import {
  ModelOriginSchema,
  OriginSchema,
  sameModelOrigin,
  type ModelOrigin,
  checkPreparedHistory,
} from './protocol.js';

const TextPartSchema = Schema.Struct({
  kind: Schema.Literal('text'),
  text: Schema.String,
});
const MediaFieldsSchema = Schema.Struct({
  mimeType: Schema.String.check(Schema.isMinLength(1)),
  // Encoding validity is distinct from a provider accepting the captured bytes.
  base64: Schema.String.check(Schema.isBase64()),
});
const InputPartSchema = Schema.Union([
  TextPartSchema,
  MediaFieldsSchema.mapFields(
    Struct.assign({
      kind: Schema.Literal('image'),
      detail: Schema.optional(
        Schema.Literals(['low', 'medium', 'high', 'ultra-high']),
      ),
    }),
  ),
  MediaFieldsSchema.mapFields(
    Struct.assign({
      kind: Schema.Literals(['audio', 'video', 'document']),
    }),
  ),
]);

const EvidenceStatusSchema = Schema.Literals(['completed', 'incomplete']);
const MessagePartSchema = Schema.Struct({
  kind: Schema.Literal('message'),
  content: Schema.Array(
    Schema.Union([
      TextPartSchema,
      Schema.Struct({ kind: Schema.Literal('refusal'), text: Schema.String }),
    ]),
  ),
  evidence: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal('openai-responses-message'),
      itemId: Schema.String.check(Schema.isMinLength(1)),
      status: EvidenceStatusSchema,
      phase: Schema.optional(
        Schema.NullOr(Schema.Literals(['commentary', 'final_answer'])),
      ),
    }),
  ),
});
const LocalCallPartSchema = Schema.Struct({
  kind: Schema.Literal('local-call'),
  providerCallId: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String.check(Schema.isMinLength(1)),
  /**
   * The provider's exact returned bytes, the one carrier of the arguments.
   * A JSON.parse then JSON.stringify round trip is not byte exact (it
   * truncates integers past 2^53, rewrites 1.0 as 1, collapses duplicate
   * keys and reorders integer-like keys), so the parse is never stored;
   * codecs parse these bytes where a request is lowered.
   */
  argumentsText: Schema.String,
  evidence: Schema.optional(
    Schema.Struct({
      kind: Schema.Literal('openai-responses-function-call'),
      itemId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
      status: Schema.optional(Schema.Literal('completed')),
    }),
  ),
});

const OutputPartSchema = Schema.Union([
  MessagePartSchema,
  Schema.Struct({
    kind: Schema.Literal('reasoning'),
    summary: Schema.Array(TextPartSchema),
    content: Schema.optional(Schema.Array(TextPartSchema)),
    evidence: Schema.NullOr(
      Schema.Union([
        Schema.Struct({
          kind: Schema.Literal('google-interactions-thought-signature'),
          signature: Schema.String.check(Schema.isMinLength(1)),
        }),
        Schema.Struct({
          kind: Schema.Literal('openai-responses-reasoning'),
          itemId: Schema.String.check(Schema.isMinLength(1)),
          // Missing, null and exact opaque bytes have distinct wire meanings.
          encryptedContent: Schema.optional(Schema.NullOr(Schema.String)),
          status: Schema.optional(EvidenceStatusSchema),
        }),
        Schema.Struct({
          kind: Schema.Literal('anthropic-thinking-signature'),
          signature: Schema.String,
        }),
        Schema.Struct({
          kind: Schema.Literal('anthropic-redacted-thinking'),
          data: Schema.String,
        }),
      ]),
    ),
  }),
  LocalCallPartSchema,
]);

export const ContentSchema = Schema.Array(OutputPartSchema);
export const EditorContentSchema = Schema.Array(
  Schema.Union([
    MessagePartSchema.mapFields(Struct.omit(['evidence'])).mapFields(
      Struct.assign({ content: Schema.Array(TextPartSchema) }),
    ),
    LocalCallPartSchema.mapFields(Struct.omit(['evidence'])),
  ]),
);
export const EVIDENCE_PROTOCOL = {
  'google-interactions-thought-signature': 'google-interactions',
  'openai-responses-message': 'openai-responses',
  'openai-responses-reasoning': 'openai-responses',
  'openai-responses-function-call': 'openai-responses',
  'anthropic-thinking-signature': 'anthropic-messages',
  'anthropic-redacted-thinking': 'anthropic-messages',
  google: 'google-interactions',
  anthropic: 'anthropic-messages',
  xai: 'openai-responses',
  'google-interactions': 'google-interactions',
  'openai-responses': 'openai-responses',
} as const;

/** The schema issues in a turn's content against its origin: foreign
 *  evidence, malformed signed thinking, repeated item or call ids. */
export function validateAssistantContent(
  origin: ModelOrigin | null,
  content: typeof ContentSchema.Type,
): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = [];
  const ids = new Set<string>();
  const itemIds = new Set<string>();
  for (const [index, part] of content.entries()) {
    const evidence = part.evidence;
    if (
      evidence != null &&
      origin?.protocol !== EVIDENCE_PROTOCOL[evidence.kind]
    ) {
      issues.push({
        path: ['content', index],
        issue:
          'Provider content evidence requires its original protocol binding.',
      });
    }
    if (
      part.kind === 'reasoning' &&
      ((evidence?.kind === 'anthropic-thinking-signature' &&
        (part.summary.length !== 0 || part.content?.length !== 1)) ||
        (evidence?.kind === 'anthropic-redacted-thinking' &&
          (part.summary.length !== 0 || part.content !== undefined)))
    ) {
      issues.push({
        path: ['content', index],
        issue:
          'Signed thinking preserves one exact returned text field; redacted thinking keeps its content in provider evidence.',
      });
    }
    if (
      evidence != null &&
      'itemId' in evidence &&
      evidence.itemId !== undefined
    ) {
      if (itemIds.has(evidence.itemId)) {
        issues.push({
          path: ['content', index, 'evidence', 'itemId'],
          issue: 'Provider item IDs must be distinct within one response.',
        });
      }
      itemIds.add(evidence.itemId);
    }
    if (part.kind !== 'local-call') continue;
    if (ids.has(part.providerCallId)) {
      issues.push({
        path: ['content', index, 'providerCallId'],
        issue: 'Provider call IDs must be distinct within one response.',
      });
    }
    ids.add(part.providerCallId);
  }
  return issues;
}

/** The assistant message: a turn's content with its origin. */
export const AssistantMessageSchema = Schema.Struct({
  role: Schema.Literal('assistant'),
  /** `null` when no model produced the content (a handed-down call). */
  origin: Schema.NullOr(ModelOriginSchema),
  content: ContentSchema,
}).check(
  Schema.makeFilter((message) => {
    const issues = validateAssistantContent(message.origin, message.content);
    if (message.origin?.protocol === 'vscode-lm') {
      const parsed = Schema.decodeUnknownResult(EditorContentSchema)(
        message.content,
      );
      if (!Result.isSuccess(parsed))
        issues.push({ path: ['content'], issue: parsed.failure.issue });
    }
    return issues;
  }),
);
/** The content one turn produced, stamped with the turn's origin. */
export type AssistantMessage = typeof AssistantMessageSchema.Type;

/** One message of the history a turn sends (user, assistant, tool, system). */
export const MessageSchema = Schema.Union([
  Schema.Struct({
    role: Schema.Literal('user'),
    content: Schema.Array(InputPartSchema).check(Schema.isMinLength(1)),
  }),
  AssistantMessageSchema,
  Schema.Struct({
    role: Schema.Literal('tool'),
    results: Schema.Array(
      Schema.Struct({
        callOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        status: Schema.Literals(['success', 'error']),
        content: Schema.Array(InputPartSchema),
      }),
    ).check(Schema.isMinLength(1)),
  }),
  /** An instruction the run's context adds mid-conversation, after the
   *  system text its requests freeze: sent as the protocol's own system
   *  message where the binding takes one, otherwise as `systemUpdateText`. */
  Schema.Struct({
    role: Schema.Literal('system'),
    text: Schema.String.check(Schema.isMinLength(1)),
  }),
]);

/** A mid-conversation system message as the user text any protocol takes. */
export const systemUpdateText = (text: string): string =>
  `<system-update>\n${text}\n</system-update>`;

/** The history a turn sends, under the prepared-history rules. */
export const PreparedHistorySchema = Schema.Array(MessageSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter(checkPreparedHistory),
);
type HistoryMessage = typeof MessageSchema.Type;

/**
 * The history every codec lowers for a turn bound to `turn`: what another
 * model of the turn's own protocol wrote (a mid-run model switch) replays as
 * plain content, without that model's reasoning, item ids or refusal
 * marking, none of which the new model can take. An assistant entry that
 * leaves nothing is dropped, and the user entries it separated are joined.
 * Another protocol's evidence passes through for the codec to refuse. Below
 * the resolved turn, so the recorded request is not what changes.
 */
export function replayableHistory(
  messages: readonly HistoryMessage[],
  turn: ModelOrigin,
): readonly HistoryMessage[] {
  const out: HistoryMessage[] = [];
  let dropped = false;
  for (const message of messages) {
    let next = message;
    if (
      message.role === 'assistant' &&
      message.origin?.protocol === turn.protocol &&
      !sameModelOrigin(message.origin, turn)
    ) {
      const content = message.content.flatMap(
        (part): (typeof message.content)[number][] => {
          if (part.kind === 'reasoning') return [];
          const { evidence: _, ...plain } = part;
          if (plain.kind === 'local-call') return [plain];
          return [
            {
              ...plain,
              content: plain.content.map(({ text }) => ({
                kind: 'text' as const,
                text,
              })),
            },
          ];
        },
      );
      dropped = content.length === 0;
      if (dropped) continue;
      next = { ...message, content };
    }
    const previous = out.at(-1);
    if (dropped && next.role === 'user' && previous?.role === 'user') {
      dropped = false;
      out[out.length - 1] = {
        role: 'user',
        content: [...previous.content, ...next.content],
      };
      continue;
    }
    dropped = false;
    out.push(next);
  }
  return out;
}
const PrefixSchema = Schema.Struct({
  coveredMessages: Schema.Int.check(Schema.isGreaterThan(0)),
  prefixFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const GoogleContinuationSchema = PrefixSchema.mapFields(
  Struct.assign({
    origin: OriginSchema.mapFields(
      Struct.assign({
        protocol: Schema.Literal('google-interactions'),
      }),
    ),
    anchor: Schema.Struct({
      interactionId: Schema.String.check(Schema.isMinLength(1)),
      coveredSteps: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  }),
);
const ResponsesAnchorSchema = Schema.Struct({
  responseId: Schema.String.check(Schema.isMinLength(1)),
  coveredItems: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export const ResponsesContinuationSchema = PrefixSchema.mapFields(
  Struct.assign({
    origin: OriginSchema.mapFields(
      Struct.assign({
        protocol: Schema.Literal('openai-responses'),
      }),
    ),
    // Only a stored anchor is durable: a connection-scoped one dies with its
    // socket, so a persisted value must not be able to carry one.
    anchor: ResponsesAnchorSchema.mapFields(
      Struct.assign({
        kind: Schema.Literal('stored'),
      }),
    ),
  }),
);
/** Provider acceleration of an exact prefix, never the conversation authority. */
export const ContinuationSchema = Schema.Union([
  GoogleContinuationSchema,
  ResponsesContinuationSchema,
]);
/** {@link ContinuationSchema}'s value. */
export type Continuation = typeof ContinuationSchema.Type;
