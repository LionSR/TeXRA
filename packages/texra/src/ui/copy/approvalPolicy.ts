/**
 * The approval policy in the user's words: each policy's label and
 * description, and the order selectors list them in. Copy, not policy: the
 * policy itself is the harness's (`ApprovalPolicy` in
 * `@texra-ai/worldline/schemas`).
 */
import { Record as EffectRecord } from 'effect';

import {
  APPROVAL_POLICY_SETTING,
  type ApprovalPolicy,
} from '@texra-ai/worldline/schemas';

/** Each policy's name is the setting row's, which `/config` lists. */
const labels = APPROVAL_POLICY_SETTING.choices;

/** Each policy's copy, declared in the order selectors list them. */
const APPROVAL_POLICY_COPY = {
  yolo: {
    label: labels.yolo.label,
    description: 'Allow shell commands and file edits without asking.',
  },
  ask: {
    label: labels.ask.label,
    description: 'Ask before shell commands and file edits.',
  },
} as const satisfies Record<
  ApprovalPolicy,
  { label: string; description: string }
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

/** The policy's user-facing name, the same on every surface. */
export function approvalPolicyLabel(policy: ApprovalPolicy): string {
  return APPROVAL_POLICY_COPY[policy].label;
}

export function formatApprovalPolicy(policy: ApprovalPolicy): string {
  return APPROVAL_POLICY_COPY[policy].description;
}

/** The line that states a policy and whose it is: the project's stored
 *  policy, or the one this chat was launched with (`/approval`). */
export const APPROVAL_POLICY_LINE = Object.freeze({
  project: (policy: ApprovalPolicy) =>
    `Project approval policy: ${formatApprovalPolicy(policy)}`,
  chat: (policy: ApprovalPolicy) =>
    `Approval mode: ${formatApprovalPolicy(policy)}`,
});
