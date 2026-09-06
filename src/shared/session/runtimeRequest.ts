/**
 * The runtime request protocol (PRD one-fold-three-renderers, 8.2): one Zod
 * union of the requests a surface issues to its session's runtime and the
 * outcomes the runtime answers with. In process (the TUI, headless) the
 * Effect's own result is the response and no message exists; the envelope
 * and response a bridge posts (8.4) arrive with that bridge.
 *
 * Arm tags are `group.action` throughout, so two groups cannot claim one
 * tag. Every stream-scoped arm names a bare `streamId`: a `StreamTabId`
 * names one run for its whole life (decision 9), so a request that waits
 * while its stream is deleted can only miss, never land on a different run.
 * The union carries the arms the runtime answers today; a lane that routes
 * another retained command adds its arm with its handler.
 */
import { z } from 'zod';

import { APPROVAL_BYPASS_KINDS } from '@shared/approvalBypassKind';
import {
  InquiryThreadIdSchema,
  StreamTabIdSchema,
  UserQuestionAnswersSchema,
} from '@shared/schemas';

const streamScoped = { streamId: StreamTabIdSchema };

/** A decision names the stream its `approval.requested` carries and the
 *  `approvalId` that fact carries: domain identity, never the envelope's
 *  correlation id. */
const decision = { ...streamScoped, approvalId: z.string().min(1) };

const RejectionSchema = z.object({
  action: z.literal('reject'),
  feedback: z.string().nullish(),
});

export const RuntimeRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('stream.stop'),
    ...streamScoped,
    detachActiveChildren: z.boolean().nullish(),
  }),
  z.object({ kind: z.literal('stream.delete'), ...streamScoped }),
  z.object({ kind: z.literal('stream.compact'), ...streamScoped }),
  z.object({
    kind: z.literal('followUp.send'),
    ...streamScoped,
    text: z.string().min(1),
    displayText: z.string().nullish(),
    mediaFiles: z.array(z.string()).nullish(),
  }),
  z.object({
    kind: z.literal('decision.bash'),
    ...decision,
    decision: z.discriminatedUnion('action', [
      z.object({ action: z.literal('approve') }),
      RejectionSchema,
    ]),
  }),
  z.object({
    kind: z.literal('decision.plan'),
    ...decision,
    decision: z.discriminatedUnion('action', [
      z.object({ action: z.literal('approve') }),
      z.object({
        action: z.literal('approve_and_goal'),
        autoApproveAll: z.literal(true).nullish(),
      }),
      RejectionSchema,
    ]),
  }),
  z.object({
    kind: z.literal('decision.proposal'),
    ...decision,
    decision: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('approve'),
        model: z.string().nullish(),
        agent: z.string().nullish(),
      }),
      RejectionSchema,
      z.object({ action: z.literal('setup') }),
    ]),
  }),
  z.object({
    kind: z.literal('decision.userQuestion'),
    ...decision,
    decision: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('submit'),
        answers: UserQuestionAnswersSchema,
      }),
      RejectionSchema,
      z.object({ action: z.literal('skip'), feedback: z.string().nullish() }),
    ]),
  }),
  /** A retry runs the run's client preparation before it settles: on the
   *  configured credentials, or on the user's own key once the host has
   *  stored one (`credentials: 'personal'`, the host's `useOwnApiKey`). */
  z.object({
    kind: z.literal('decision.retry'),
    ...decision,
    decision: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('retry'),
        feedback: z.string().nullish(),
        credentials: z.enum(['configured', 'personal']).nullish(),
      }),
      z.object({ action: z.literal('cancel') }),
    ]),
  }),
  /** An external inquiry's terminal answers: persisted on the thread, then
   *  the run continues from it. The aggregate is the thread; the stream is
   *  the run the thread belongs to. */
  z.object({
    kind: z.literal('externalInquiry.submit'),
    ...streamScoped,
    threadId: InquiryThreadIdSchema,
    turnIndex: z.int().positive(),
    answer: z.string(),
    sessionLinks: z.array(z.string()).nullish(),
  }),
  z.object({
    kind: z.literal('externalInquiry.drop'),
    ...streamScoped,
    threadId: InquiryThreadIdSchema,
    turnIndex: z.int().positive(),
    feedback: z.string().nullish(),
  }),
  /** The field-level mutation, not a snapshot: the authority applies it and
   *  publishes the resulting `approval.policy` (PRD 6, item 2). */
  z.object({
    kind: z.literal('policy.set'),
    change: z.object({
      field: z.literal('bypass'),
      ...streamScoped,
      bypass: z.enum(APPROVAL_BYPASS_KINDS),
      enabled: z.boolean(),
    }),
  }),
  /** A workflow-script run's grandchild `agent()` call, by the execution id
   *  the child list, focus, and kill already share. */
  z.object({
    kind: z.literal('workflow.control'),
    ...streamScoped,
    executionId: z.string().min(1),
    action: z.enum(['skip', 'retry']),
  }),
]);
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

/** What the runtime answers with: a typed value the host renders. */
export const OutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('done') }),
  z.object({
    kind: z.literal('followUp'),
    status: z.enum(['sent', 'queued']),
    /** A queued input whose recovery wake did not reach the run. */
    wake: z.literal('failed').nullish(),
  }),
  z.object({
    kind: z.literal('deleted'),
    result: z.enum(['deleted', 'active', 'failed', 'superseded']),
  }),
]);
export type Outcome = z.infer<typeof OutcomeSchema>;
