import { Result, Schema, SchemaGetter } from 'effect';

import type { HookAnswer } from './session/sessionApprovals';

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
  return Result.getOrUndefined(parsed);
}

/**
 * What a request asks, as the policy reads it: a guarded operation (which a
 * grant may answer, with what the call's `PreToolUse` hooks said), a
 * question only a person can answer, or a retry past the automatic
 * attempts (after a credential failure, or not).
 */
export type ApprovalAsk =
  | {
      readonly kind: 'operation';
      readonly granted: boolean;
      readonly hook: HookAnswer;
    }
  | { readonly kind: 'question' }
  | { readonly kind: 'retry'; readonly credentialFailure: boolean };

/** The policy's answer: run unasked, show a person the prompt, or deny with
 *  the reason the request records. */
export type ApprovalDecision =
  | 'allow'
  | 'present'
  | { readonly action: 'deny'; readonly reason: string };

const deny = (reason: string): ApprovalDecision => ({
  action: 'deny',
  reason,
});

/**
 * The one reading of the policy for a request, from what holds at request
 * time. A credential failure's retry can still be shown only by an `ask`
 * session with a prompt. Otherwise `never` denies everything, whatever a hook
 * said. `yolo` or a grant allows an operation no hook routed to a person;
 * `yolo` answers no question or retry on a person's behalf. What is left
 * needs a prompt, which a hook's `allow` answers.
 */
export function decideApproval(input: {
  readonly policy: ApprovalPolicy;
  readonly canPresent: boolean;
  readonly ask: ApprovalAsk;
}): ApprovalDecision {
  const { policy, canPresent, ask } = input;
  if (ask.kind === 'retry' && ask.credentialFailure)
    return policy === 'ask' && canPresent
      ? 'present'
      : deny('Retry skipped: credential exhausted or unauthorized.');
  if (policy === 'never') return deny('Denied by the approval policy.');
  if (policy === 'yolo' || (ask.kind === 'operation' && ask.granted)) {
    if (ask.kind === 'question')
      return deny(
        'User question requires human input; yolo mode cannot synthesize an answer.',
      );
    if (ask.kind === 'retry')
      return deny(
        'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.',
      );
    if (ask.hook !== 'ask') return 'allow';
  }
  if (!canPresent)
    return deny(
      'Interactive approval requires a prompt; this run cannot present one.',
    );
  return ask.kind === 'operation' && ask.hook === 'allow' ? 'allow' : 'present';
}
