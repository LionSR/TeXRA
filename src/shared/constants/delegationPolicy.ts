/**
 * Delegation depth policy: range constants, clamping, and the pure gate.
 * No VS Code or Node dependencies so it can be imported from both the
 * extension host and the webview bundles. The state read lives in the
 * agent runtime module so this file stays pure.
 *
 * Semantics of `maxDepth`:
 *
 * - Root orchestrator starts at depth 0. Each `delegate_agent` /
 *   `delegate_workflow` call increments the child's depth by 1.
 * - An agent at depth `d` may delegate iff `d < maxDepth`.
 * - Default is 1: only the root may delegate, subagents cannot delegate
 *   further. Raise to 2 to allow one layer of nested delegation
 *   (orchestrator → sub-orchestrator → leaf agent), and so on.
 */

/** Supported range for the max-depth setting and its default. */
export const NESTED_DELEGATION_DEPTH_RANGE = {
  min: 1,
  max: 5,
  default: 1,
} as const;

/** Clamp an arbitrary value to the supported max-depth range. */
export function clampNestedDelegationDepth(value: unknown): number {
  const n =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : NESTED_DELEGATION_DEPTH_RANGE.default;
  return Math.min(
    NESTED_DELEGATION_DEPTH_RANGE.max,
    Math.max(NESTED_DELEGATION_DEPTH_RANGE.min, Math.round(n)),
  );
}

/** Snapshot of delegation policy, read once per tool-use flow entry. */
export interface NestedDelegationConfig {
  maxDepth: number;
}

/**
 * Delegation gate. An agent at depth `d` may delegate iff `d < maxDepth`.
 * Root (depth 0) with the default (maxDepth 1) can always delegate;
 * subagents (depth ≥ 1) can only delegate when the user raises the cap.
 */
export function delegationAllowed(
  depth: number,
  config: NestedDelegationConfig,
): boolean {
  return depth < config.maxDepth;
}
