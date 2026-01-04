// Third-party imports
import * as vscode from 'vscode';

// Type imports
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

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
// Event Module Interfaces
// ============================================================================

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
 * Send update to webview only if stream is active and webview is available.
 * Eliminates repetitive isAvailable/activeStream checks in every handler.
 */
export function sendIfActive(
  stream: string,
  state: ProgressViewState,
  updater: WebviewUpdater,
  send: () => void,
): void {
  if (updater.isAvailable() && stream === state.activeStream) {
    send();
  }
}
