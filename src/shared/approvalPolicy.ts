import { z } from 'zod';

// Local imports
import { warn } from '@logger/logUtils';

export const TEXRA_APPROVAL_POLICIES = ['never', 'ask', 'yolo'] as const;
export const TexraApprovalPolicySchema = z.enum(TEXRA_APPROVAL_POLICIES);
export type TexraApprovalPolicy = z.infer<typeof TexraApprovalPolicySchema>;
export const TEXRA_APPROVAL_POLICY_DEFAULT: TexraApprovalPolicy = 'ask';
/**
 * The policy a `--no-input` run falls back to. Deliberately divergent from
 * {@link TEXRA_APPROVAL_POLICY_DEFAULT}: a run that cannot present a prompt
 * denies instead of hanging, and `buildCliContext` narrows the candidate list
 * to the explicit `--approval-policy` flag alone — a persisted or env-provided
 * `yolo` must not silently auto-approve a headless run that nobody is watching.
 * Changing that requires changing headless discipline, not just this constant.
 */
export const TEXRA_APPROVAL_POLICY_NO_INPUT_DEFAULT: TexraApprovalPolicy =
  'never';
/** Canonical persisted spelling in `.texra/config.json` for every host. */
export const TEXRA_APPROVAL_POLICY_CONFIG_KEY = 'texra.approvalPolicy';
export const TEXRA_APPROVAL_POLICY_DENIED_MESSAGE =
  'Denied by TeXRA approval policy.';
export const TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE =
  'Interactive approval requires a prompt; this run cannot present one.';

const TEXRA_APPROVAL_POLICY_COPY = {
  ask: {
    label: 'Ask',
    description: 'Control Bash and edit prompts independently.',
  },
  never: {
    label: 'Never',
    description: 'Deny Bash commands and tool edits.',
  },
  yolo: {
    label: 'Auto-approve',
    description: 'Allow Bash commands and tool edits without approval.',
  },
} as const satisfies Record<
  TexraApprovalPolicy,
  {
    label: string;
    description: string;
  }
>;

/** Display order for selectors; must stay a permutation of `TEXRA_APPROVAL_POLICIES`. */
export const TEXRA_APPROVAL_POLICY_DISPLAY_ORDER = [
  'ask',
  'never',
  'yolo',
] as const satisfies ReadonlyArray<TexraApprovalPolicy>;

export const TEXRA_APPROVAL_POLICY_OPTIONS = Object.freeze(
  TEXRA_APPROVAL_POLICY_DISPLAY_ORDER.map((value) =>
    Object.freeze({
      value,
      ...TEXRA_APPROVAL_POLICY_COPY[value],
    }),
  ),
);

export function formatTexraApprovalPolicy(policy: TexraApprovalPolicy): string {
  return TEXRA_APPROVAL_POLICY_COPY[policy].description;
}

export function parseTexraApprovalPolicy(
  input: string,
): TexraApprovalPolicy | undefined {
  const parsed = TexraApprovalPolicySchema.safeParse(
    input.trim().toLowerCase(),
  );
  return parsed.success ? parsed.data : undefined;
}

/** Read the persisted TeXRA policy from a config getter (host-neutral). */
export function readPersistedTexraApprovalPolicy(
  get: <T>(key: string, defaultValue: T) => T,
): TexraApprovalPolicy {
  const raw = get<string>(
    TEXRA_APPROVAL_POLICY_CONFIG_KEY,
    TEXRA_APPROVAL_POLICY_DEFAULT,
  );
  if (typeof raw !== 'string') {
    if (raw != null) {
      warn(
        'approval-policy',
        `Ignoring invalid ${TEXRA_APPROVAL_POLICY_CONFIG_KEY} value ${JSON.stringify(raw)}; using "${TEXRA_APPROVAL_POLICY_DEFAULT}".`,
      );
    }
    return TEXRA_APPROVAL_POLICY_DEFAULT;
  }
  const parsed = parseTexraApprovalPolicy(raw);
  if (parsed) return parsed;
  warn(
    'approval-policy',
    `Ignoring invalid ${TEXRA_APPROVAL_POLICY_CONFIG_KEY} "${raw}"; using "${TEXRA_APPROVAL_POLICY_DEFAULT}".`,
  );
  return TEXRA_APPROVAL_POLICY_DEFAULT;
}

