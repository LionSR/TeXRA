import { Result, Schema, SchemaGetter } from 'effect';

export const APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export const ApprovalPolicySchema = Schema.Literals(APPROVAL_POLICIES);
export type ApprovalPolicy = typeof ApprovalPolicySchema.Type;
/**
 * The tolerant input form of {@link ApprovalPolicySchema}: the one place
 * a hand-written spelling (` Yolo `) is trimmed and lowercased before the
 * enum. Reached only through {@link parseApprovalPolicy}, which every
 * reader of typed-in text — `TEXRA_APPROVAL_POLICY`, `--approval-policy`,
 * `/approval`, the settings dropdown — calls. Persisted config values keep the
 * strict enum: the `approvalPolicy` catalog row validates the stored
 * value for all three hosts and warns when it no longer parses, and the
 * dropdown's options are derived from that same literal list.
 */
const ApprovalPolicyInputSchema = Schema.String.pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((raw) => raw.trim().toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
  Schema.decodeTo(ApprovalPolicySchema),
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

export function parseApprovalPolicy(input: string): ApprovalPolicy | undefined {
  const parsed = Schema.decodeUnknownResult(ApprovalPolicyInputSchema)(input);
  return Result.isSuccess(parsed) ? parsed.success : undefined;
}

/**
 * A decider's answer for one request: run it unasked, present it to the
 * person, or deny it with the message the person reads (nothing branches
 * on why, so the reason is that message).
 */
export type ApprovalAnswer = 'allow' | 'present' | { readonly deny: string };

const DENIED_BY_POLICY = { deny: 'Denied by the approval policy.' } as const;
/** The denial of a request nobody here can be asked. */
export const UNPRESENTABLE = {
  deny: 'Interactive approval requires a prompt; this run cannot present one.',
} as const;

/** Decide one guarded operation under the policy from request-time facts. */
export function decideApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly scopedBypass: boolean;
  readonly canPresent: boolean;
}): ApprovalAnswer {
  if (input.policy === 'never') return DENIED_BY_POLICY;
  if (input.policy === 'yolo' || input.scopedBypass) return 'allow';
  return input.canPresent ? 'present' : UNPRESENTABLE;
}

/** Decide whether a retry request may prompt or must finish denied. */
export function decideRetryApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly canPresent: boolean;
  readonly isCredentialFailure: boolean;
}): Exclude<ApprovalAnswer, 'allow'> {
  if (input.isCredentialFailure) {
    // Ask + interactive can still surface the retry panel; every other case
    // is denied with the credential message (including `never` and `yolo`).
    if (input.policy === 'ask' && input.canPresent) return 'present';
    return { deny: 'Retry skipped: credential exhausted or unauthorized.' };
  }
  if (input.policy === 'yolo')
    return {
      deny: 'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
    };
  if (input.policy === 'never') return DENIED_BY_POLICY;
  return input.canPresent ? 'present' : UNPRESENTABLE;
}

/** Decide whether a human-input request may prompt or must finish denied. */
export function decideHumanInputRequest(input: {
  readonly policy: ApprovalPolicy;
  readonly canPresent: boolean;
}): Exclude<ApprovalAnswer, 'allow'> {
  if (input.policy === 'yolo')
    return {
      deny: 'User question requires human input; yolo mode cannot synthesize an answer.',
    };
  if (input.policy === 'never') return DENIED_BY_POLICY;
  return input.canPresent ? 'present' : UNPRESENTABLE;
}
