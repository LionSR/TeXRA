/**
 * How the bash and tool-edit approvals word a declined request.
 * Host-neutral.
 */

import type { RefusalDecision, ToolResult } from '@shared/schemas';
import { errorResult } from '@tools/core/result';

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

/**
 * The result a call answers with when its request about `target` is
 * declined: `rejected` for a person's reject, else the summary followed by
 * `target`; a deny's or cancel's reason after it, and a reject's feedback as
 * the instruction the model reads.
 */
export function refusalResult(
  subject: string,
  refusal: RefusalDecision,
  wording: { readonly rejected: string; readonly target: string },
): ToolResult {
  const copy = refusalCopy(subject, refusal);
  const summary =
    refusal.action === 'reject'
      ? wording.rejected
      : `${copy.summary}: ${wording.target}`;
  return errorResult(copy.detail ? `${summary}\n\n${copy.detail}` : summary, {
    summary,
    ...(copy.feedback && { userInstruction: copy.feedback }),
  });
}
