/**
 * The one decision vocabulary for everything a run asks a person (one run
 * model, section 3.7). A run opens a request with `request.opened` and a
 * surface answers it with `request.decided { requestId, decision }`; pending
 * is the fold, opened without decided. Every kind of request
 * (`PermissionPayload['kind']`) is answered with an arm of this union, so the
 * frontend action vocabulary, the runtime's reading, and the recovery
 * bindings (`model-retry`, `tool-outcome`) read one word.
 *
 * The three refusal arms are the three provenances a declined request can
 * have, each carrying the fact that names it: `reject` is a person declining
 * (with optional feedback for the agent), `deny` is a policy or a headless
 * host with no person to ask (`reason`), and `cancel` is an automatic close
 * (the run ended, the session was disposed) with its `cause`.
 */
import { z } from 'zod';

import { UserQuestionAnswersSchema } from './prompts';

export const RequestDecisionSchema = z.discriminatedUnion('action', [
  /** A plain approval. A proposal's approve may rebind its model or agent;
   *  a tool edit's approve carries the proposed file as the user left it in
   *  the host's diff view. */
  z.object({
    action: z.literal('approve'),
    model: z.string().nullish(),
    agent: z.string().nullish(),
    content: z.string().nullish(),
  }),
  z.object({
    action: z.literal('approve_and_goal'),
    autoApproveAll: z.literal(true).nullish(),
  }),
  /** A proposal opened for editing instead of run. */
  z.object({ action: z.literal('setup') }),
  /** A user question's answers, keyed by question text. */
  z.object({ action: z.literal('submit'), answers: UserQuestionAnswersSchema }),
  /** An inquiry's answer, pasted back from the external model. */
  z.object({
    action: z.literal('answer'),
    answer: z.string(),
    sessionLinks: z.array(z.string()).nullish(),
  }),
  z.object({ action: z.literal('skip'), feedback: z.string().nullish() }),
  /** A retry, on the configured credentials or on the user's own key once
   *  the host has stored one (`credentials: 'personal'`). */
  z.object({
    action: z.literal('retry'),
    feedback: z.string().nullish(),
    credentials: z.enum(['configured', 'personal']).nullish(),
  }),
  z.object({ action: z.literal('reject'), feedback: z.string().nullish() }),
  z.object({ action: z.literal('deny'), reason: z.string() }),
  z.object({ action: z.literal('cancel'), cause: z.string().nullish() }),
]);
export type RequestDecision = z.infer<typeof RequestDecisionSchema>;

/** The arms that decline a request, whatever the provenance. */
export type RequestRefusal = Extract<
  RequestDecision,
  { action: 'reject' | 'deny' | 'cancel' }
>;

export function isRequestRefusal(
  decision: RequestDecision,
): decision is RequestRefusal {
  return (
    decision.action === 'reject' ||
    decision.action === 'deny' ||
    decision.action === 'cancel'
  );
}
