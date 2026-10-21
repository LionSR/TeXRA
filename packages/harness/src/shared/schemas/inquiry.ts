/**
 * Inquiry schemas.
 *
 * The model-facing tool is named `inquiry`; these schemas share its plain
 * `Inquiry…` vocabulary. The app that ships the tool stores them.
 */
import { z } from 'zod';

// ============================================================================
// Identifiers + session links (canonical home)
// ============================================================================

export const InquirySessionLinksSchema = z.array(z.string().trim().min(1));

// Keep the 12-hex suffix aligned with hexId12(), the identifier-minting owner
// used by the inquiry record service. The explicit bound rejects truncated or
// extended identifiers at storage and tool-input boundaries.
export const InquiryThreadIdSchema = z
  .string()
  .regex(/^ei_[0-9a-f]{12}$/i, 'Invalid external inquiry thread ID')
  .transform((value) => value.toLowerCase());
export type InquiryThreadId = z.infer<typeof InquiryThreadIdSchema>;

/** Full global inquiry records, independent of project display lifetimes. */
const InquiryTurnBaseShape = {
  turnIndex: z.int().positive(),
  timestamp: z.string().min(1),
  question: z.string(),
  context: z.string().nullish(),
  suggestSearch: z.boolean().nullish(),
  attachFiles: z.array(z.string()).nullish(),
};

/** Awaiting a user answer. Panel drafts belong to view state. */
const OpenInquiryTurnSchema = z.object({
  ...InquiryTurnBaseShape,
  kind: z.literal('open'),
});
export type OpenInquiryTurn = z.infer<typeof OpenInquiryTurnSchema>;

/** Answer recorded and available inline. */
const AnsweredInquiryTurnSchema = z.object({
  ...InquiryTurnBaseShape,
  kind: z.literal('answered'),
  answer: z.string(),
  answeredAt: z.string().min(1),
  sessionLinks: InquirySessionLinksSchema.nullish(),
});
export type AnsweredInquiryTurn = z.infer<typeof AnsweredInquiryTurnSchema>;

export const ExternalInquiryTurnRecordSchema = z.discriminatedUnion('kind', [
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
]);
