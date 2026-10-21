/**
 * How a run reads a person's answer to a request it asked: a decision it
 * does not accept is the refusal it is, and a refusal has one wording. The
 * request tools (bash, tool edit, plan, proposal, user question)
 * read their answers through here.
 *
 * Pure and host-neutral: it reaches `@shared/schemas` and nothing else.
 */

import type {
  PermissionPayload,
  RequestDecision,
  RefusalDecision,
} from '@shared/schemas';

/**
 * A decision that is not one the caller accepts, read as the refusal it is
 * or, for an arm the request's kind never offered (a surface defect), as a
 * loud denial naming it: a run never proceeds on an answer it cannot read.
 */
export function refusalOf(
  kind: PermissionPayload['kind'],
  decision: RequestDecision,
): RefusalDecision {
  if (
    decision.action === 'reject' ||
    decision.action === 'deny' ||
    decision.action === 'cancel'
  ) {
    return decision;
  }
  return {
    action: 'deny',
    reason: `The ${kind} request was answered with "${decision.action}", which it does not offer.`,
  };
}

/**
 * The one wording of a declined request, over the union's three refusal
 * arms: what the summary says about `subject` (a command, a plan, a
 * delegation), the detail that names why, and the feedback a person left for
 * the agent, which only a `reject` carries.
 */
export function refusalCopy(
  subject: string,
  refusal: RefusalDecision,
): {
  readonly summary: string;
  readonly detail: string | undefined;
  readonly feedback: string | undefined;
} {
  const trimmed = (value: string | null | undefined) => {
    const text = value?.trim();
    return text ? text : undefined;
  };
  switch (refusal.action) {
    case 'deny':
      return {
        summary: `${subject} denied`,
        detail: trimmed(refusal.reason),
        feedback: undefined,
      };
    case 'cancel':
      return {
        summary: `${subject} cancelled`,
        detail: trimmed(refusal.cause),
        feedback: undefined,
      };
    case 'reject':
      return {
        summary: `${subject} rejected by the user`,
        detail: undefined,
        feedback: trimmed(refusal.feedback),
      };
  }
}
