import { z } from 'zod';

export const APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export const ApprovalPolicySchema = z.enum(APPROVAL_POLICIES);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;
/**
 * The tolerant input form of {@link ApprovalPolicySchema}: the one place
 * a hand-written spelling (` Yolo `) is trimmed and lowercased before the
 * enum. Reached only through {@link parseApprovalPolicy}, which every
 * reader of typed-in text — `TEXRA_APPROVAL_POLICY`, `--approval-policy`,
 * `/approval`, the settings dropdown — calls. Persisted config values keep the
 * strict enum: the `texra.approvalPolicy` catalog row validates the stored
 * value for all three hosts and warns when it no longer parses, and the
 * dropdown's options are derived from that same `ZodEnum`.
 */
const ApprovalPolicyInputSchema = z.preprocess(
  (raw) => (typeof raw === 'string' ? raw.trim().toLowerCase() : raw),
  ApprovalPolicySchema,
);
export const APPROVAL_POLICY_DEFAULT: ApprovalPolicy = 'ask';
/**
 * The policy a `--no-input` run falls back to. Deliberately divergent from
 * {@link APPROVAL_POLICY_DEFAULT}: a run that cannot present a prompt
 * denies instead of hanging, and `buildCliContext` narrows the candidate list
 * to the explicit `--approval-policy` flag alone — a persisted or env-provided
 * `yolo` must not silently auto-approve a headless run that nobody is watching.
 * Changing that requires changing headless discipline, not just this constant.
 */
export const APPROVAL_POLICY_NO_INPUT_DEFAULT: ApprovalPolicy = 'never';
/** Canonical persisted spelling in `.texra/config.json` for every host. */
export const APPROVAL_POLICY_CONFIG_KEY = 'texra.approvalPolicy';
const APPROVAL_POLICY_DENIED_MESSAGE = 'Denied by the approval policy.';
const APPROVAL_UNPRESENTABLE_MESSAGE =
  'Interactive approval requires a prompt; this run cannot present one.';

export function parseApprovalPolicy(input: string): ApprovalPolicy | undefined {
  const parsed = ApprovalPolicyInputSchema.safeParse(input);
  return parsed.success ? parsed.data : undefined;
}

export type ApprovalPolicyDecision =
  'allow' | 'present' | 'deny-policy' | 'deny-unpresentable';

export function isApprovalDenied(
  decision: ApprovalPolicyDecision,
): decision is 'deny-policy' | 'deny-unpresentable' {
  return decision === 'deny-policy' || decision === 'deny-unpresentable';
}

export function approvalPolicyDenialMessage(
  decision: 'deny-policy' | 'deny-unpresentable',
): string {
  return decision === 'deny-policy'
    ? APPROVAL_POLICY_DENIED_MESSAGE
    : APPROVAL_UNPRESENTABLE_MESSAGE;
}

/** Decide one Bash or tool-edit permission from request-time policy facts. */
export function decideApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly promptRequired: boolean;
  readonly scopedBypass: boolean;
  readonly canPresent: boolean;
}): ApprovalPolicyDecision {
  if (input.policy === 'never') return 'deny-policy';
  if (input.policy === 'yolo' || input.scopedBypass || !input.promptRequired) {
    return 'allow';
  }
  return input.canPresent ? 'present' : 'deny-unpresentable';
}

/**
 * What an approval-policy denial closed, as the session reports it to its
 * host: a command, edit or plan, a delegation proposal, the approval-gated
 * tools withheld from the model when the run resolved its tools, the human
 * retry permit after a model error, or a question the model asked the user;
 * and the policy that closed it, which a host names in what it says.
 */
