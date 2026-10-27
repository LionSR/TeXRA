/**
 * Inquiry schemas.
 *
 * The model-facing tool is named `inquiry`; these schemas share its plain
 * `Inquiry…` vocabulary. The app that ships the tool stores them.
 */
import { Schema, SchemaGetter } from 'effect';

// ============================================================================
// Identifiers + session links (canonical home)
// ============================================================================

/**
 * Links to the sessions an answer was researched in, one non-empty string
 * each; an answered inquiry turn and the inquiry approval prompt both carry
 * them.
 */
export const InquirySessionLinksSchema = Schema.Array(
  Schema.Trim.check(Schema.isMinLength(1)),
);

// Keep the 12-hex suffix aligned with hexId12(), the identifier-minting owner
// used by the inquiry record service. The explicit bound rejects truncated or
// extended identifiers at storage and tool-input boundaries.
/**
 * An inquiry thread's id: `ei_` and twelve hex digits, lower-cased on decode
 * so the same thread is never stored under two spellings.
 */
export const InquiryThreadIdSchema = Schema.String.check(
  Schema.isPattern(/^ei_[0-9a-f]{12}$/i),
).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => value.toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
);
/** The decoded shape of {@link InquiryThreadIdSchema}. */
export type InquiryThreadId = typeof InquiryThreadIdSchema.Type;

/** Full global inquiry records, independent of project display lifetimes. */
const InquiryTurnBaseShape = {
  turnIndex: Schema.Int.check(Schema.isGreaterThan(0)),
  timestamp: Schema.String.check(Schema.isMinLength(1)),
  question: Schema.String,
  context: Schema.optional(Schema.NullOr(Schema.String)),
  suggestSearch: Schema.optional(Schema.NullOr(Schema.Boolean)),
  attachFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
};

/** Awaiting a user answer. Panel drafts belong to view state. */
const OpenInquiryTurnSchema = Schema.Struct({
  ...InquiryTurnBaseShape,
  kind: Schema.Literal('open'),
});
/** The decoded shape of an inquiry turn that still awaits the user's answer. */
export type OpenInquiryTurn = typeof OpenInquiryTurnSchema.Type;

/** Answer recorded and available inline. */
const AnsweredInquiryTurnSchema = Schema.Struct({
  ...InquiryTurnBaseShape,
  kind: Schema.Literal('answered'),
  answer: Schema.String,
  answeredAt: Schema.String.check(Schema.isMinLength(1)),
  sessionLinks: Schema.optional(Schema.NullOr(InquirySessionLinksSchema)),
});
/** The decoded shape of an inquiry turn whose answer has been recorded. */
export type AnsweredInquiryTurn = typeof AnsweredInquiryTurnSchema.Type;

/**
 * One turn of an inquiry thread as the inquiry record store keeps it: a
 * question still open, or one with its answer. The `inquiry` tool writes a
 * turn; the inquiry panel reads the thread.
 */
export const ExternalInquiryTurnRecordSchema = Schema.Union([
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
]);
