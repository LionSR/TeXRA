/**
 * Canonical error schemas - SINGLE SOURCE OF TRUTH
 *
 * All error-related types in the codebase should derive from these schemas.
 * This file has NO internal project imports to avoid circular dependencies.
 *
 * Schema hierarchy:
 * - ProviderErrorSchema: Core error from provider/SDK (base)
 * - ErrorContextSchema: Where/when the error occurred (composition)
 * - ErrorLogDataSchema: Combined for logging (extends both)
 */

import { z } from 'zod';

// Local imports
import { ProviderErrorSchema } from '@shared/schemas';

// ============================================================================
// Error Context Schema (for composition)
// ============================================================================

/**
 * Context about where/when the error occurred.
 * Separate from error details for clean composition.
 */
export const ErrorContextSchema = z.object({
  /** Operation that failed (e.g., "Model invocation", "Tool-use call") */
  operation: z.string().optional(),
  /** Model being used when error occurred */
  model: z.string().optional(),
});

/** Context about where/when the error occurred */
export type ErrorContext = z.infer<typeof ErrorContextSchema>;

// ============================================================================
// Error Log Data Schema (composed)
// ============================================================================

/**
 * Complete error log data - combines provider error with context.
 * Used for progress view logging via AgentLogger.
 */
export const ErrorLogDataSchema = ProviderErrorSchema.extend({
  /** Operation that failed */
  operation: z.string().optional(),
  /** Model being used */
  model: z.string().optional(),
  /** Original error message before formatting (if different from message) */
  rawMessage: z.string().optional(),
});

/** Complete error data for logging */
export type ErrorLogData = z.infer<typeof ErrorLogDataSchema>;

// ============================================================================
// Partial Schema for Event Bus (optional fields for transport)
// ============================================================================

/**
 * Provider error with all fields optional for event transport.
 * Used when passing error details through the event bus where
 * some fields may not be present.
 */
export const ProviderErrorPartialSchema = ProviderErrorSchema.partial();

/** Provider error with optional fields */
export type ProviderErrorPartial = z.infer<typeof ProviderErrorPartialSchema>;

// Minimal retry error schema now lives in @shared/schemas.
