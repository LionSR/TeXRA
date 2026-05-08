import type { LifecycleHost, ShutdownPhase } from '../interfaces/lifecycle';

type Callback = () => void | Promise<void>;

export interface CreateLifecycleHostOptions {
  onError?: (phase: ShutdownPhase, error: unknown) => void;
}

export function createLifecycleHost(
  options: CreateLifecycleHostOptions = {},
): LifecycleHost {
  const handlers: Record<ShutdownPhase, Set<Callback>> = {
    beforeShutdown: new Set(),
    onShutdown: new Set(),
  };
  let running = false;

  const onError =
    options.onError ??
    ((phase, error) => {
      console.error(`[lifecycle] ${phase} handler failed:`, error);
    });

  async function runPhase(phase: ShutdownPhase): Promise<void> {
    const callbacks = [...handlers[phase]];
    handlers[phase].clear();
    await Promise.all(
      callbacks.map(async (cb) => {
        try {
          await cb();
        } catch (error) {
          onError(phase, error);
        }
      }),
    );
  }

  return {
    onShutdown(phase, callback) {
      handlers[phase].add(callback);
      return {
        dispose: () => {
          handlers[phase].delete(callback);
        },
      };
    },
    async runShutdown() {
      if (running) return;
      running = true;
      await runPhase('beforeShutdown');
      await runPhase('onShutdown');
    },
  };
}
