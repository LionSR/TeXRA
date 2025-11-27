/**
 * AgentExecutionServices - Dependency Injection Container for Agent Execution
 *
 * This module defines the service interfaces that agent execution depends on,
 * following PocketFlow's dependency injection pattern via `_params.services`.
 *
 * ## PocketFlow Best Practices Applied:
 *
 * 1. **Explicit Dependencies**: All dependencies declared in interface
 * 2. **Injectable**: Services can be mocked for testing
 * 3. **Single Source of Truth**: Centralized service definitions
 * 4. **No Global Access**: Services passed explicitly, not via getInstance()
 *
 * ## Usage
 *
 * ```typescript
 * // Create services container
 * const services = createAgentExecutionServices(context);
 *
 * // Execute with injected services
 * await executeAgentWithServices(config, services);
 *
 * // Or for testing with mocks
 * const mockServices = {
 *   streamManager: new MockStreamManager(),
 *   modelFactory: mockModelFactory,
 *   // ...
 * };
 * await executeAgentWithServices(config, mockServices);
 * ```
 */

import type { StreamTabId, ExecutionId } from '@agent/types/IdentifierTypes';
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ModelHandler } from '@agent/modelHandlers/ModelHandler';
import type { ModelConfig } from '@model/ModelConfig';
import type { AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import type { TaskState } from '@logger/TaskState';
import type { StreamStatusOrReady } from '@eventBus/ProgressEventBus';
import type { OutputFileInfo } from '@agent/output/types';

// ============================================================================
// MODEL HANDLER FACTORY (replaces static ModelFactory)
// ============================================================================

/**
 * Factory interface for creating model handlers.
 * Replaces the static ModelFactory.createHandler() pattern.
 */
export interface IModelHandlerFactory {
  /**
   * Create a model handler for the given configuration.
   */
  createHandler(config: ModelConfig): ModelHandler;
}

// ============================================================================
// STREAM MANAGEMENT (abstracts StreamStatusService + ProgressViewProvider state)
// ============================================================================

/**
 * Interface for managing stream execution state.
 * Abstracts away the concrete StreamExecutionManager implementation.
 */
export interface IStreamExecutionManager {
  /** Get the current status of a stream */
  getStatus(streamId: StreamTabId): StreamStatusOrReady;

  /** Set the status of a stream */
  setStatus(streamId: StreamTabId, status: StreamStatusOrReady): void;

  /** Check if a stream is currently running */
  isRunning(streamId: StreamTabId): boolean;

  /** Register a shared store for a stream execution */
  registerStore(
    streamId: StreamTabId,
    executionId: ExecutionId,
    store: AgentSharedStore,
  ): void;

  /** Get the shared store for a stream */
  getStoreByStream(streamId: StreamTabId): AgentSharedStore | undefined;

  /** Get output files for resume operation */
  getResumeOutputFiles(
    streamId: StreamTabId,
    executionId: ExecutionId,
  ): { [key: number]: OutputFileInfo[] } | undefined;

  /** Resolve run ID for resume operation */
  resolveResumeRunId(
    streamId: StreamTabId,
    executionId: ExecutionId,
  ): string | undefined;

  /** Clean up all state for a stream */
  cleanup(streamId: StreamTabId): void;
}

// ============================================================================
// UI BRIDGE (abstracts ProgressViewProvider interactions)
// ============================================================================

/**
 * Callback interface for UI operations.
 * Decouples agent execution from direct ProgressViewProvider access.
 */
export interface IAgentUIBridge {
  /** Check if the progress view is visible */
  isViewVisible(): boolean;

  /** Request to show the progress view */
  showProgressView(): Promise<void>;

  /** Emit that a stream is now active */
  emitActiveStream(streamId: StreamTabId, session: AgentSessionDescriptor): void;

  /** Emit task state for a stream */
  emitTaskState(
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
    taskState: TaskState,
  ): void;
}

// ============================================================================
// CONSOLIDATED SERVICES CONTAINER
// ============================================================================

/**
 * All services required for agent execution.
 * This is the single container passed via dependency injection.
 */
export interface AgentExecutionServices {
  /** Stream execution state management */
  readonly streamManager: IStreamExecutionManager;

  /** Model handler creation */
  readonly modelFactory: IModelHandlerFactory;

  /** UI operations bridge (optional for headless execution) */
  readonly uiBridge?: IAgentUIBridge;
}

/**
 * Partial services for optional injection.
 * When not provided, falls back to global singletons (for gradual migration).
 */
export type PartialAgentExecutionServices = Partial<AgentExecutionServices>;

// ============================================================================
// SERVICE CREATION HELPERS
// ============================================================================

/**
 * Create a UI bridge from ProgressViewProvider.
 * This function lives separately to avoid circular imports.
 */
export function createUIBridgeFromProvider(
  getProvider: () =>
    | {
        isViewVisible(): boolean;
        state: {
          getActiveRunId(streamId: StreamTabId): string | undefined;
          getRunOutputFiles(
            streamId: StreamTabId,
            opts: { executionId: ExecutionId; runId: string | undefined },
          ): { [key: number]: OutputFileInfo[] } | undefined;
          resolveRunId(
            streamId: StreamTabId,
            runId: string | undefined,
            opts: { persist: boolean },
          ): string | undefined;
        };
      }
    | undefined,
  executeCommand: (command: string) => Promise<void>,
  emitActiveStream: (streamId: StreamTabId, session: AgentSessionDescriptor) => void,
  emitTaskState: (
    streamId: StreamTabId,
    executionId: ExecutionId | undefined,
    taskState: TaskState,
  ) => void,
): IAgentUIBridge {
  return {
    isViewVisible() {
      return getProvider()?.isViewVisible() ?? false;
    },
    async showProgressView() {
      await executeCommand('texra.showProgressView');
    },
    emitActiveStream,
    emitTaskState,
  };
}