export type TexraApprovalPolicyDecision =
  'allow' | 'present' | 'deny-policy' | 'deny-unpresentable';

export function isTexraApprovalDenied(
  decision: TexraApprovalPolicyDecision,
): decision is 'deny-policy' | 'deny-unpresentable' {
  return decision === 'deny-policy' || decision === 'deny-unpresentable';
}

export function texraApprovalDenialMessage(
  decision: 'deny-policy' | 'deny-unpresentable',
): string {
  return decision === 'deny-policy'
    ? TEXRA_APPROVAL_POLICY_DENIED_MESSAGE
    : TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE;
}

/** Decide one Bash or tool-edit permission from request-time policy facts. */
export function decideTexraApproval(input: {
  readonly policy: TexraApprovalPolicy;
  readonly promptRequired: boolean;
  readonly scopedBypass: boolean;
  readonly canPresent: boolean;
}): TexraApprovalPolicyDecision {
  if (input.policy === 'never') return 'deny-policy';
  if (input.policy === 'yolo' || input.scopedBypass || !input.promptRequired) {
    return 'allow';
  }
  return input.canPresent ? 'present' : 'deny-unpresentable';
}

export const TEXRA_APPROVAL_YOLO_RETRY_MESSAGE =
  'Retry skipped: explicit interactive approval is required after automatic attempts are exhausted.';
const TEXRA_APPROVAL_CREDENTIAL_RETRY_MESSAGE =
  'Retry skipped: credential exhausted or unauthorized.';
export const TEXRA_APPROVAL_YOLO_NO_HUMAN_MESSAGE =
  'User question requires human input; yolo mode cannot synthesize an answer.';

export type TexraRetryApprovalDecision =
  | 'present'
  | {
      readonly deny: 'yolo-retry' | 'credential' | 'policy' | 'unpresentable';
    };

/** Decide whether a retry request may prompt or must settle as denied. */
export function decideRetryApproval(input: {
  readonly policy: TexraApprovalPolicy;
  readonly canPresent: boolean;
  readonly isCredentialFailure: boolean;
}): TexraRetryApprovalDecision {
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

export function texraRetryDenialMessage(
  deny: Exclude<TexraRetryApprovalDecision, 'present'>['deny'],
): string {
  switch (deny) {
    case 'yolo-retry':
      return TEXRA_APPROVAL_YOLO_RETRY_MESSAGE;
    case 'credential':
      return TEXRA_APPROVAL_CREDENTIAL_RETRY_MESSAGE;
    case 'policy':
      return TEXRA_APPROVAL_POLICY_DENIED_MESSAGE;
    case 'unpresentable':
      return TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE;
  }
}

export type TexraHumanInputDecision =
  | 'present'
  | {
      readonly deny: 'yolo-no-human' | 'policy' | 'unpresentable';
    };

/** Decide whether a human-input request may prompt or must settle as denied. */
export function decideHumanInputRequest(input: {
  readonly policy: TexraApprovalPolicy;
  readonly canPresent: boolean;
}): TexraHumanInputDecision {
  if (input.policy === 'yolo') return { deny: 'yolo-no-human' };
  if (input.policy === 'never') return { deny: 'policy' };
  return input.canPresent ? 'present' : { deny: 'unpresentable' };
}

export function texraHumanInputDenialMessage(
  deny: Exclude<TexraHumanInputDecision, 'present'>['deny'],
  yoloMessage: string = TEXRA_APPROVAL_YOLO_NO_HUMAN_MESSAGE,
): string {
  switch (deny) {
    case 'yolo-no-human':
      return yoloMessage;
    case 'policy':
      return TEXRA_APPROVAL_POLICY_DENIED_MESSAGE;
    case 'unpresentable':
      return TEXRA_APPROVAL_UNPRESENTABLE_MESSAGE;
  }
}
