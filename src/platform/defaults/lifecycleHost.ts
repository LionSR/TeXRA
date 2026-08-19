import { onAbort } from '@utils/core';
import {
  SHUTDOWN_PHASE,
  type LifecycleHost,
  type ShutdownPhase,
} from '../interfaces';

type Callback = (signal: AbortSignal) => void | Promise<void>;

/** One `onShutdown` call. Registrations are compared by entry identity, not by
 *  callback identity, so registering the same function twice yields two
 *  independent entries and a Disposable can only remove its own. */
interface Registration {
  readonly callback: Callback;
}

/**
 * Join-with-deadline bound for one shutdown phase. A hung handler must not
 * wedge desktop quit, eat the extension's ~5s deactivate budget, or stall a
 * CLI SIGTERM indefinitely: at the deadline every handler's abort signal
 * fires, and the drain advances past a handler only after aborting it
 * (abort-then-advance), so a late BEFORE handler cannot race the ON phase's
 * disposals without having been told to stop first.
 */
const SHUTDOWN_PHASE_DEADLINE_MS = 5_000;

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

  // Abort-then-advance: wait for settlement, or for the deadline signal plus
  // one macrotask for the handler to observe its abort and unwind; then report
  // the laggard and advance without waiting further. The laggard keeps running
  // detached; a late rejection still lands in `onError` via `tracked`.
  async function joinWithDeadline(
    phase: ShutdownPhase,
    pending: Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    let settled = false;
    const tracked = pending.then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        onError(phase, error);
      },
    );
    await Promise.race([
      tracked,
      new Promise<void>((resolve) =>
        onAbort(signal, () => setTimeout(resolve, 0)),
      ),
    ]);
    if (!settled) {
      onError(
        phase,
        new Error(
          `Shutdown handler did not settle within ${SHUTDOWN_PHASE_DEADLINE_MS}ms; advancing without it`,
        ),
      );
    }
  }

  // Sequential — handlers within a phase run in registration order. Parallel
  // disposal can race (e.g. flushState writing to UsageLogService while it is
  // disposing); the old hand-rolled deactivate() relied on this ordering.
  async function runPhase(phase: ShutdownPhase): Promise<void> {
    const registrations = handlers[phase].splice(0);
    if (registrations.length === 0) return;
    const deadline = new AbortController();
    // Deliberately not unref'd: this timer is what keeps the process alive to
    // perform the orderly abort when a handler hangs on non-I/O work.
    const timer = setTimeout(
      () => deadline.abort(),
      SHUTDOWN_PHASE_DEADLINE_MS,
    );
    try {
      for (const registration of registrations) {
        try {
          const pending = registration.callback(deadline.signal);
          if (pending) await joinWithDeadline(phase, pending, deadline.signal);
        } catch (error) {
          onError(phase, error);
        }
      }
    } finally {
      clearTimeout(timer);
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
