/**
 * Inquiry schemas.
 *
 * The model-facing tool is named `inquiry`. The internal storage and
 * frontend symbols still carry the `ExternalInquiry…` prefix for diff-
 * locality; renaming them is a mechanical follow-up.
 */
import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';

// ============================================================================
// Identifiers + session links (canonical home)
// ============================================================================

const ExternalInquirySessionLinkSchema = z.string().trim().min(1);
export const ExternalInquirySessionLinksSchema = z.array(
  ExternalInquirySessionLinkSchema,
);
export type ExternalInquirySessionLinks = z.infer<
  typeof ExternalInquirySessionLinksSchema
>;

export const ExternalInquiryThreadIdSchema = z
  .string()
  .regex(/^ei_[0-9a-f]{12}$/i, 'Invalid external inquiry thread ID')
  .transform((value) => value.toLowerCase());
export type ExternalInquiryThreadId = z.infer<
  typeof ExternalInquiryThreadIdSchema
>;

// ============================================================================
// Status + summary
// ============================================================================

export const InquiryThreadStatusSchema = z.enum([
  'open',
  'answered',
  'dropped',
]);
export type InquiryThreadStatus = z.infer<typeof InquiryThreadStatusSchema>;

export const ExternalInquiryThreadSummarySchema = z.object({
  threadId: ExternalInquiryThreadIdSchema,
  parentStreamId: StreamTabIdSchema.nullable(),
  status: InquiryThreadStatusSchema,
  lastQuestionPreview: z.string(),
  lastActivityIso: z.iso.datetime(),
  turnCount: z.int().nonnegative(),
});
export type ExternalInquiryThreadSummary = z.infer<
  typeof ExternalInquiryThreadSummarySchema
>;

// ============================================================================
// Resume outcome — UI badge metadata for inquiryThreadUpdated events
// ============================================================================

export const InquiryResumeOutcomeSchema = z.enum([
  'sent',
  'queued',
  'resumed',
  'parent_finished',
]);
export type InquiryResumeOutcome = z.infer<typeof InquiryResumeOutcomeSchema>;

export const InquiryThreadUpdatedEventSchema =
  ExternalInquiryThreadSummarySchema.extend({
    resumeOutcome: InquiryResumeOutcomeSchema.nullish(),
  });
export type InquiryThreadUpdatedEvent = z.infer<
  typeof InquiryThreadUpdatedEventSchema
>;

// ============================================================================
// Action payloads — sent from inquiry panel to the host (keyed by threadId)
// ============================================================================

export const InquiryActionMessageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('submit'),
    threadId: ExternalInquiryThreadIdSchema,
    answer: z.string().min(1),
    sessionLinks: ExternalInquirySessionLinksSchema.nullish(),
  }),
  z.object({
    action: z.literal('drop'),
    threadId: ExternalInquiryThreadIdSchema,
    feedback: z.string().optional(),
  }),
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
