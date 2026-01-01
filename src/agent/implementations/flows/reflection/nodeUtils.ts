/**
 * Shared utilities for reflection flow nodes.
 *
 * This module provides common patterns for handling graceful degradation
 * in node execution results.
 */

import type { AgentLogger } from '@logger/AgentLogger';

// ============================================================================
// Types
// ============================================================================

/**
 * Result type for operations that support graceful degradation.
 *
 * Use this type for node exec() results where failures should be logged
 * but shouldn't stop the flow. This pattern allows operations to degrade
 * gracefully while continuing execution.
 *
 * @template T - The type of the successful result value
 *
 * @example
 * ```typescript
 * type MediaExecResult = DegradableResult<{ mediaFiles: FileLocation[] }>;
 *
 * async exec(prepRes: PrepInput): Promise<MediaExecResult> {
 *   try {
 *     const files = await extractMedia();
 *     return { kind: 'success', value: { mediaFiles: files } };
 *   } catch (error) {
 *     return {
 *       kind: 'degraded',
 *       value: { mediaFiles: [] },
 *       warning: `Media extraction failed: ${error.message}`
 *     };
 *   }
 * }
 *
 * async post(shared, prepRes, execRes): Promise<string | undefined> {
 *   const result = handleDegradedResult(execRes, this.services.logger);
 *   if (result?.mediaFiles.length > 0) {
 *     // Use the media files
 *   }
 *   return FlowTransition.DEFAULT;
 * }
 * ```
 */
export interface DegradableResult<T> {
  /** Result status: 'success' for normal operation, 'degraded' for partial failure */
  kind: 'success' | 'degraded';
  /** The result value (may be empty/null for degraded results) */
  value: T;
  /** Warning message explaining degradation (required for 'degraded' kind) */
  warning?: string;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Handle a degradable result by logging warnings and extracting the value.
 *
 * This utility provides a standard way to process DegradableResult values:
 * - Logs a warning if the result is degraded
 * - Returns the result value for further processing
 *
 * Use this in node post() methods to handle exec() results that may have
 * degraded gracefully.
 *
 * @template T - The type of the result value
 * @param result - The degradable result to handle
 * @param logger - Logger instance for warning messages
 * @returns The result value (which may be empty/null for degraded results)
 *
 * @example
 * ```typescript
 * async post(
 *   shared: ReflectionFlowShared,
 *   prepRes: PrepInput,
 *   execRes: DegradableResult<{ stats: string | null }>
 * ): Promise<string | undefined> {
 *   const { logger } = this.services;
 *
 *   // Handle degraded result and extract value
 *   const result = handleDegradedResult(execRes, logger);
 *
 *   // Use the value (which may be null if degraded)
 *   if (result.stats) {
 *     modelHandler.prependTextToUserMessage(shared.context.messages, result.stats);
 *   }
 *
 *   return FlowTransition.DEFAULT;
 * }
 * ```
 */
export function handleDegradedResult<T>(
  result: DegradableResult<T>,
  logger: AgentLogger,
): T {
  if (result.kind === 'degraded' && result.warning) {
    logger.warn(result.warning);
  }
  return result.value;
}
