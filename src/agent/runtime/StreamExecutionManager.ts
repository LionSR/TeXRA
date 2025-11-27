/**
 * StreamExecutionManager - Single Source of Truth for Stream Execution State
 *
 * This module consolidates stream execution state management following PocketFlow
 * best practices:
 * 1. **Single source of truth**: All stream state lives here
 * 2. **Injectable**: Can be passed as a dependency rather than accessed globally
 * 3. **Lifecycle management**: Proper cleanup and disposal
 * 4. **Event-driven**: Emits changes through the event bus
 *
 * This replaces the scattered state across:
 * - StreamStatusService (status map)
 * - AgentSharedStoreRegistry (store map)
 * - ProgressViewProvider.state (UI state queries from agent)
 *
 * ## Usage
 *
 * ```typescript
 * // Create manager (typically at extension activation)
 * const manager = new StreamExecutionManager();
 *
 * // Inject into agent execution
 * await executeAgentWithServices(config, { streamManager: manager });
 *
 * // Or use the singleton for gradual migration
 * const manager = StreamExecutionManager.getInstance();
 * ```
 */

import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { OutputFileInfo } from '@agent/output/types';
import type { StreamStatusOrReady } from '@eventBus/ProgressEventBus';
import { STATUS } from '@common/constants/streamStatus';
import { bus } from '@eventBus/ProgressEventBus';
import { StreamExecutionIndex } from '@agent/core/StreamExecutionIndex';

/**
 * Execution state for a single stream.
 * Consolidates all state that was previously scattered.
 */
export interface StreamExecutionState {
  /** Current execution status */
  status: StreamStatusOrReady;
  /** Associated shared store (if running) */
  store?: AgentSharedStore;
  /** Execution ID for the current run */
  executionId?: ExecutionId;
  /** Active run ID within the execution */
  activeRunId?: string;
  /** Output files by round (for resume capability) */
  outputsByRound?: Map<number, OutputFileInfo[]>;
}

/**
 * Callback interface for UI updates.
 * This decouples the manager from ProgressViewProvider.
 */
export interface StreamExecutionUICallbacks {
  /** Called when output state is needed for resume */
  getRunOutputFiles?(
    streamId: StreamTabId,
    executionId: ExecutionId,
    runId: string | undefined,
  ): { [key: number]: OutputFileInfo[] } | undefined;

  /** Called to resolve a run ID */
  resolveRunId?(
    streamId: StreamTabId,
    runId: string | undefined,
    executionId: ExecutionId,
  ): string | undefined;

  /** Called to get the active run ID for a stream */
  getActiveRunId?(streamId: StreamTabId): string | undefined;
}

/**
 * Centralized manager for stream execution state.
 * Implements single source of truth pattern from PocketFlow.
 */
export class StreamExecutionManager {
  private static _instance: StreamExecutionManager | undefined;

  private readonly statusMap = new Map<StreamTabId, StreamStatusOrReady>();
  private readonly storeIndex = new StreamExecutionIndex<AgentSharedStore>();
  private readonly executionMap = new Map<StreamTabId, ExecutionId>();
  private uiCallbacks?: StreamExecutionUICallbacks;

  /**
   * Get the singleton instance.
   * Used for gradual migration - prefer dependency injection.
   */
  static getInstance(): StreamExecutionManager {
    if (!this._instance) {
      this._instance = new StreamExecutionManager();
    }
    return this._instance;
  }

  /**
   * Register UI callbacks for operations that need UI state.
   * This allows the manager to access UI state without direct coupling.
   */
  registerUICallbacks(callbacks: StreamExecutionUICallbacks): void {
    this.uiCallbacks = callbacks;
  }

  // ============================================================================
  // STATUS MANAGEMENT (replaces StreamStatusService)
  // ============================================================================

  /**
   * Get the current status of a stream.
   */
  getStatus(streamId: StreamTabId): StreamStatusOrReady {
    return this.statusMap.get(streamId) ?? STATUS.READY;
  }

  /**
   * Set the status of a stream.
   * Emits updateStreamStatus event for UI synchronization.
   */
  setStatus(streamId: StreamTabId, status: StreamStatusOrReady): void {
    if (status === STATUS.READY) {
      this.statusMap.delete(streamId);
    } else {
      this.statusMap.set(streamId, status);
    }
    bus.emit('updateStreamStatus', { stream: streamId, status });
  }

