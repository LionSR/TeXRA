import type { Disposable } from './disposable';

export type ShutdownPhase = 'beforeShutdown' | 'onShutdown';

export interface LifecycleHost {
  onShutdown(
    phase: ShutdownPhase,
    callback: () => void | Promise<void>,
  ): Disposable;
  runShutdown(): Promise<void>;
}
