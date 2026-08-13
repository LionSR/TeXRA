import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownPhase,
} from '../interfaces';

type Callback = () => void | Promise<void>;

/** One `onShutdown` call. Registrations are compared by entry identity, not by
 *  callback identity, so registering the same function twice yields two
 *  independent entries and a Disposable can only remove its own. */
interface Registration {
  readonly callback: Callback;
}

interface CreateLifecycleHostOptions {
  onError?: (phase: ShutdownPhase, error: unknown) => void;
}

export function createLifecycleHost(
  options: CreateLifecycleHostOptions = {},
): LifecycleHost {
  const handlers: Record<ShutdownPhase, Registration[]> = {
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
    const registrations = handlers[phase].splice(0);
    for (const registration of registrations) {
      try {
        await registration.callback();
      } catch (error) {
        onError(phase, error);
      }
    }
  }

  return {
    onShutdown(phase, callback) {
      const registration: Registration = { callback };
      handlers[phase].push(registration);
      return {
        // Idempotent: once this entry is gone (disposed already, or drained by
        // runShutdown) a repeat dispose finds nothing and removes nothing.
        dispose: () => {
          const index = handlers[phase].indexOf(registration);
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
