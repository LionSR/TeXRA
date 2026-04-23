/**
 * Nested-delegation policy: range constants, clamping, and the pure
 * depth gate. No VS Code or Node dependencies so it can be imported
 * from both the extension host and the webview bundles.
 *
 * The state read (`readNestedDelegationConfig`) lives in the agent
 * runtime module so this file stays pure.
 */

/** Supported range for the max-depth setting and its default. */
export const NESTED_DELEGATION_DEPTH_RANGE = {
  min: 1,
  max: 5,
  default: 2,
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

/** Snapshot of nested-delegation settings, read once per tool-use flow entry. */
export interface NestedDelegationConfig {
  enabled: boolean;
  maxDepth: number;
}

/**
 * Delegation gate. Root (depth 0) can always delegate; subagents can only
 * delegate when nesting is enabled and their depth is below the cap.
 */
export function delegationAllowed(
  depth: number,
  config: NestedDelegationConfig,
): boolean {
  if (depth <= 0) return true;
  return config.enabled && depth < config.maxDepth;
}
