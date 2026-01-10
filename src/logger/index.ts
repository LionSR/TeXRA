/**
 * Logger module barrel exports.
 *
 * Provides a single entry point for all logger-related exports.
 * Consolidates types, schemas, and utilities for cleaner imports.
 */

// Core logger
export {
  AgentLogger,
  type AgentLogStage,
  type AgentLogStream,
  type AgentLogStreamOptions,
  type AgentLoggerStageOptions,
  type LoggerScopeOptions,
  // Context management types
  ContextManagementAction,
  ContextManagementDataSchema,
  type ContextManagementData,
  ContextStateDataSchema,
  type ContextStateData,
} from './AgentLogger';

// Log utility functions (namespace import pattern)
export * as logUtils from './logUtils';

// Message types and schemas
export {
  MESSAGE_TYPES,
  MessageTypeSchema,
  type MessageType,
  END_GROUP_STATUS,
  EndGroupStatusSchema,
  type EndGroupStatus,
  LOG_LEVELS,
  LogLevelSchema,
  FileListEntrySchema,
  type FileListEntry,
} from './messageTypes';

// Log data types
export {
  TaskGroupSchema,
  type TaskGroup,
  LogMessageDataSchema,
  type LogMessageData,
  LogMessageUpdateSchema,
  type LogMessageUpdate,
} from './LogTypes';

// Task state
export {
  TaskStateSchema,
  type TaskState,
  isToolUseTaskState,
  isWorkflowTaskState,
} from './TaskState';

// Usage logging
export { UsageLogService } from './UsageLogService';
export { AgentUsageReporter } from './AgentUsageReporter';
export type {
  UsageLogMetadata,
  UsageLogEntry,
  UsageLogBatch,
} from './UsageLogTypes';

// Filter utilities
export { getEmitFilter, type FilterOptions, type FilterResult } from './filterUtils';

// Stream utilities
export { getStreamTabId } from './streamUtils';

// Options
export type { LogOptions, LogUtilsOptions } from './logOptions';
