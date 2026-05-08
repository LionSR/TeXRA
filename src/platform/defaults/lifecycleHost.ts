import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownPhase,
} from '../interfaces/lifecycle';

type Callback = () => void | Promise<void>;

export interface CreateLifecycleHostOptions {
  onError?: (phase: ShutdownPhase, error: unknown) => void;
}

export function createLifecycleHost(
  options: CreateLifecycleHostOptions = {},
): LifecycleHost {
  const handlers: Record<ShutdownPhase, Set<Callback>> = {
    [SHUTDOWN_PHASE.BEFORE]: new Set(),
    [SHUTDOWN_PHASE.ON]: new Set(),
  };
  let shutdownPromise: Promise<void> | undefined;

  const onError =
    options.onError ??
    ((phase, error) => {
      console.error(`[lifecycle] ${phase} handler failed:`, error);
    });

  // Sequential — handlers within a phase run in registration order. Parallel
  // disposal can race (e.g. flushState writing to UsageLogService while it is
  // disposing); the old hand-rolled deactivate() relied on this ordering.
  async function runPhase(phase: ShutdownPhase): Promise<void> {
    const callbacks = [...handlers[phase]];
    handlers[phase].clear();
    for (const cb of callbacks) {
      try {
        await cb();
      } catch (error) {
        onError(phase, error);
      }
    }
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
    runShutdown() {
      // Cache the in-flight promise so concurrent callers (e.g. a second
      // before-quit firing during the first shutdown) await the same drain
      // instead of getting an immediately-resolved noop.
      shutdownPromise ??= (async () => {
        await runPhase(SHUTDOWN_PHASE.BEFORE);
        await runPhase(SHUTDOWN_PHASE.ON);
      })();
      return shutdownPromise;
    },
  };
}
