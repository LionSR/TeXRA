/**
 * The extension host's run edge for app-signal subscriptions (PRD R1: the
 * fork lives at the host entry, not in the bus). Mirrors
 * `runFactSubscriptions`: one fiber draining the signal's `PubSub`
 * subscription and an unsubscribe that interrupts it — as a `Disposable`,
 * because every caller hands it straight to `context.subscriptions`.
 * Delivery and failure order belong to `AppSignals` itself.
 */
import { Fiber } from 'effect';

import {
  onAppSignal,
  type AppSignal,
  type AppSignalPayloads,
} from '@eventBus/AppSignals';
import type { ProcessRuntime } from '@platform/processRuntime';
import type * as vscode from 'vscode';

/** Read one app signal from now on. */
export function subscribeAppSignal<K extends AppSignal>(
  runtime: ProcessRuntime,
  signal: K,
  listener: (payload: AppSignalPayloads[K]) => void,
): vscode.Disposable {
  const fiber = runtime.runFork(onAppSignal(signal, listener));
  return {
    dispose: () => {
      runtime.runFork(Fiber.interrupt(fiber));
    },
  };
}
