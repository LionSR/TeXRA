import type { Disposable } from './disposable';

export const SHUTDOWN_PHASE = {
  BEFORE: 'beforeShutdown',
  ON: 'onShutdown',
} as const;

export type ShutdownPhase = (typeof SHUTDOWN_PHASE)[keyof typeof SHUTDOWN_PHASE];

export interface LifecycleHost {
  onShutdown(
    phase: ShutdownPhase,
    callback: () => void | Promise<void>,
  ): Disposable;
  runShutdown(): Promise<void>;
}