  /**
   * Check if a stream is currently running.
   */
  isRunning(streamId: StreamTabId): boolean {
    return this.getStatus(streamId) === STATUS.RUNNING;
  }

  /**
   * Clear stream status (set to READY).
   */
  clearStatus(streamId: StreamTabId): void {
    this.setStatus(streamId, STATUS.READY);
  }

  // ============================================================================
  // STORE MANAGEMENT (replaces AgentSharedStoreRegistry)
  // ============================================================================

  /**
   * Register a shared store for a stream execution.
   */
  registerStore(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void {
    this.storeIndex.set(streamId, executionId, store);
    this.executionMap.set(streamId, executionId);
  }

  /**
   * Get the shared store for a stream.
   */
  getStoreByStream(streamId: StreamTabId): AgentSharedStore | undefined {
    return this.storeIndex.getByStream(streamId);
  }

  /**
   * Get the shared store for an execution.
   */
  getStoreByExecution(executionId: ExecutionId): AgentSharedStore | undefined {
    return this.storeIndex.getByExecution(executionId);
  }

  /**
   * Unregister store by execution ID.
   */
  unregisterByExecution(executionId: ExecutionId): void {
    this.storeIndex.deleteByExecution(executionId);
  }

  /**
   * Unregister store by stream ID.
   */
  unregisterByStream(streamId: StreamTabId): void {
    this.storeIndex.deleteByStream(streamId);
    this.executionMap.delete(streamId);
  }

  // ============================================================================
  // EXECUTION STATE (consolidates scattered state)
  // ============================================================================

  /**
   * Get the current execution ID for a stream.
   */
  getExecutionId(streamId: StreamTabId): ExecutionId | undefined {
    return this.executionMap.get(streamId);
  }

  /**
   * Get complete execution state for a stream.
   * Useful for serialization/restore operations.
   */
  getExecutionState(streamId: StreamTabId): StreamExecutionState {
    return {
      status: this.getStatus(streamId),
      store: this.getStoreByStream(streamId),
      executionId: this.executionMap.get(streamId),
      activeRunId: this.uiCallbacks?.getActiveRunId?.(streamId),
    };
  }

  // ============================================================================
  // RESUME SUPPORT (decoupled from ProgressViewProvider)
  // ============================================================================

  /**
   * Get output files for resume operation.
   * Uses registered UI callbacks to fetch data without direct coupling.
   */
  getResumeOutputFiles(
    streamId: StreamTabId,
    executionId: ExecutionId,
  ): { [key: number]: OutputFileInfo[] } | undefined {
    if (!this.uiCallbacks?.getRunOutputFiles) {
      return undefined;
    }

    const activeRunId = this.uiCallbacks.getActiveRunId?.(streamId);
    return this.uiCallbacks.getRunOutputFiles(streamId, executionId, activeRunId);
  }

  /**
   * Resolve run ID for resume operation.
   */
  resolveResumeRunId(
    streamId: StreamTabId,
    executionId: ExecutionId,
  ): string | undefined {
    if (!this.uiCallbacks?.resolveRunId) {
      return executionId;
    }

    const activeRunId = this.uiCallbacks.getActiveRunId?.(streamId);
    return this.uiCallbacks.resolveRunId(streamId, activeRunId, executionId) ?? executionId;
  }

  // ============================================================================
  // LIFECYCLE MANAGEMENT
  // ============================================================================

  /**
   * Clean up all state for a stream.
   * Should be called when a stream is completely finished.
   */
  cleanup(streamId: StreamTabId): void {
    this.statusMap.delete(streamId);
    this.storeIndex.deleteByStream(streamId);
    this.executionMap.delete(streamId);
  }

  /**
   * Clear all managed state.
   * Typically called on extension deactivation.
   */
  clear(): void {
    this.statusMap.clear();
    this.storeIndex.clear();
    this.executionMap.clear();
  }

  /**
   * Dispose the manager and clean up resources.
   */
  dispose(): void {
    this.clear();
    this.uiCallbacks = undefined;
    StreamExecutionManager._instance = undefined;
  }
}
