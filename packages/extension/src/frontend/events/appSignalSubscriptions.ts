/**
 * The extension host's run edge for app-signal subscriptions (PRD R1: the
 * fork lives at the host entry, not in the bus). Mirrors
 * `runFactSubscriptions`: one fiber draining the signal's `PubSub`
 * subscription, an unsubscribe that interrupts it, and no other runtime
 * contact. Delivery and failure order belong to `AppSignals` itself.
 */
import { Fiber } from 'effect';

import {
  onAppSignal,
  type AppSignal,
  type AppSignalPayloads,
} from '@eventBus/AppSignals';
import type { ProcessRuntime } from '@platform/processRuntime';

/** Read one app signal from now on. */
export function subscribeAppSignal<K extends AppSignal>(
  signal: K,
  listener: (payload: AppSignalPayloads[K]) => void,
  runtime: ProcessRuntime,
): () => void {
  const fiber = runtime.runFork(onAppSignal(signal, listener));
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
}
