// Third-party imports
import { Effect, Schema, Struct } from 'effect';

// Local imports - canonical protocol binding
import {
  CountSchema,
  TurnProtocolSchema,
  ModelOriginSchema,
  sameModelOrigin,
  type ModelOrigin,
} from './protocol.js';
import { ModelError } from './errors.js';

const TextPartSchema = Schema.Struct({
  kind: Schema.Literal('text'),
  text: Schema.String,
});
const MediaFieldsSchema = Schema.Struct({
  mimeType: Schema.NonEmptyString,
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
      itemId: Schema.NonEmptyString,
      status: EvidenceStatusSchema,
      phase: Schema.optional(
        Schema.NullOr(Schema.Literals(['commentary', 'final_answer'])),
      ),
    }),
  ),
});
const LocalCallPartSchema = Schema.Struct({
  kind: Schema.Literal('local-call'),
  providerCallId: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
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
      itemId: Schema.optional(Schema.NonEmptyString),
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
          signature: Schema.NonEmptyString,
        }),
        Schema.Struct({
          kind: Schema.Literal('openai-responses-reasoning'),
          itemId: Schema.NonEmptyString,
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
/** The protocol each kind of part evidence belongs to: a part carries it
 *  back only to the protocol that wrote it. */
const EVIDENCE_PROTOCOL = Object.freeze({
  'google-interactions-thought-signature': 'google-interactions',
  'openai-responses-message': 'openai-responses',
  'openai-responses-reasoning': 'openai-responses',
  'openai-responses-function-call': 'openai-responses',
  'anthropic-thinking-signature': 'anthropic-messages',
  'anthropic-redacted-thinking': 'anthropic-messages',
} as const satisfies Record<string, typeof TurnProtocolSchema.Type>);

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
  Schema.makeFilter((message) =>
    validateAssistantContent(message.origin, message.content),
  ),
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
        callOrdinal: CountSchema,
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
    text: Schema.NonEmptyString,
  }),
]);

/** A mid-conversation system message as the user text any protocol takes. */
export const systemUpdateText = (text: string): string =>
  `<system-update>\n${text}\n</system-update>`;

/** What the prepared-history rules read of an entry: its role, an
 *  assistant's local calls and a tool group's ordinals. Over any input-part
 *  shape, so a store that holds media by address checks the same rules. */
export type PreparedHistoryEntry =
  | { readonly role: 'user' | 'system' }
  | {
      readonly role: 'assistant';
      readonly content: readonly { readonly kind: string }[];
    }
  | {
      readonly role: 'tool';
      readonly results: readonly { readonly callOrdinal: number }[];
    };
/** The history a turn sends: each assistant's local calls answered by the
 *  next message, in call order. Only the next request needs them answered.
 *  Returns the schema issues found, one per offending message. */
export function checkPreparedHistory(
  messages: readonly PreparedHistoryEntry[],
): Schema.FilterIssue[] {
  const issues: Schema.FilterIssue[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant') {
      const calls = message.content.filter(
        (part) => part.kind === 'local-call',
      );
      if (calls.length === 0) continue;
      const results = messages[index + 1];
      if (
        results?.role !== 'tool' ||
        results.results.length !== calls.length ||
        !results.results.every(
          (result, ordinal) => result.callOrdinal === ordinal,
        )
      ) {
        issues.push({
          path: [index],
          issue:
            'Every local call requires one adjacent, complete, ordinal-ordered tool-result group before another generation.',
        });
      }
    } else if (message.role === 'tool') {
      const previous = messages[index - 1];
      if (
        previous?.role !== 'assistant' ||
        !previous.content.some((part) => part.kind === 'local-call')
      ) {
        issues.push({
          path: [index],
          issue:
            'Tool results require an immediately preceding calling assistant.',
        });
      }
    }
  }
  return issues;
}

/** The history a turn sends, under the prepared-history rules. */
export const PreparedHistorySchema = Schema.Array(MessageSchema).check(
  Schema.isMinLength(1),
  Schema.makeFilter(checkPreparedHistory),
);
type HistoryMessage = typeof MessageSchema.Type;

/** A tool message of the history. */
type ToolMessage = Extract<HistoryMessage, { readonly role: 'tool' }>;

