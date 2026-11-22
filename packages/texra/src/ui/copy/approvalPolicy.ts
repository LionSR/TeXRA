/**
 * The approval policy in the user's words: each policy's label and
 * description, and the order selectors list them in. Copy, not policy: the
 * policy itself is the harness's (`ApprovalPolicy` in
 * `@texra-ai/worldline/schemas`).
 */
import { Record as EffectRecord } from 'effect';

import type { ApprovalPolicy } from '@texra-ai/worldline/schemas';
import { RUN_GRANT_TONE, type RunTone } from '@ui/copy/runStatus';

/** Each policy's copy, declared in the order selectors list them, and the
 *  tone a surface showing the policy paints it with: a policy that stops
 *  asking is a caution, as a run's own auto-approval is; `ask`, the
 *  default, has nothing to say. */
const APPROVAL_POLICY_COPY = {
  ask: {
    label: 'Ask',
    description: 'Ask before shell commands and file edits.',
    tone: undefined,
  },
  never: {
    label: 'Block',
    description: 'Block shell commands and file edits.',
    tone: 'warning',
  },
  yolo: {
    label: 'Auto-approve',
    description: 'Allow shell commands and file edits without asking.',
    tone: RUN_GRANT_TONE,
  },
} as const satisfies Record<
  ApprovalPolicy,
  {
    label: string;
    description: string;
    tone: RunTone | undefined;
  }
>;

export const APPROVAL_POLICY_OPTIONS = Object.freeze(
  EffectRecord.keys(APPROVAL_POLICY_COPY).map((value) =>
    Object.freeze({
      value,
      label: APPROVAL_POLICY_COPY[value].label,
      description: APPROVAL_POLICY_COPY[value].description,
    }),
  ),
);

/** The tone a policy paints with where it is shown; none for `ask`. */
export function approvalPolicyTone(
  policy: ApprovalPolicy,
): RunTone | undefined {
  return APPROVAL_POLICY_COPY[policy].tone;
}

/** The policy's user-facing name: `never` reads "Block" on every surface. */
export function approvalPolicyLabel(policy: ApprovalPolicy): string {
  return APPROVAL_POLICY_COPY[policy].label;
}

export function formatApprovalPolicy(policy: ApprovalPolicy): string {
  return APPROVAL_POLICY_COPY[policy].description;
}
