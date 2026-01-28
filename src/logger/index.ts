/**
 * Logger module barrel exports.
 *
 * Public API:
 * - AgentLogger: Class for structured logging with group/stage support
 * - logUtils: Low-level logging utilities for standalone use
 * - TaskState types: Type guards for agent category discrimination
 * - UsageLogService: Service for usage analytics
 * - AgentUsageReporter: Bridge for usage stats to log transport
 * - getStreamTabId: Build consistent stream tab identifiers
 */

export { AgentLogger, type AgentLogStage } from './AgentLogger';
export { AgentUsageReporter } from './AgentUsageReporter';
export * as logUtils from './logUtils';
export { getStreamTabId } from './streamUtils';
export {
  isToolUseTaskState,
  isWorkflowTaskState,
  type TaskState,
} from './TaskState';
export { UsageLogService } from './UsageLogService';