export type ApprovalPolicyDenial = {
  readonly policy: ApprovalPolicy;
} & (
  | { readonly kind: 'executable' }
  | { readonly kind: 'plan' }
  | { readonly kind: 'proposal' }
  | { readonly kind: 'withheldTools'; readonly tools: readonly string[] }
  | {
      readonly kind: 'retry';
      readonly deny: Exclude<RetryApprovalDecision, 'present'>['deny'];
    }
  | {
      readonly kind: 'humanInput';
      readonly deny: Exclude<HumanInputDecision, 'present'>['deny'];
    }
);

/**
 * Decide one delegation proposal. `never` denies it as it denies every other
 * request kind. Otherwise a scoped proposal bypass approves it, and `yolo` or
 * a run that cannot present one proceeds `unattended`: such a run withholds
 * `requiresApproval` delegation tools up front, so one that still executes
 * was offered for unattended use, and the proposal is a review surface rather
 * than the security gate (the child's bash and edits still gate).
 */
export function decideProposalApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly scopedBypass: boolean;
  readonly canPresent: boolean;
}): 'bypass' | 'unattended' | 'present' | 'deny-policy' {
  if (input.policy === 'never') return 'deny-policy';
  if (input.scopedBypass) return 'bypass';
  return input.policy === 'yolo' || !input.canPresent
    ? 'unattended'
    : 'present';
}

const APPROVAL_YOLO_RETRY_MESSAGE =
  'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.';
const APPROVAL_CREDENTIAL_RETRY_MESSAGE =
  'Retry skipped: credential exhausted or unauthorized.';
const APPROVAL_YOLO_NO_HUMAN_MESSAGE =
  'User question requires human input; yolo mode cannot synthesize an answer.';

export type RetryApprovalDecision =
  | 'present'
  | {
      readonly deny: 'yolo-retry' | 'credential' | 'policy' | 'unpresentable';
    };

/** Decide whether a retry request may prompt or must settle as denied. */
export function decideRetryApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly canPresent: boolean;
  readonly isCredentialFailure: boolean;
}): RetryApprovalDecision {
  if (input.isCredentialFailure) {
    // Ask + interactive can still surface the retry panel; every other case
    // settles with the credential message (including `never` and `yolo`).
    if (input.policy === 'ask' && input.canPresent) return 'present';
    return { deny: 'credential' };
  }
  if (input.policy === 'yolo') return { deny: 'yolo-retry' };
  if (input.policy === 'never') return { deny: 'policy' };
  return input.canPresent ? 'present' : { deny: 'unpresentable' };
}

export function retryDenialMessage(
  deny: Exclude<RetryApprovalDecision, 'present'>['deny'],
): string {
  switch (deny) {
    case 'yolo-retry':
      return APPROVAL_YOLO_RETRY_MESSAGE;
    case 'credential':
      return APPROVAL_CREDENTIAL_RETRY_MESSAGE;
    case 'policy':
      return APPROVAL_POLICY_DENIED_MESSAGE;
    case 'unpresentable':
      return APPROVAL_UNPRESENTABLE_MESSAGE;
  }
}

type HumanInputDecision =
  | 'present'
  | {
      readonly deny: 'yolo-no-human' | 'policy' | 'unpresentable';
    };

/** Decide whether a human-input request may prompt or must settle as denied. */
export function decideHumanInputRequest(input: {
  readonly policy: ApprovalPolicy;
  readonly canPresent: boolean;
}): HumanInputDecision {
  if (input.policy === 'yolo') return { deny: 'yolo-no-human' };
  if (input.policy === 'never') return { deny: 'policy' };
  return input.canPresent ? 'present' : { deny: 'unpresentable' };
}

export function humanInputDenialMessage(
  deny: Exclude<HumanInputDecision, 'present'>['deny'],
): string {
  switch (deny) {
    case 'yolo-no-human':
      return APPROVAL_YOLO_NO_HUMAN_MESSAGE;
    case 'policy':
      return APPROVAL_POLICY_DENIED_MESSAGE;
    case 'unpresentable':
      return APPROVAL_UNPRESENTABLE_MESSAGE;
  }
}
