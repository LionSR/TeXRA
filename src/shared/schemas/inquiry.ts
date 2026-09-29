/**
 * Inquiry schemas.
 *
 * The model-facing tool is named `inquiry`; these schemas share its plain
 * `Inquiry…` vocabulary. The canonical storage implementation lives in
 * `src/controllers/session/inquiryRecords.ts`.
 */
import { z } from 'zod';

import { RunIdSchema } from './identifiers';
import type { SessionEvent, SessionEventDraft } from './sessionEvent';

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

export const InquiryThreadSummarySchema = z.object({
  threadId: InquiryThreadIdSchema,
  /** The run the last question was asked under; continuations flow back to it. */
  parentRunId: RunIdSchema.nullable(),
  status: InquiryThreadStatusSchema,
  lastQuestionPreview: z.string(),
  lastActivityIso: z.iso.datetime(),
  turnCount: z.int().nonnegative(),
});
export type InquiryThreadSummary = z.infer<typeof InquiryThreadSummarySchema>;

// ============================================================================
// Draft persistence — open-turn textarea state, debounced
// ============================================================================

export const InquiryDraftSchema = z.object({
  answer: z.string(),
  sessionLinks: z.string(),
});
export type InquiryDraft = z.infer<typeof InquiryDraftSchema>;

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

const InquiryThreadRecordShape = {
  threadId: InquiryThreadIdSchema,
  /** The run the last question was asked under; a continuation is addressed to it. */
  parentRunId: RunIdSchema.nullable(),
  status: InquiryThreadStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
};

/** Canonical thread record: explicit `status` + the asking run. */
export const InquiryThreadRecordSchema = z.object(InquiryThreadRecordShape);
export type InquiryThreadRecord = z.infer<typeof InquiryThreadRecordSchema>;

/**
 * Refuse an inquiry update its thread's latest row does not admit. Returns
 * whether the update opens the thread (its first row, or a reopen of an
 * answered one), which is when it needs an owned open parent.
 */
export function validateInquiryTransition(
  previous: SessionEvent | undefined,
  draft: Extract<SessionEventDraft, { type: 'inquiryThreadUpdated' }>,
): boolean {
  if (previous === undefined) return true;
  if (previous.type !== 'inquiryThreadUpdated') {
    throw new Error(`Invalid inquiry history: ${draft.aggregateId}`);
  }
  const reopened = previous.status === 'answered' && draft.status === 'open';
  if (draft.turnCount < previous.turnCount) {
    throw new Error(
      `Inquiry update must preserve turn order: ${draft.threadId}`,
    );
  }
  if (reopened && draft.turnCount <= previous.turnCount) {
    throw new Error(`Inquiry reopen must advance the turn: ${draft.threadId}`);
  }
  if (previous.parentRunId !== draft.parentRunId && !reopened) {
    throw new Error(
      `Only an answered inquiry can change parents: ${draft.aggregateId}`,
    );
  }
  if (
    previous.status === 'open' &&
    draft.status === 'open' &&
    previous.turnCount !== draft.turnCount
  ) {
    throw new Error(
      `An open inquiry cannot start another turn: ${draft.aggregateId}`,
    );
  }
  if (previous.status === 'dropped' && draft.status !== 'dropped') {
    throw new Error(`A dropped inquiry cannot reopen: ${draft.aggregateId}`);
  }
  return reopened;
}
