import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownPhase,
} from '../interfaces';

type Callback = () => void | Promise<void>;

export interface CreateLifecycleHostOptions {
  onError?: (phase: ShutdownPhase, error: unknown) => void;
}

export function createLifecycleHost(
  options: CreateLifecycleHostOptions = {},
): LifecycleHost {
  // Array (not Set) so that registering the same callback reference twice
  // creates two independent registrations with their own Disposables.
  const handlers: Record<ShutdownPhase, Callback[]> = {
    [SHUTDOWN_PHASE.BEFORE]: [],
    [SHUTDOWN_PHASE.ON]: [],
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
    const callbacks = handlers[phase].splice(0);
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
      handlers[phase].push(callback);
      return {
        dispose: () => {
          const index = handlers[phase].indexOf(callback);
          if (index !== -1) handlers[phase].splice(index, 1);
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
