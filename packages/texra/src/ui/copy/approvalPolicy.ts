/**
 * The approval policy in the user's words: each policy's label and
 * description, and the order selectors list them in. Copy, not policy: the
 * policy itself is the harness's (`ApprovalPolicy` in
 * `@texra-ai/harness/schemas`).
 */
import type { ApprovalPolicy } from '@texra-ai/harness/schemas';

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

/** Display order for selectors; must stay a permutation of `APPROVAL_POLICIES`. */
const APPROVAL_POLICY_DISPLAY_ORDER = [
  'ask',
  'never',
  'yolo',
] as const satisfies ReadonlyArray<ApprovalPolicy>;

export const APPROVAL_POLICY_OPTIONS = Object.freeze(
  APPROVAL_POLICY_DISPLAY_ORDER.map((value) =>
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
