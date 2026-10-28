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

export const InquirySessionLinksSchema = Schema.Array(
  Schema.Trim.check(Schema.isMinLength(1)),
);

// The inquiry record service mints the 12-hex suffix. The explicit bound
// rejects truncated or extended identifiers at storage and tool-input
// boundaries.
export const InquiryThreadIdSchema = Schema.String.check(
  Schema.isPattern(/^ei_[0-9a-f]{12}$/i),
).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => value.toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
);
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
export type OpenInquiryTurn = typeof OpenInquiryTurnSchema.Type;

/** Answer recorded and available inline. */
const AnsweredInquiryTurnSchema = Schema.Struct({
  ...InquiryTurnBaseShape,
  kind: Schema.Literal('answered'),
  answer: Schema.String,
  answeredAt: Schema.String.check(Schema.isMinLength(1)),
  sessionLinks: Schema.optional(Schema.NullOr(InquirySessionLinksSchema)),
});
export type AnsweredInquiryTurn = typeof AnsweredInquiryTurnSchema.Type;

export const ExternalInquiryTurnRecordSchema = Schema.Union([
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
]);
