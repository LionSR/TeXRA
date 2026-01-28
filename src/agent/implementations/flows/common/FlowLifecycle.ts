/**
 * FlowLifecycle - Shared lifecycle utilities for flow execution.
 *
 * Consolidates common patterns between reflection and tool-use flows:
 * - Status conversion helpers
 * - Status constants for consistent error handling
 */

import {
  END_GROUP_STATUS,
  EXECUTION_STATUS,
  type EndGroupStatus,
  type ExecutionStatus,
} from '@shared/schemas';
import { executionToEndStatus } from '@common/constants/streamStatus';

// ============================================================================
// Status Conversion
// ============================================================================

/**
 * Convert execution status to end group status.
 * Wraps the common executionToEndStatus call with proper typing.
 */
export function toEndStatus(executionStatus: ExecutionStatus): EndGroupStatus {
  return executionToEndStatus(executionStatus) as EndGroupStatus;
}

/**
 * Determine execution status from interruption check.
 */
export function getExecutionStatus(
  checkInterruption: () => boolean,
): ExecutionStatus {
  return checkInterruption()
    ? EXECUTION_STATUS.INTERRUPTED
    : EXECUTION_STATUS.COMPLETED;
}

// ============================================================================
// Status Constants
// ============================================================================

/** Error status constant for catch blocks. */
export const ERROR_STATUS: EndGroupStatus = END_GROUP_STATUS.ERROR;

/** Default completed status (STOPPED means "completed" in this context). */
export const COMPLETED_STATUS: EndGroupStatus = END_GROUP_STATUS.STOPPED;
