// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

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

// ============================================================================
// Event Registration Helpers
// ============================================================================

/**
 * Type for event handlers with state and updater access.
 */
export type StatefulEventHandler<K extends ProgressEvent> = (
  payload: ProgressEventPayloads[K],
  state: ProgressViewState,
  updater: WebviewUpdater,
) => void;

/**
 * Type for simple event handlers (bus only).
 */
export type SimpleEventHandler<K extends ProgressEvent> = (
  payload: ProgressEventPayloads[K],
) => void;

/**
 * Creates a vscode.Disposable from an event bus listener.
 * Reduces boilerplate: `new vscode.Disposable(bus.on(...))` -> `createEventDisposable(...)`
 */
export function createEventDisposable<K extends ProgressEvent>(
  bus: ProgressEventBusLike,
  event: K,
  handler: SimpleEventHandler<K>,
): vscode.Disposable {
  return new vscode.Disposable(bus.on(event, handler));
}

/**
 * Creates a vscode.Disposable from an event bus listener with state/updater access.
 * Reduces boilerplate for stateful event handlers.
 */
export function createStatefulEventDisposable<K extends ProgressEvent>(
  bus: ProgressEventBusLike,
  event: K,
  state: ProgressViewState,
  updater: WebviewUpdater,
  handler: StatefulEventHandler<K>,
): vscode.Disposable {
  return new vscode.Disposable(
    bus.on(event, (payload) => handler(payload, state, updater)),
  );
}

/**
 * Converts an array of unsubscribe functions to Disposables.
 * Simplifies: `[a, b, c].map(d => new vscode.Disposable(d))` -> `toDisposables([a, b, c])`
 */
export function toDisposables(
  unsubscribes: (() => void)[],
): vscode.Disposable[] {
  return unsubscribes.map((unsubscribe) => new vscode.Disposable(unsubscribe));
}

// ============================================================================
// Declarative Event Registration Helpers
// ============================================================================

/**
 * Configuration for a simple event handler (bus only).
 */
export interface SimpleEventConfig<K extends ProgressEvent> {
  event: K;
  errorMessage: string;
  handler: SimpleEventHandler<K>;
}

/**
 * Configuration for a stateful event handler (with state/updater).
 */
export interface StatefulEventConfig<K extends ProgressEvent> {
  event: K;
  errorMessage: string;
  handler: StatefulEventHandler<K>;
}

/**
 * Registers multiple simple event handlers with automatic error boundaries.
 * Reduces boilerplate for EventModuleBase modules.
 *
 * @example
 * return {
 *   register(bus) {
 *     return registerSimpleEvents(bus, withErrorBoundary, [
 *       {
 *         event: 'showRetryRequest',
 *         errorMessage: 'failed to show retry request',
 *         handler: shared.showRetryRequest,
 *       },
 *     ]);
 *   },
 * };
 */
export function registerSimpleEvents(
  bus: ProgressEventBusLike,
  errorBoundary: ErrorBoundaryFn,
  configs: SimpleEventConfig<any>[],
): vscode.Disposable[] {
  return configs.map(({ event, errorMessage, handler }) =>
    createEventDisposable(bus, event, (payload) =>
      errorBoundary(errorMessage, () => handler(payload)),
    ),
  );
}

/**
 * Registers multiple stateful event handlers with automatic error boundaries.
 * Reduces boilerplate for StatefulEventModule modules.
 *
 * @example
 * return {
 *   register(bus, state, updater) {
 *     return registerStatefulEvents(bus, state, updater, withErrorBoundary, [
 *       {
 *         event: 'updateTodos',
 *         errorMessage: 'failed to handle updateTodos',
 *         handler: handleUpdateTodos,
 *       },
 *     ]);
 *   },
 * };
 */
export function registerStatefulEvents(
  bus: ProgressEventBusLike,
  state: ProgressViewState,
  updater: WebviewUpdater,
  errorBoundary: ErrorBoundaryFn,
  configs: StatefulEventConfig<any>[],
): vscode.Disposable[] {
  return configs.map(({ event, errorMessage, handler }) =>
    createStatefulEventDisposable(
      bus,
      event,
      state,
      updater,
      (payload, state, updater) =>
        errorBoundary(errorMessage, () => handler(payload, state, updater)),
    ),
  );
}
