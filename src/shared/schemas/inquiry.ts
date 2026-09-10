/**
 * Inquiry schemas.
 *
 * The model-facing tool is named `inquiry`; these schemas share its plain
 * `Inquiry…` vocabulary. The canonical storage implementation lives in
 * `src/controllers/session/inquiryRecords.ts`.
 */
import { z } from 'zod';

import { RunIdSchema, StreamTabIdSchema } from './identifiers';

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

// ============================================================================
// Status + summary
// ============================================================================

const InquiryThreadStatusSchema = z.enum(['open', 'answered', 'dropped']);
export type InquiryThreadStatus = z.infer<typeof InquiryThreadStatusSchema>;

const InquiryThreadSummarySchema = z.object({
  threadId: InquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema.nullable(),
  status: InquiryThreadStatusSchema,
  lastQuestionPreview: z.string(),
  lastActivityIso: z.iso.datetime(),
  turnCount: z.int().nonnegative(),
});
export type InquiryThreadSummary = z.infer<typeof InquiryThreadSummarySchema>;

// ============================================================================
// Resume outcome — UI badge metadata for inquiryThreadUpdated events
// ============================================================================

const InquiryResumeOutcomeSchema = z.enum([
  'sent',
  'queued',
  'parent_finished',
]);
export type InquiryResumeOutcome = z.infer<typeof InquiryResumeOutcomeSchema>;

export const InquiryThreadUpdatedEventSchema =
  InquiryThreadSummarySchema.extend({
    resumeOutcome: InquiryResumeOutcomeSchema.nullish(),
  });
export type InquiryThreadUpdatedEvent = z.infer<
  typeof InquiryThreadUpdatedEventSchema
>;

// ============================================================================
// Action payloads — sent from inquiry panel to the host (keyed by threadId)
// ============================================================================

const InquirySubmitActionSchema = z.object({
  action: z.literal('submit'),
  threadId: InquiryThreadIdSchema,
  turnIndex: z.int().positive(),
  answer: z.string().min(1),
  sessionLinks: InquirySessionLinksSchema.nullish(),
});

const InquiryDropActionSchema = z.object({
  action: z.literal('drop'),
  threadId: InquiryThreadIdSchema,
  turnIndex: z.int().positive(),
  feedback: z.string().optional(),
});

const InquiryActionMessageSchema = z.discriminatedUnion('action', [
  InquirySubmitActionSchema,
  InquiryDropActionSchema,
]);
export type InquiryActionMessage = z.infer<typeof InquiryActionMessageSchema>;

// ============================================================================
// Draft persistence — open-turn textarea state, debounced
// ============================================================================

export const InquiryDraftSchema = z.object({
  answer: z.string(),
  sessionLinks: z.string(),
});
export type InquiryDraft = z.infer<typeof InquiryDraftSchema>;

export const InquiryTranscriptTurnSchema = z.object({
  turnIndex: z.int().positive(),
  timestamp: z.string().min(1),
  question: z.string(),
  context: z.string().nullish(),
  answer: z.string().nullish(),
  answeredAt: z.string().nullish(),
  sessionLinks: InquirySessionLinksSchema.nullish(),
});
export type InquiryTranscriptTurn = z.infer<typeof InquiryTranscriptTurnSchema>;

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

const ExternalInquiryTurnRecordSchema = z.discriminatedUnion('kind', [
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
]);

const InquiryThreadRecordShape = {
  threadId: InquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema.nullable(),
  /**
   * The execution the last question was asked under. A continuation is
   * addressed to it: a stream re-run under a new execution never receives
   * an answer meant for the old one.
   */
  parentExecutionId: RunIdSchema.nullable(),
  status: InquiryThreadStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
};

/**
 * Canonical thread record: explicit `status` + `parentStreamId` +
 * `parentExecutionId`.
 */
export const InquiryThreadRecordSchema = z.object(InquiryThreadRecordShape);
export type InquiryThreadRecord = z.infer<typeof InquiryThreadRecordSchema>;