/** A local call and the result that answers it. */
interface AnsweredCall {
  readonly call: typeof LocalCallPartSchema.Type;
  readonly result: ToolMessage['results'][number];
}

/** A history entry as a codec lowers it: a tool entry carries each result
 *  with the call it answers. */
type LowerableMessage =
  | Exclude<HistoryMessage, ToolMessage>
  | { readonly role: 'tool'; readonly answered: readonly AnsweredCall[] };

/** The content of what another model of the turn's protocol wrote, as the
 *  turn's model can take it: no reasoning, item ids or refusal marking. */
function plainContent(
  message: Extract<HistoryMessage, { readonly role: 'assistant' }>,
): typeof message.content {
  return message.content.flatMap((part): (typeof message.content)[number][] => {
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
  });
}

/**
 * The history every codec lowers for a turn bound to `turn`, from entry
 * `from` on (the entries before it are a stored continuation's):
 *
 * - each tool entry's results are paired with the calls they answer, the
 *   local calls of the assistant entry before it by `callOrdinal` (the
 *   pairing `checkPreparedHistory` requires); a result that answers no call
 *   is an invalid request;
 * - what another model of the turn's own protocol wrote (a mid-run model
 *   switch) replays as plain content, without that model's reasoning, item
 *   ids or refusal marking, none of which the new model can take. An
 *   assistant entry that leaves nothing is dropped, and the user entries it
 *   separated are joined. Another protocol's evidence passes through for the
 *   codec to refuse.
 *
 * Below the resolved turn, so the recorded request is not what changes.
 */
export const replayableHistory = Effect.fn('llm.replayableHistory')(function* (
  messages: readonly HistoryMessage[],
  turn: ModelOrigin,
  from = 0,
): Effect.fn.Return<readonly LowerableMessage[], ModelError> {
  const out: LowerableMessage[] = [];
  let dropped = false;
  for (const [index, message] of messages.entries()) {
    if (index < from) continue;
    let next: LowerableMessage;
    if (message.role === 'tool') {
      const previous = messages[index - 1];
      const calls =
        previous?.role === 'assistant'
          ? previous.content.flatMap((part) =>
              part.kind === 'local-call' ? [part] : [],
            )
          : [];
      const answered: AnsweredCall[] = [];
      for (const result of message.results) {
        const call =
          result.callOrdinal < 0 ? undefined : calls.at(result.callOrdinal);
        if (call === undefined)
          return yield* new ModelError({
            kind: 'invalid-request',
            message:
              'A tool result answers no local call of the assistant message before it.',
          });
        answered.push({ call, result });
      }
      next = { role: 'tool', answered };
    } else if (
      message.role === 'assistant' &&
      message.origin?.protocol === turn.protocol &&
      !sameModelOrigin(message.origin, turn)
    ) {
      const content = plainContent(message);
      dropped = content.length === 0;
      if (dropped) continue;
      next = { ...message, content };
    } else next = message;
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
});
const PrefixSchema = Schema.Struct({
  coveredMessages: Schema.Int.check(Schema.isGreaterThan(0)),
  prefixFingerprint: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export const GoogleContinuationSchema = PrefixSchema.mapFields(
  Struct.assign({
    origin: ModelOriginSchema.mapFields(
      Struct.assign({
        protocol: Schema.Literal('google-interactions'),
      }),
    ),
    anchor: Schema.Struct({
      interactionId: Schema.NonEmptyString,
      coveredSteps: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  }),
);
const ResponsesAnchorSchema = Schema.Struct({
  responseId: Schema.NonEmptyString,
  coveredItems: CountSchema,
});
export const ResponsesContinuationSchema = PrefixSchema.mapFields(
  Struct.assign({
    origin: ModelOriginSchema.mapFields(
      Struct.assign({
        protocol: Schema.Literal('openai-responses'),
      }),
    ),
    anchor: ResponsesAnchorSchema,
  }),
);
/** Provider acceleration of an exact prefix, never the conversation authority. */
export const ContinuationSchema = Schema.Union([
  GoogleContinuationSchema,
  ResponsesContinuationSchema,
]);
/** {@link ContinuationSchema}'s value. */
export type Continuation = typeof ContinuationSchema.Type;
