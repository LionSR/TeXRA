// Types
import { TaskState } from '@logger/TaskState';
import type { TokenUsageStats } from '@agent/types/UsageTypes';
import { LogMessageData } from '@logger/LogTypes';
import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';

/**
 * Interface for ProgressViewProvider implementations.
 * Ensures compatibility between the original and refactored providers.
 */
export interface IProgressViewProvider {
  // Stream management
  getStreamTabs(): Map<string, LogMessageData[]>;
  getTaskGroups(): Map<string, Map<string, any>>;
  setActiveStream(stream: string): void;

  // Stream operations
  eraseStream(stream: string): void;
  deleteAllStreams(): void;
  deleteStream(stream: string): void;

  // Status and files
  getStreamStatus(stream: string): string | undefined;
  getOutputFiles(stream: string): { [key: number]: any[] } | undefined;
  getMissingOutputs(stream: string): { [key: number]: string[] } | undefined;
  getStreamUsage(stream: string): TokenUsageStats | undefined;

  // Task state management
  setTaskState(
    streamTabId: StreamTabId,
    taskState: TaskState,
    options?: { executionId?: ExecutionId },
  ): void;
  getExecutionId(streamTabId: StreamTabId): ExecutionId | undefined;
  getTaskState(streamTabId: StreamTabId): TaskState | undefined;
  clearTaskOutput(streamTabId: StreamTabId): void;

  // Lifecycle
  markAllRunningTasksAsCancelled(): void;
  cleanupTasksAfterRestart(): void;
  isViewVisible(): boolean;

  // Webview operations
  updateLogContent(stream: string): void;
}
