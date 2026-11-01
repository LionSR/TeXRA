/**
 * How the bash and tool-edit approvals word a declined request. Pure and
 * host-neutral: it reaches `@shared/schemas` and nothing else.
 */

import type { RefusalDecision } from '@shared/schemas';

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
