/**
 * Inquiry schemas.
 *
 * The model-facing tool is named `inquiry`; these schemas share its plain
 * `Inquiry…` vocabulary (the internal storage layer lives in
 * `src/tools/inquiry/`).
 */
import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';

// ============================================================================
// Identifiers + session links (canonical home)
// ============================================================================

export const InquirySessionLinksSchema = z.array(z.string().trim().min(1));

// Keep the 12-hex suffix aligned with hexId12(), the identifier-minting owner
// used by externalInquiryStorage. The explicit bound rejects truncated or
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
  'resumed',
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

export const InquirySubmitActionSchema = z.object({
  action: z.literal('submit'),
  threadId: InquiryThreadIdSchema,
  answer: z.string().min(1),
  sessionLinks: InquirySessionLinksSchema.nullish(),
});

export const InquiryDropActionSchema = z.object({
  action: z.literal('drop'),
  threadId: InquiryThreadIdSchema,
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
