/**
 * Re-export from canonical location.
 * Moved to @agent/core/executionRequests to fix common→agent dependency violation.
 */
export {
  validateExecutionRequest,
  type ExecutionRequest,
  type ValidatedExecutionRequest,
  type ExecutionValidationResult,
} from '@agent/core/executionRequests';
