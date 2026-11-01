/**
 * The session's approvals (`Approvals`), and how the bash and tool-edit
 * approvals word a declined request. Host-neutral.
 */

import { Context } from 'effect';
import type { RefusalDecision } from '@shared/schemas';
import type { ApprovalsWithPermission } from './sessionApprovals';

/** The session's approvals: approval policy, prompt lanes and each run's
 *  grants. */
export class Approvals extends Context.Service<
  Approvals,
  ApprovalsWithPermission
>()('@texra-ai/harness/session/Approvals') {}

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
