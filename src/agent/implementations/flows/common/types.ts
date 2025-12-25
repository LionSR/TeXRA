/**
 * Shared result types for PocketFlow nodes.
 *
 * These discriminated unions provide consistent error handling patterns
 * across init nodes and other exec methods.
 */

/**
 * Result type for init node exec methods.
 * Uses 'kind' discriminant for clarity.
 */
export type InitExecResult =
  | { kind: 'success' }
  | { kind: 'error'; error: unknown };

/**
 * Generic result type for exec methods that return a value.
 * Uses 'kind' discriminant for consistency with InitExecResult.
 */
export type NodeExecResult<T> =
  | { kind: 'success'; result: T }
  | { kind: 'error'; error: unknown };
