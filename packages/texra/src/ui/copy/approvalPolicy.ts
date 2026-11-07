/**
 * The approval policy in the user's words: each policy's label and
 * description, and the order selectors list them in. Copy, not policy: the
 * policy itself is the harness's (`ApprovalPolicy` in
 * `@texra-ai/harness/schemas`).
 */
import { Record as EffectRecord } from 'effect';

import type { ApprovalPolicy } from '@texra-ai/harness/schemas';

/** Each policy's copy, declared in the order selectors list them. */
const APPROVAL_POLICY_COPY = {
  ask: {
    label: 'Ask',
    description: 'Ask before shell commands and file edits.',
  },
  never: {
    label: 'Block',
    description: 'Block shell commands and file edits.',
  },
  yolo: {
    label: 'Auto-approve',
    description: 'Allow shell commands and file edits without asking.',
  },
} as const satisfies Record<
  ApprovalPolicy,
  {
    label: string;
    description: string;
  }
>;

export const APPROVAL_POLICY_OPTIONS = Object.freeze(
  EffectRecord.keys(APPROVAL_POLICY_COPY).map((value) =>
    Object.freeze({
      value,
      ...APPROVAL_POLICY_COPY[value],
    }),
  ),
);

/** The policy's user-facing name: `never` reads "Block" on every surface. */
export function approvalPolicyLabel(policy: ApprovalPolicy): string {
  return APPROVAL_POLICY_COPY[policy].label;
}

export function formatApprovalPolicy(policy: ApprovalPolicy): string {
  return APPROVAL_POLICY_COPY[policy].description;
}
