// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import type * as vscode from 'vscode';

// Local imports
import type { ErrorBoundaryFn } from './errorHandling';

// ============================================================================
// Event Bus Interface
// ============================================================================

export interface ProgressEventBusLike {
  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void;
  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void;
}

// ============================================================================
// Base Interfaces for Event Modules
// ============================================================================

/**
 * Base shared context for all event modules.
 * Provides pre-configured error boundary - modules don't need to create their own.
 */
export interface BaseEventShared {
  withErrorBoundary: ErrorBoundaryFn;
}

/**
 * Base event module interface for simple event handlers (bus only).
 * Used by modules like ApprovalEvents, RetryEvents that don't need state/updater.
 */
export interface EventModuleBase {
  register(bus: ProgressEventBusLike): vscode.Disposable[];
}

/**
 * Stateful event module interface for handlers needing state and updater.
 * Used by modules like LogEvents, OutputEvents, UsageEvents, etc.
 */
export interface StatefulEventModule {
  register(
    bus: ProgressEventBusLike,
    state: ProgressViewState,
    updater: WebviewUpdater,
  ): vscode.Disposable[];
}
