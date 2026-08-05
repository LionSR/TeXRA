/**
 * Shared bypass-kind vocabulary for per-stream approval grants.
 *
 * Serialized wire values (`bash` | `toolEdit` | `superYolo`) are pinned —
 * rename the TypeScript aliases freely, but do not change these strings.
 * `superYolo` here is the delegated-work scoped bypass, not a TeXRA policy
 * value; the `'proposal'` ancestry key vs `'superYolo'` host-facing label
 * split in `streamApprovalQueue.ts` is intentional.
 */
export const APPROVAL_BYPASS_KINDS = ['bash', 'toolEdit', 'superYolo'] as const;

export type ApprovalBypassKind = (typeof APPROVAL_BYPASS_KINDS)[number];
