/**
 * Shared result types for flow nodes.
 *
 * Exports:
 * - NodeExecResult: Generic result type for exec methods that return a value
 */

// ============================================================================
// Result Types - Shared discriminated unions for node exec methods
// ============================================================================

/**
 * Generic result type for exec methods that return a value.
 * Uses 'kind' discriminant for clarity.
 */
export type NodeExecResult<T> =
  | { kind: 'success'; result: T }
  | { kind: 'error'; error: unknown };
