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

/**
 * Sentinel for resumed executions whose persisted parent lineage cannot be
 * trusted. It must never pass the max-depth gate for any supported setting.
 */
export const UNKNOWN_DELEGATION_DEPTH = Number.MAX_SAFE_INTEGER;

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

export type DelegationGateBlockReason = 'max_depth_reached' | 'unknown_depth';

export interface DelegationGateResult {
  depth: number | 'unknown';
  maxDepth: number;
  allowed: boolean;
  blockReason?: DelegationGateBlockReason;
}

/** Explain the delegation gate result without leaking sentinel logic. */
export function evaluateDelegationGate(
  depth: number,
  config: NestedDelegationConfig,
): DelegationGateResult {
  if (depth === UNKNOWN_DELEGATION_DEPTH) {
    return {
      depth: 'unknown',
      maxDepth: config.maxDepth,
      allowed: false,
      blockReason: 'unknown_depth',
    };
  }

  const allowed = depth < config.maxDepth;
  return {
    depth,
    maxDepth: config.maxDepth,
    allowed,
    ...(allowed ? {} : { blockReason: 'max_depth_reached' as const }),
  };
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
  return evaluateDelegationGate(depth, config).allowed;
}
